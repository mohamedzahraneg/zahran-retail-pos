import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export type NormalBalance = 'debit' | 'credit';

export interface CreateAccountDto {
  code: string;
  name_ar: string;
  name_en?: string;
  account_type: AccountType;
  normal_balance?: NormalBalance;
  parent_id?: string;
  description?: string;
  cashbox_id?: string;
}

export interface UpdateAccountDto {
  name_ar?: string;
  name_en?: string;
  description?: string;
  is_active?: boolean;
  cashbox_id?: string | null;
  sort_order?: number;
}

/**
 * Read / write the Chart of Accounts tree.
 *
 * Business rules:
 *   - `is_system` accounts can't be renamed's account type changed,
 *     deactivated, or deleted — they're the backbone other modules post
 *     against.
 *   - Accounts that have any journal lines referencing them can't be
 *     deleted either (RESTRICT on the FK enforces this at the DB layer
 *     too, but we surface a friendlier error).
 *   - `normal_balance` is derived from the account_type by default.
 */
@Injectable()
export class ChartOfAccountsService {
  constructor(private readonly ds: DataSource) {}

  /**
   * Full flat list with current balances. The UI builds the tree from
   * parent_id — shipping the flat list is lighter than a recursive CTE
   * and plays well with client-side filtering/search.
   */
  list(includeInactive = false) {
    return this.ds.query(
      `
      SELECT
        a.id, a.code, a.name_ar, a.name_en, a.account_type, a.normal_balance,
        a.parent_id, a.is_leaf, a.is_system, a.is_active, a.description,
        a.level, a.sort_order, a.cashbox_id, cb.name_ar AS cashbox_name,
        COALESCE(b.balance,      0)::numeric(14,2) AS balance,
        COALESCE(b.total_debit,  0)::numeric(14,2) AS total_debit,
        COALESCE(b.total_credit, 0)::numeric(14,2) AS total_credit
      FROM chart_of_accounts a
      LEFT JOIN v_account_balances b ON b.account_id = a.id
      LEFT JOIN cashboxes cb         ON cb.id = a.cashbox_id
      ${includeInactive ? '' : 'WHERE a.is_active = TRUE'}
      ORDER BY a.code
      `,
    );
  }

  async get(id: string) {
    const [row] = await this.ds.query(
      `
      SELECT a.*, COALESCE(b.balance, 0)::numeric(14,2) AS balance,
             COALESCE(b.total_debit,  0)::numeric(14,2) AS total_debit,
             COALESCE(b.total_credit, 0)::numeric(14,2) AS total_credit,
             p.code AS parent_code, p.name_ar AS parent_name,
             cb.name_ar AS cashbox_name
      FROM chart_of_accounts a
      LEFT JOIN v_account_balances b ON b.account_id = a.id
      LEFT JOIN chart_of_accounts p  ON p.id = a.parent_id
      LEFT JOIN cashboxes cb         ON cb.id = a.cashbox_id
      WHERE a.id = $1
      `,
      [id],
    );
    if (!row) throw new NotFoundException('الحساب غير موجود');
    return row;
  }

  async create(dto: CreateAccountDto, userId: string) {
    if (!dto.code?.trim()) throw new BadRequestException('كود الحساب مطلوب');
    if (!dto.name_ar?.trim())
      throw new BadRequestException('الاسم بالعربية مطلوب');

    const normalBalance =
      dto.normal_balance ?? this.defaultNormalBalance(dto.account_type);

    // Compute level from parent (+1) so tree queries can filter by depth.
    let level = 1;
    if (dto.parent_id) {
      const [parent] = await this.ds.query(
        `SELECT level, account_type FROM chart_of_accounts WHERE id = $1`,
        [dto.parent_id],
      );
      if (!parent) throw new NotFoundException('الحساب الأب غير موجود');
      if (parent.account_type !== dto.account_type) {
        throw new BadRequestException(
          'نوع الحساب يجب أن يطابق نوع الحساب الأب',
        );
      }
      level = Number(parent.level) + 1;
    }

    const [row] = await this.ds.query(
      `
      INSERT INTO chart_of_accounts
        (code, name_ar, name_en, account_type, normal_balance, parent_id,
         description, level, created_by, cashbox_id)
      VALUES ($1,$2,$3,$4::account_type,$5::normal_balance,$6,$7,$8,$9,$10)
      RETURNING *
      `,
      [
        dto.code.trim(),
        dto.name_ar.trim(),
        dto.name_en?.trim() ?? null,
        dto.account_type,
        normalBalance,
        dto.parent_id ?? null,
        dto.description ?? null,
        level,
        userId,
        dto.cashbox_id ?? null,
      ],
    );
    return row;
  }

