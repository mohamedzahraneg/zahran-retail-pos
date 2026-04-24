import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FinancialEngineService } from '../chart-of-accounts/financial-engine.service';

/**
 * One-shot opening-balance correction — brings the two employees with
 * legacy activity to the user-confirmed target net GL balance using
 * account 32 الأرباح المحتجزة (Retained Earnings) as the offset.
 *
 * User-confirmed targets (excluding any 2026-04-24 daily wage):
 *   محمد الظباطي (employee_no=2) → +890   (he owes the company 890)
 *   ابو يوسف    (employee_no=3) → −885   (company owes him 885)
 *
 * Pre-flight verified on live (2026-04-24) — no employee_bonuses /
 * _deductions / _settlements / _transactions / expenses(is_advance)
 * row dated today exists for either employee, and no 521/213/1123
 * journal line was posted today. Current v_employee_gl_balance:
 *   محمد الظباطي = +1 840
 *   ابو يوسف    = −1 035
 *
 * Deltas required to reach target:
 *   محمد الظباطي: 890 − 1 840 = −950 (net balance must drop 950)
 *   ابو يوسف:    −885 − (−1 035) = +150 (net balance must rise 150)
 *
 * Accounting rule chosen by the user:
 *   delta > 0  → DR 1123 Employee Receivables / CR 32 Retained Earnings
 *   delta < 0  → DR 32 Retained Earnings       / CR 213 Employee Payables
 *   delta = 0  → no entry
 *
 * Mechanism
 *   Each adjustment posts through FinancialEngineService.recordTransaction
 *   with kind='manual_adjustment' and cash_movements=[] (GL-only; no
 *   cashbox touch). reference_type='employee_ledger_reset_2026_04' +
 *   reference_id=<employee_user_id> gives engine idempotency — every
 *   subsequent boot replays as { skipped: true }.
 *
 * What this service does NOT touch
 *   * cashbox, cashboxes.current_balance, cashbox_transactions
 *   * any historical journal entry or line
 *   * source tables (employee_bonuses / _deductions / _settlements /
 *     _transactions / _requests / expenses)
 *   * FinancialEngine internals
 *   * payroll formulas
 *   * any 2026-04-24 daily wage (none exists on live at deploy time)
 *
 * Follow-up
 *   Once both refs are present in journal_entries, this service can be
 *   deleted in a follow-up PR — engine idempotency makes it a
 *   permanent no-op. Leaving it in for one cycle as an audit
 *   breadcrumb.
 */
@Injectable()
export class EmployeeLedgerReset202604Service implements OnModuleInit {
  private readonly logger = new Logger('EmployeeLedgerReset2026_04');

  private readonly targets: ReadonlyArray<{
    employee_user_id: string;
    employee_name: string;
    delta: number;
  }> = [
    // Al-Zebaty: current +1 840 → target +890 → delta −950 (balance down).
    {
      employee_user_id: '3157e667-1d6f-4d89-97af-1166dc5a9fe7',
      employee_name: 'محمد الظباطي',
      delta: -950,
    },
    // Abu Youssef: current −1 035 → target −885 → delta +150 (balance up).
    {
      employee_user_id: '3800f38b-cdb9-4347-bf83-2ffc215efd1f',
      employee_name: 'ابو يوسف',
      delta: +150,
    },
  ];

  constructor(
    private readonly ds: DataSource,
    @Optional() private readonly engine?: FinancialEngineService,
  ) {}

  async onModuleInit() {
    if (!this.engine) {
      this.logger.warn('engine not wired — skipping ledger reset');
      return;
    }
    for (const t of this.targets) {
      try {
        await this.adjust(t);
      } catch (err: any) {
        this.logger.error(
          `reset ${t.employee_name} failed: ${err?.message ?? err}`,
        );
      }
    }
  }

  private async adjust(t: {
    employee_user_id: string;
    employee_name: string;
    delta: number;
  }) {
    if (t.delta === 0) {
      this.logger.log(`${t.employee_name} delta=0 — no entry`);
      return;
    }
    const amount = Math.abs(t.delta);
    const directionLabel = t.delta > 0 ? 'DR 1123 / CR 32' : 'DR 32 / CR 213';
    const description =
      t.delta > 0
        ? `تسوية افتتاحية: رفع مديونية ${t.employee_name} بمقدار ${amount} ج.م` +
          ` (DR 1123 / CR 32 الأرباح المحتجزة)`
        : `تسوية افتتاحية: خفض مديونية ${t.employee_name} بمقدار ${amount} ج.م` +
          ` (DR 32 الأرباح المحتجزة / CR 213)`;

    const gl_lines =
      t.delta > 0
        ? [
            {
              account_code: '1123',
              debit: amount,
              employee_user_id: t.employee_user_id,
            },
            { account_code: '32', credit: amount },
          ]
        : [
            { account_code: '32', debit: amount },
            {
              account_code: '213',
              credit: amount,
              employee_user_id: t.employee_user_id,
            },
          ];

    const res = await this.engine!.recordTransaction({
      kind: 'manual_adjustment',
      reference_type: 'employee_ledger_reset_2026_04',
      reference_id: t.employee_user_id,
      description,
      gl_lines,
      cash_movements: [],
      user_id: null,
    });

    if (!res.ok) {
      this.logger.error(
        `${t.employee_name} reset rejected: ${(res as any).error}`,
      );
      return;
    }
    if ((res as any).skipped) {
      this.logger.log(`${t.employee_name} reset already posted — no-op`);
      return;
    }
    this.logger.log(
      `${t.employee_name} reset posted ${directionLabel} ${amount} EGP`,
    );
  }
}
