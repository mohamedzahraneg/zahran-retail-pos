import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FinancialEngineService } from '../chart-of-accounts/financial-engine.service';

/**
 * One-shot historical reclassification — moves 4 legacy expense rows
 * from DR 529 مصروفات متفرقة to DR 1123 ذمم الموظفين without touching
 * cashbox balances.
 *
 * Context
 *   PR #64 / PR #65 closed the code + category bugs that let employee
 *   payouts land on 529. Four rows booked before those fixes remain
 *   on 529 with NULL employee dimension. This service runs once at
 *   boot and posts a GL-only correction per row via the existing
 *   FinancialEngineService.recordTransaction recipe with
 *   `cash_movements: []` (no cashbox movement — the 945 EGP already
 *   left 1111 correctly; only the debit side migrates).
 *
 * Canonical + auditable
 *   * Uses the engine (no direct journal_entries/journal_lines SQL).
 *   * reference_type = 'expense_reclass_to_1123', reference_id =
 *     expense UUID → engine idempotency replays as { skipped: true }.
 *   * Each correction is a normal balanced JE — reads in reports and
 *     v_employee_gl_balance identically to any other engine-written
 *     entry.
 *
 * After all four targets show up as posted in schema_migrations /
 * journal_entries, this service can be deleted in a follow-up — it
 * idempotently no-ops once the reference_ids are present.
 */
@Injectable()
export class ReclassifyTo1123Service implements OnModuleInit {
  private readonly logger = new Logger('ReclassifyTo1123');

  private readonly targets: ReadonlyArray<{
    expense_no: string;
    recipient_user_id: string;
    recipient_name: string;
  }> = [
    {
      expense_no: 'EXP-2026-000012',
      recipient_user_id: '3157e667-1d6f-4d89-97af-1166dc5a9fe7',
      recipient_name: 'محمد الظباطي',
    },
    {
      expense_no: 'EXP-2026-000013',
      recipient_user_id: '3800f38b-cdb9-4347-bf83-2ffc215efd1f',
      recipient_name: 'ابو يوسف',
    },
    {
      expense_no: 'EXP-2026-000022',
      recipient_user_id: '3800f38b-cdb9-4347-bf83-2ffc215efd1f',
      recipient_name: 'ابو يوسف',
    },
    {
      expense_no: 'EXP-2026-000023',
      recipient_user_id: '3157e667-1d6f-4d89-97af-1166dc5a9fe7',
      recipient_name: 'محمد الظباطي',
    },
  ];

  constructor(
    private readonly ds: DataSource,
    @Optional() private readonly engine?: FinancialEngineService,
  ) {}

  async onModuleInit() {
    if (!this.engine) {
      this.logger.warn('engine not wired — skipping reclassification');
      return;
    }
    for (const t of this.targets) {
      try {
        await this.reclassify(t);
      } catch (err: any) {
        this.logger.error(
          `reclassify ${t.expense_no} failed: ${err?.message ?? err}`,
        );
      }
    }
  }

  private async reclassify(t: {
    expense_no: string;
    recipient_user_id: string;
    recipient_name: string;
  }) {
    const [e] = await this.ds.query(
      `SELECT id, amount, expense_date
         FROM expenses
        WHERE expense_no = $1`,
      [t.expense_no],
    );
    if (!e) {
      this.logger.warn(`${t.expense_no} not found — skip`);
      return;
    }
    const amount = Number(e.amount || 0);
    if (!(amount > 0)) {
      this.logger.warn(`${t.expense_no} amount=${amount} — skip`);
      return;
    }

    const res = await this.engine!.recordTransaction({
      kind: 'manual_adjustment',
      reference_type: 'expense_reclass_to_1123',
      reference_id: e.id,
      entry_date: this.dateOnly(e.expense_date),
      description: `تسوية: تحويل مصروف ${t.expense_no} من 529 إلى 1123 (${t.recipient_name})`,
      gl_lines: [
        {
          account_code: '1123',
          debit: amount,
          employee_user_id: t.recipient_user_id,
        },
        { account_code: '529', credit: amount },
      ],
      cash_movements: [],
      user_id: null,
    });

    if (!res.ok) {
      this.logger.error(
        `${t.expense_no} reclass rejected: ${(res as any).error}`,
      );
      return;
    }
    if ((res as any).skipped) {
      this.logger.log(`${t.expense_no} reclass already posted — no-op`);
      return;
    }
    this.logger.log(
      `${t.expense_no} reclassified ${amount} EGP → 1123 (${t.recipient_name})`,
    );
  }

  private dateOnly(d: any): string | undefined {
    if (!d) return undefined;
    if (typeof d === 'string') return d.slice(0, 10);
    if (d instanceof Date) return d.toISOString().slice(0, 10);
    return undefined;
  }
}