  async update(id: string, dto: UpdateAccountDto) {
    const [existing] = await this.ds.query(
      `SELECT is_system FROM chart_of_accounts WHERE id = $1`,
      [id],
    );
    if (!existing) throw new NotFoundException('الحساب غير موجود');

    // System accounts allow safe cosmetic edits (cashbox link / sort_order
    // / name_en / description) but NOT rename or deactivation.
    if (existing.is_system) {
      if (dto.is_active === false) {
        throw new BadRequestException(
          'لا يمكن تعطيل الحسابات النظامية',
        );
      }
    }

    const sets: string[] = [];
    const args: any[] = [];
    const push = (col: string, val: any) => {
      args.push(val);
      sets.push(`${col} = $${args.length}`);
    };
    if (dto.name_ar !== undefined && !existing.is_system)
      push('name_ar', dto.name_ar);
    if (dto.name_en !== undefined) push('name_en', dto.name_en);
    if (dto.description !== undefined) push('description', dto.description);
    if (dto.is_active !== undefined && !existing.is_system)
      push('is_active', dto.is_active);
    if (dto.cashbox_id !== undefined) push('cashbox_id', dto.cashbox_id);
    if (dto.sort_order !== undefined) push('sort_order', dto.sort_order);

    if (!sets.length) {
      return this.get(id);
    }
    sets.push(`updated_at = NOW()`);
    args.push(id);
    const [row] = await this.ds.query(
      `UPDATE chart_of_accounts SET ${sets.join(', ')} WHERE id = $${args.length} RETURNING *`,
      args,
    );
    return row;
  }

  async remove(id: string) {
    const [row] = await this.ds.query(
      `SELECT is_system FROM chart_of_accounts WHERE id = $1`,
      [id],
    );
    if (!row) throw new NotFoundException('الحساب غير موجود');
    if (row.is_system)
      throw new BadRequestException('لا يمكن حذف الحسابات النظامية');

    // Reject deletion if posted journal lines reference this account.
    const [{ used }] = await this.ds.query(
      `SELECT COUNT(*)::int AS used FROM journal_lines WHERE account_id = $1`,
      [id],
    );
    if (used > 0) {
      throw new BadRequestException(
        `لا يمكن حذف حساب له حركات (عدد الحركات: ${used}). يمكن تعطيله بدلاً من حذفه.`,
      );
    }

    // Reject if it has children.
    const [{ kids }] = await this.ds.query(
      `SELECT COUNT(*)::int AS kids FROM chart_of_accounts WHERE parent_id = $1`,
      [id],
    );
    if (kids > 0) {
      throw new BadRequestException(
        `لا يمكن حذف حساب له حسابات فرعية (${kids}).`,
      );
    }

    await this.ds.query(`DELETE FROM chart_of_accounts WHERE id = $1`, [id]);
    return { deleted: true };
  }

  /** Trial-balance snapshot (one row per leaf account). */
  async trialBalance() {
    return this.ds.query(`
      SELECT a.id, a.code, a.name_ar, a.account_type, a.normal_balance,
             COALESCE(b.total_debit,  0)::numeric(14,2) AS total_debit,
             COALESCE(b.total_credit, 0)::numeric(14,2) AS total_credit,
             COALESCE(b.balance,      0)::numeric(14,2) AS balance
        FROM chart_of_accounts a
        LEFT JOIN v_account_balances b ON b.account_id = a.id
       WHERE a.is_active = TRUE
         AND a.is_leaf   = TRUE
       ORDER BY a.code
    `);
  }

  private defaultNormalBalance(t: AccountType): NormalBalance {
    return t === 'asset' || t === 'expense' ? 'debit' : 'credit';
  }
}
