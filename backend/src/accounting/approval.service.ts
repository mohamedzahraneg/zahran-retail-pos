import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FinancialEngineService } from '../chart-of-accounts/financial-engine.service';

export interface CreateRuleDto {
  name_ar: string;
  min_amount: number;
  max_amount?: number | null;
  required_role: string;
  level: number;
  notes?: string;
}

/**
 * Multi-level expense approval engine.
 *
 * A rule says: "expenses between X and Y need approval from a role Z at
 * level N". On expense creation, ApprovalService matches all rules
 * whose (min_amount..max_amount) bracket contains the expense and
 * writes one pending row per matched rule. The user sees pending rows
 * in their role's inbox and decides.
 *
 * An expense is auto-flipped to is_approved = TRUE only when every
 * pending row has status = 'approved'. A single rejection halts it.
 */
@Injectable()
export class ExpenseApprovalService {
  constructor(
    private readonly ds: DataSource,
    @Optional() private readonly engine?: FinancialEngineService,
  ) {}

  // ── Rule management ────────────────────────────────────────────────

  async listRules() {
    const [exists] = await this.ds.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables
        WHERE table_name='expense_approval_rules') AS present`,
    );
    if (!exists?.present) return [];
    return this.ds.query(
      `SELECT * FROM expense_approval_rules ORDER BY is_active DESC, level, min_amount`,
    );
  }

  async createRule(dto: CreateRuleDto) {
    if (!dto.name_ar?.trim()) throw new BadRequestException('الاسم مطلوب');
    if (!(dto.min_amount >= 0))
      throw new BadRequestException('الحد الأدنى ≥ 0');
    if (dto.max_amount != null && dto.max_amount <= dto.min_amount) {
      throw new BadRequestException(
        'الحد الأقصى يجب أن يكون أكبر من الحد الأدنى',
      );
    }
    const [row] = await this.ds.query(
      `INSERT INTO expense_approval_rules
         (name_ar, min_amount, max_amount, required_role, level, notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        dto.name_ar.trim(),
        dto.min_amount,
        dto.max_amount ?? null,
        dto.required_role,
        dto.level,
        dto.notes ?? null,
      ],
    );
    return row;
  }

  async updateRule(
    id: string,
    dto: Partial<CreateRuleDto> & { is_active?: boolean },
  ) {
    const sets: string[] = [];
    const args: any[] = [];
    const push = (col: string, val: any) => {
      args.push(val);
      sets.push(`${col} = $${args.length}`);
    };
    if (dto.name_ar !== undefined) push('name_ar', dto.name_ar);
    if (dto.min_amount !== undefined) push('min_amount', dto.min_amount);
    if (dto.max_amount !== undefined) push('max_amount', dto.max_amount);
    if (dto.required_role !== undefined)
      push('required_role', dto.required_role);
    if (dto.level !== undefined) push('level', dto.level);
    if (dto.notes !== undefined) push('notes', dto.notes);
    if (dto.is_active !== undefined) push('is_active', dto.is_active);
    if (!sets.length) {
      const [row] = await this.ds.query(
        `SELECT * FROM expense_approval_rules WHERE id = $1`,
        [id],
      );
      return row;
    }
    sets.push('updated_at = NOW()');
    args.push(id);
    const [row] = await this.ds.query(
      `UPDATE expense_approval_rules SET ${sets.join(', ')}
        WHERE id = $${args.length} RETURNING *`,
      args,
    );
    if (!row) throw new NotFoundException('القاعدة غير موجودة');
    return row;
  }

  async removeRule(id: string) {
    const [{ used }] = await this.ds.query(
      `SELECT COUNT(*)::int AS used FROM expense_approvals WHERE rule_id = $1`,
      [id],
    );
    if (used > 0) {
      await this.ds.query(
        `UPDATE expense_approval_rules SET is_active = FALSE, updated_at = NOW()
          WHERE id = $1`,
        [id],
      );
      return { soft_deleted: true, reason: 'has_approvals' };
    }
    await this.ds.query(
      `DELETE FROM expense_approval_rules WHERE id = $1`,
      [id],
    );
    return { deleted: true };
  }

  // ── Workflow engine ────────────────────────────────────────────────

  /**
   * Spawn pending approval rows for every rule whose bracket covers
   * the expense. Returns false if no rules apply (caller can auto-
   * approve then).
   */
  async spawnForExpense(
    expenseId: string,
    amount: number,
    em?: { query: any },
  ): Promise<{ spawned: number; rules: any[] }> {
    const q = em ? em.query.bind(em) : this.ds.query.bind(this.ds);
    const rules = await q(
      `SELECT id, required_role, level, name_ar
         FROM expense_approval_rules
        WHERE is_active = TRUE
          AND $1::numeric >= min_amount
          AND (max_amount IS NULL OR $1::numeric <= max_amount)
        ORDER BY level`,
      [Number(amount)],
    );
    if (!rules.length) return { spawned: 0, rules: [] };
    for (const r of rules) {
      await q(
        `INSERT INTO expense_approvals
           (expense_id, rule_id, level, required_role, status)
         VALUES ($1, $2, $3, $4, 'pending')`,
        [expenseId, r.id, r.level, r.required_role],
      );
    }
    return { spawned: rules.length, rules };
  }

  /** Inbox for a specific user — respects their role. */
  async inboxFor(userId: string) {
    const [exists] = await this.ds.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables
        WHERE table_name='expense_approvals') AS present`,
    );
    if (!exists?.present) return [];
    // Load user role(s)
    const [user] = await this.ds.query(
      `SELECT u.id, r.code AS role FROM users u
         JOIN roles r ON r.id = u.role_id
        WHERE u.id = $1`,
      [userId],
    );
    if (!user) return [];
    const roles = user.role === 'admin' ? ['admin'] : [user.role];
    return this.ds.query(
      `
      SELECT a.id, a.expense_id, a.level, a.required_role, a.status,
             a.created_at,
             e.expense_no, e.amount, e.expense_date, e.description,
             e.vendor_name, e.payment_method,
             ec.name_ar AS category_name, ec.code AS category_code,
             w.name_ar AS warehouse_name,
             cu.full_name AS created_by_name,
             r.name_ar AS rule_name
        FROM expense_approvals a
        JOIN expenses e ON e.id = a.expense_id
        LEFT JOIN expense_categories ec ON ec.id = e.category_id
        LEFT JOIN warehouses w ON w.id = e.warehouse_id
        LEFT JOIN users cu ON cu.id = e.created_by
        LEFT JOIN expense_approval_rules r ON r.id = a.rule_id
       WHERE a.status = 'pending'
         AND (a.required_role = ANY($1::text[]) OR 'admin' = ANY($1::text[]))
       ORDER BY a.created_at ASC
      `,
      [roles],
    );
  }

  async approve(approvalId: string, userId: string, note?: string) {
    return this.decide(approvalId, userId, 'approved', note);
  }

  async reject(approvalId: string, userId: string, reason: string) {
    if (!reason?.trim())
      throw new BadRequestException('سبب الرفض مطلوب');
    return this.decide(approvalId, userId, 'rejected', reason);
  }

  private async decide(
    approvalId: string,
    userId: string,
    status: 'approved' | 'rejected',
    reason?: string,
  ) {
    return this.ds.transaction(async (em) => {
      const [a] = await em.query(
        `SELECT * FROM expense_approvals WHERE id = $1 FOR UPDATE`,
        [approvalId],
      );
      if (!a) throw new NotFoundException('الاعتماد غير موجود');
      if (a.status !== 'pending') {
        throw new BadRequestException('تم البت في هذا الاعتماد بالفعل');
      }
      await em.query(
        `UPDATE expense_approvals
            SET status = $2, decided_by = $3, decided_at = NOW(), reason = $4
          WHERE id = $1`,
        [approvalId, status, userId, reason ?? null],
      );

      // If all approvals of this expense are now approved → flip expense.
      const summary = await em.query(
        `SELECT status, COUNT(*)::int AS n FROM expense_approvals
          WHERE expense_id = $1 GROUP BY status`,
        [a.expense_id],
      );
      const pending =
        summary.find((s: any) => s.status === 'pending')?.n ?? 0;
      const rejected =
        summary.find((s: any) => s.status === 'rejected')?.n ?? 0;
      if (rejected > 0) {
        // At least one rejection → mark expense rejected (not approved).
        await em.query(
          `UPDATE expenses
              SET is_approved = FALSE, rejected_reason = $2, updated_at = NOW()
            WHERE id = $1`,
          [a.expense_id, reason || 'رفض اعتماد متعدد المستويات'],
        );
      } else if (pending === 0) {
        // ━━━ All levels approved — now move the money ━━━
        // The previous implementation just flipped is_approved=TRUE and
        // walked away, leaving the expense with NO cashbox movement and
        // NO journal entry (user symptom: "تم ترحيل 0 مصروف despite N").
        // We now flip the flag AND route through the engine so cash +
        // GL both happen atomically with this decision.
        await em.query(
          `UPDATE expenses
              SET is_approved = TRUE, approved_by = $2, updated_at = NOW()
            WHERE id = $1`,
          [a.expense_id, userId],
        );

        // Fetch the fresh expense row + category account link so the
        // engine has everything it needs.
        const [exp] = await em.query(
          `SELECT e.*, ec.account_id AS category_account_id
             FROM expenses e
             LEFT JOIN expense_categories ec ON ec.id = e.category_id
            WHERE e.id = $1`,
          [a.expense_id],
        );

        if (exp && this.engine) {
          const res = await this.engine.recordExpense({
            expense_id: exp.id,
            expense_no: exp.expense_no,
            amount: Number(exp.amount),
            category_account_id: exp.category_account_id ?? null,
            cashbox_id: exp.cashbox_id,
            payment_method: exp.payment_method,
            user_id: userId,
            entry_date: exp.expense_date ?? undefined,
            em,
            description: exp.description ?? undefined,
          });
          if (!res.ok) {
            // Structured failure — roll back the approval by throwing.
            // Better the approver sees an error than we silently skip
            // the posting and leave another orphan.
            throw new BadRequestException(
              `تم رفض الاعتماد لأن ترحيل المصروف فشل: ${res.error}`,
            );
          }
        }
      }
      return {
        status,
        remaining_pending: pending,
        expense_id: a.expense_id,
      };
    });
  }

  /** Approvals history for a single expense (for the detail view). */
  listForExpense(expenseId: string) {
    return this.ds.query(
      `
      SELECT a.*, r.name_ar AS rule_name,
             u.full_name AS decided_by_name
        FROM expense_approvals a
        LEFT JOIN expense_approval_rules r ON r.id = a.rule_id
        LEFT JOIN users u ON u.id = a.decided_by
       WHERE a.expense_id = $1
       ORDER BY a.level ASC, a.created_at ASC
      `,
      [expenseId],
    );
  }
}
