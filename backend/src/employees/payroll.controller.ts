import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';
import {
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
} from 'class-validator';
import { Permissions, Roles } from '../common/decorators/roles.decorator';
import { ForbiddenException } from '@nestjs/common';
import {
  CurrentUser,
  JwtUser,
} from '../common/decorators/current-user.decorator';
import { EmployeesService } from './employees.service';

/**
 * Payroll / Employee Accounts surface.
 *
 * Reads the pre-existing `employee_transactions` table (already on
 * prod — types: wage/bonus/deduction/expense/advance/payout) and
 * joins it against `chart_of_accounts` account 1123 (ذمم الموظفين)
 * which is the canonical GL home for employee-related amounts.
 *
 * Writes delegate to the existing `trg_employee_txn_post` trigger,
 * which auto-posts the matching GL entry on INSERT/DELETE — so this
 * controller is a thin CRUD shell; no accounting logic here.
 *
 * Endpoints match the contract already compiled into the deployed
 * frontend bundle:
 *   GET    /payroll                      — list transactions
 *   GET    /payroll/balances             — per-employee rollup
 *   GET    /payroll/employee/:id         — one employee detail
 *   POST   /payroll                      — create (trigger auto-posts GL)
 *   PATCH  /payroll/:id                  — update narrative fields only
 *   DELETE /payroll/:id                  — delete (trigger reverses GL)
 */
class CreatePayrollDto {
  @IsUUID() employee_id!: string;
  @IsDateString() @IsOptional() txn_date?: string;
  // 'expense' removed (PR #69) and 'advance' removed in this PR.
  // Canonical advance path is expenses.is_advance=TRUE via POST
  // /accounting/expenses{,/daily} — it's the only path that routes
  // through FinancialEngine and writes both journal_lines AND
  // cashbox_transactions. fn_post_employee_txn's advance branch
  // writes journal_lines only, so repeat use would drift
  // cashboxes.current_balance from SUM(cashbox_transactions).
  // Disabling this write-surface also closes the triple-path
  // dual-write risk (audit #4): same advance could have been
  // recorded via expenses + employee_requests + payroll, each
  // independently posting DR 1123 / CR 1111. Historical reads
  // continue to work — the payroll union query synthesises
  // type='advance' rows from expenses.is_advance=TRUE for display.
  // `wage` is accepted at the DTO boundary so existing callers get a
  // 400 with a clear redirect message (below in `create()`). Daily
  // wage is now driven by the attendance / payable-day workflow
  // (migration 082–083, PR #88): POST /attendance/admin/mark-payable-day.
  // Payout of a wage uses POST /employees/:id/pay-wage (PR-1).
  @IsIn(['wage', 'bonus', 'deduction', 'payout'])
  type!: 'wage' | 'bonus' | 'deduction' | 'payout';
  @IsNumber() @IsPositive() amount!: number;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsUUID() cashbox_id?: string;
  @IsOptional() @IsUUID() shift_id?: string;
}

class UpdatePayrollDto {
  @IsOptional() @IsString() description?: string;
}

@ApiBearerAuth()
@ApiTags('payroll')
@Controller('payroll')
export class PayrollController {
  constructor(
    private readonly ds: DataSource,
    // Delegate writes to the canonical business-event services. The
    // user-facing Payroll modal posts here, but the actual row lands
    // in the correct source table (employee_bonuses / _deductions /
    // _settlements) via these methods — no direct insert into
    // employee_transactions for events that already have a canonical
    // table. See `create()` below for the full dispatch table.
    private readonly empSvc: EmployeesService,
  ) {}

  /**
   * Per-employee balances. Frontend expects at minimum:
   *   { employee_id, employee_name, outstanding, balance, ... }
   *
   * Computes from employee_transactions. Signs follow the frontend's
   * contract:  wage/bonus/expense  = credit (company owes)
   *            deduction/advance/payout = debit (employee owes)
   * The difference is the running ledger `balance` (positive = we
   * owe the employee, negative = employee owes us).
   *
   * `outstanding` is the net AR from the employee's side (how much
   * they owe) — zero-floored so it matches the typical business use
   * (no negative AR; if the sign flips, `balance` captures it).
   */
  @Get('balances')
  @Permissions('employee.team.view')
  @ApiOperation({ summary: 'أرصدة الموظفين الحية مرتبطة بحساب 1123' })
  async balances() {
    // Primary source of truth: v_employee_gl_balance (migration 071),
    // which aggregates journal_lines tagged with employee_user_id on
    // account 1123. Legacy source tables are joined as a fallback so
    // employees whose historical activity isn't GL-tagged still show
    // a balance. The going-forward goal: every row here matches
    // `gl_balance` — divergence (`gl_vs_source_diff`) flags drift
    // that the engine hasn't caught up with.
    return this.ds.query(
      `
      WITH rollup AS (
        SELECT
          u.id                                              AS employee_id,
          u.username,
          u.full_name,
          COALESCE(u.full_name, u.username)                 AS employee_name,
          u.employee_no,
          u.job_title,
          u.salary_amount,
          u.salary_frequency,
          -- UNION two sources: the new employee_transactions table AND
          -- the pre-existing employee_deductions / _settlements /
          -- _bonuses / advance-expenses (all surfaced by
          -- v_employee_ledger). Employees without employee_transactions
          -- rows still show their real balances from the ledger tables.
          (
            COALESCE((SELECT SUM(amount) FROM employee_transactions t
                       WHERE t.employee_id = u.id AND t.type='wage'), 0)
          )::numeric(14,2) AS wages,
          (
            COALESCE((SELECT SUM(amount) FROM employee_transactions t
                       WHERE t.employee_id = u.id AND t.type='bonus'), 0)
            + COALESCE((SELECT SUM(amount) FROM employee_bonuses b
                         WHERE b.user_id = u.id), 0)
          )::numeric(14,2) AS bonuses,
          (
            COALESCE((SELECT SUM(amount) FROM employee_transactions t
                       WHERE t.employee_id = u.id AND t.type='deduction'), 0)
            + COALESCE((SELECT SUM(amount) FROM employee_deductions d
                         WHERE d.user_id = u.id), 0)
          )::numeric(14,2) AS deductions,
          (
            COALESCE((SELECT SUM(amount) FROM employee_transactions t
                       WHERE t.employee_id = u.id AND t.type='expense'), 0)
          )::numeric(14,2) AS expenses,
          (
            COALESCE((SELECT SUM(amount) FROM employee_transactions t
                       WHERE t.employee_id = u.id AND t.type='advance'), 0)
            + COALESCE((SELECT SUM(amount) FROM expenses e
                         WHERE e.employee_user_id = u.id AND e.is_advance = TRUE), 0)
          )::numeric(14,2) AS advances,
          (
            COALESCE((SELECT SUM(amount) FROM employee_transactions t
                       WHERE t.employee_id = u.id AND t.type='payout'), 0)
            + COALESCE((SELECT SUM(amount) FROM employee_settlements s
                         WHERE s.user_id = u.id), 0)
          )::numeric(14,2) AS payouts,
          GREATEST(
            (SELECT MAX(txn_date) FROM employee_transactions WHERE employee_id = u.id),
            (SELECT MAX(deduction_date) FROM employee_deductions WHERE user_id = u.id),
            (SELECT MAX(bonus_date) FROM employee_bonuses WHERE user_id = u.id),
            (SELECT MAX(settlement_date) FROM employee_settlements WHERE user_id = u.id),
            (SELECT MAX(expense_date) FROM expenses WHERE employee_user_id = u.id AND is_advance)
          ) AS last_txn_date
        FROM users u
        WHERE u.is_active = TRUE
      ),
      coa AS (
        SELECT id AS account_id, code, name_ar, name_en
          FROM chart_of_accounts
         WHERE code = '1123'   -- ذمم الموظفين — the canonical GL home
         LIMIT 1
      ),
      -- GL-based balance: post-migration-071 rows are tagged with
      -- employee_user_id on account 1123. This is the canonical
      -- single source of truth. Employees with no tagged lines
      -- show NULL here and the UI falls back on the rollup.
      gl AS (
        SELECT employee_user_id, balance, debit_total, credit_total,
               entry_count, last_entry_date
          FROM v_employee_gl_balance
      )
      SELECT
        r.employee_id,
        r.employee_name,
        r.full_name,
        r.username,
        r.employee_no,
        r.job_title,
        r.salary_amount::numeric(14,2),
        r.salary_frequency,
        r.wages,
        r.bonuses,
        r.deductions,
        r.expenses,
        r.advances,
        r.payouts,
        -- Company's obligation side (what we owe the employee)
        (r.wages + r.bonuses + r.expenses)::numeric(14,2)          AS liabilities,
        -- Employee's obligation side (what they owe us)
        (r.deductions + r.advances + r.payouts)::numeric(14,2)     AS receivables,
        -- Signed net balance (positive = company owes; negative = employee owes)
        ((r.wages + r.bonuses + r.expenses)
         - (r.deductions + r.advances + r.payouts))::numeric(14,2) AS net_balance,
        -- Back-compat alias used elsewhere
        ((r.wages + r.bonuses + r.expenses)
         - (r.deductions + r.advances + r.payouts))::numeric(14,2) AS balance,
        GREATEST(0, ((r.deductions + r.advances + r.payouts)
                     - (r.wages + r.bonuses + r.expenses)))::numeric(14,2) AS outstanding,
        -- Cross-source transaction count (drives the UI "X حركة" stat)
        (
          COALESCE((SELECT COUNT(*) FROM employee_transactions t WHERE t.employee_id = r.employee_id), 0) +
          COALESCE((SELECT COUNT(*) FROM employee_deductions d WHERE d.user_id = r.employee_id), 0) +
          COALESCE((SELECT COUNT(*) FROM employee_bonuses b    WHERE b.user_id = r.employee_id), 0) +
          COALESCE((SELECT COUNT(*) FROM employee_settlements s WHERE s.user_id = r.employee_id), 0) +
          COALESCE((SELECT COUNT(*) FROM expenses e WHERE e.employee_user_id = r.employee_id AND e.is_advance), 0)
        )::int AS txn_count,
        r.last_txn_date,
        -- COA link — every employee balance lives under 1123
        coa.code     AS coa_account_code,
        coa.name_ar  AS coa_account_name_ar,
        -- GL-first fields (migration 071). Single source of truth for
        -- post-migration activity. NULL-safe for historic employees.
        COALESCE(gl.balance, 0)::numeric(14,2)        AS gl_balance,
        COALESCE(gl.debit_total, 0)::numeric(14,2)    AS gl_debit_total,
        COALESCE(gl.credit_total, 0)::numeric(14,2)   AS gl_credit_total,
        COALESCE(gl.entry_count, 0)::int              AS gl_entry_count,
        gl.last_entry_date                            AS gl_last_entry_date,
        -- Drift indicator: diff between GL-derived and source-table balance.
        -- Non-zero means some source activity hasn't posted through the
        -- engine yet (or pre-071 untagged rows). Reconcile jobs consume this.
        (COALESCE(gl.balance, 0)
          - ((r.deductions + r.advances + r.payouts)
             - (r.wages + r.bonuses + r.expenses)))::numeric(14,2)
                                                      AS gl_vs_source_diff
      FROM rollup r
      CROSS JOIN coa
      LEFT JOIN gl ON gl.employee_user_id = r.employee_id
      ORDER BY r.employee_name
      `,
    );
  }

  /** Flat transaction list with filters. */
  @Get()
  @Permissions('employee.team.view')
  @ApiOperation({ summary: 'قائمة حركات الرواتب والذمم' })
  async list(
    @Query('employee_id') employeeId?: string,
    @Query('type') type?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = Math.min(Math.max(parseInt(limitRaw || '500', 10), 1), 2000);
    const conds: string[] = [];
    const args: any[] = [];
    if (employeeId) {
      args.push(employeeId);
      conds.push(`t.employee_id = $${args.length}::uuid`);
    }
    if (type) {
      args.push(type);
      conds.push(`t.type = $${args.length}`);
    }
    if (from) {
      args.push(from);
      conds.push(`t.txn_date >= $${args.length}::date`);
    }
    if (to) {
      args.push(to);
      conds.push(`t.txn_date <= $${args.length}::date`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    // Union view over BOTH the new employee_transactions table AND
    // the pre-existing ledger tables (employee_deductions/_bonuses/
    // _settlements + advance expenses). Unified shape so the
    // frontend payroll grid shows everything regardless of origin.
    const unionSql = `
      WITH all_txns AS (
        SELECT t.id::text AS id, t.employee_id, t.txn_date, t.type,
               t.amount, t.description, t.reference_type, t.reference_id::text AS reference_id,
               t.cashbox_id, t.shift_id, t.created_by, t.created_at
          FROM employee_transactions t
        UNION ALL
        SELECT 'ded:' || d.id::text, d.user_id, d.deduction_date, 'deduction',
               d.amount, d.reason,
               COALESCE(d.source, 'deduction'), d.shift_id::text,
               NULL::uuid, d.shift_id, d.created_by, d.created_at
          FROM employee_deductions d WHERE NOT d.is_void
        UNION ALL
        SELECT 'bon:' || b.id::text, b.user_id, b.bonus_date, 'bonus',
               b.amount, COALESCE(b.note, b.kind),
               b.kind, NULL::text, NULL::uuid, NULL::uuid,
               b.created_by, b.created_at
          FROM employee_bonuses b WHERE NOT b.is_void
        UNION ALL
        SELECT 'set:' || s.id::text, s.user_id, s.settlement_date, 'payout',
               s.amount, COALESCE(s.notes, s.method),
               'settlement', s.journal_entry_id::text,
               s.cashbox_id, NULL::uuid, s.created_by, s.created_at
          FROM employee_settlements s WHERE NOT s.is_void
        UNION ALL
        SELECT 'adv:' || e.id::text, e.employee_user_id, e.expense_date, 'advance',
               e.amount, e.description,
               'expense', e.id::text,
               e.cashbox_id, NULL::uuid, e.created_by, e.created_at
          FROM expenses e WHERE e.is_advance = TRUE AND e.employee_user_id IS NOT NULL
      )
      SELECT t.id, t.employee_id,
             COALESCE(u.full_name, u.username) AS employee_name,
             t.txn_date, t.type, t.amount, t.description,
             t.reference_type, t.reference_id,
             t.cashbox_id, t.shift_id,
             cb.name_ar  AS cashbox_name,
             s.shift_no,
             t.created_by, t.created_at
        FROM all_txns t
        LEFT JOIN users u     ON u.id  = t.employee_id
        LEFT JOIN cashboxes cb ON cb.id = t.cashbox_id
        LEFT JOIN shifts s    ON s.id  = t.shift_id
      ${where}
      ORDER BY t.txn_date DESC, t.created_at DESC
      LIMIT ${limit}
    `;
    return this.ds.query(unionSql, args);
  }

  /** Single-employee detail: profile + balance + recent transactions. */
  @Get('employee/:id')
  @Permissions('employee.team.view')
  @ApiOperation({ summary: 'ملف مالي لموظف واحد' })
  async employeeDetail(@Param('id', ParseUUIDPipe) id: string) {
    const [[profile]] = [
      await this.ds.query(
        `
        SELECT u.id, u.username, u.full_name, u.employee_no, u.job_title,
               u.salary_amount, u.salary_frequency, u.hire_date,
               r.code AS role_code, r.name_ar AS role_name
          FROM users u
          LEFT JOIN roles r ON r.id = u.role_id
         WHERE u.id = $1
        `,
        [id],
      ),
    ];
    if (!profile) throw new NotFoundException('الموظف غير موجود');

    const [[rollup]] = [
      await this.ds.query(
        `
        SELECT
          COALESCE(SUM(amount) FILTER (WHERE type='wage'),      0)::numeric(14,2) AS wages_total,
          COALESCE(SUM(amount) FILTER (WHERE type='bonus'),     0)::numeric(14,2) AS bonuses_total,
          COALESCE(SUM(amount) FILTER (WHERE type='deduction'), 0)::numeric(14,2) AS deductions_total,
          COALESCE(SUM(amount) FILTER (WHERE type='expense'),   0)::numeric(14,2) AS expenses_total,
          COALESCE(SUM(amount) FILTER (WHERE type='advance'),   0)::numeric(14,2) AS advances_total,
          COALESCE(SUM(amount) FILTER (WHERE type='payout'),    0)::numeric(14,2) AS payouts_total
        FROM employee_transactions WHERE employee_id = $1
        `,
        [id],
      ),
    ];

    const transactions = await this.ds.query(
      `
      SELECT id, txn_date, type, amount, description,
             reference_type, reference_id, cashbox_id, shift_id,
             created_at
        FROM employee_transactions
       WHERE employee_id = $1
       ORDER BY txn_date DESC, created_at DESC
       LIMIT 200
      `,
      [id],
    );

    const balance =
      Number(rollup.wages_total) +
      Number(rollup.bonuses_total) +
      Number(rollup.expenses_total) -
      Number(rollup.deductions_total) -
      Number(rollup.advances_total) -
      Number(rollup.payouts_total);
    const outstanding = Math.max(0, -balance);

    return {
      profile,
      rollup: {
        ...rollup,
        balance: Math.round(balance * 100) / 100,
        outstanding: Math.round(outstanding * 100) / 100,
      },
      transactions,
      coa: {
        account_code: '1123',
        account_name_ar: 'ذمم الموظفين',
      },
    };
  }

  /**
   * Create a new payroll transaction.
   *
   * The Payroll modal is one of several UI surfaces that can record
   * these business events. The other surfaces (Bonus form in Team
   * drawer, Deduction form in Team drawer, Settlement modal) POST
   * directly to their canonical endpoints. To prevent parallel
   * write paths from producing divergent ledger rows, this endpoint
   * now DELEGATES by type:
   *
   *   type      →  canonical service                  source table
   *   ─────────    ────────────────────────────────    ─────────────────────
   *   bonus     →  EmployeesService.addBonus          employee_bonuses
   *   deduction →  EmployeesService.addDeduction      employee_deductions
   *   payout    →  EmployeesService.recordSettlement  employee_settlements
   *   wage      →  direct employee_transactions INSERT (no canonical
   *                table exists yet for wages — documented as legacy
   *                on this one path until a future canonicalization)
   *
   * For bonus/deduction: the source row is inserted by the canonical
   * service, and migration 040's mirror triggers propagate it into
   * employee_transactions with `source_ref_type` set, so the Payroll
   * page's UNION query surfaces it identically to before.
   *
   * For payout: recordSettlement writes a balanced JE directly via
   * FinancialEngineService (see PR #68). `cashbox_id` is required so
   * we can forward method='cash'. If a caller wants bank / payroll
   * deduction / other, they must use POST /employees/:id/settlements
   * directly with the method parameter.
   *
   * `advance` and `expense` are disabled at the DTO boundary — see
   * the @IsIn comment on CreatePayrollDto.
   */
  @Post()
  @Permissions('employee.deductions.manage')
  @ApiOperation({ summary: 'تسجيل حركة راتب / خصم / سلفة / مكافأة' })
  async create(@Body() dto: CreatePayrollDto, @CurrentUser() user: JwtUser) {
    if (!(Number(dto.amount) > 0)) {
      throw new BadRequestException('المبلغ يجب أن يكون أكبر من صفر');
    }
    const userId = user.userId;

    switch (dto.type) {
      case 'bonus':
        return this.empSvc.addBonus(
          dto.employee_id,
          {
            amount: dto.amount,
            kind: 'bonus',
            note: dto.description,
            bonus_date: dto.txn_date,
          },
          userId,
        );
      case 'deduction':
        return this.empSvc.addDeduction(
          dto.employee_id,
          {
            amount: dto.amount,
            // addDeduction requires a reason string. The Payroll
            // modal makes `description` optional, so fall back to a
            // generic label rather than 400-ing.
            reason: dto.description?.trim() || 'خصم',
            deduction_date: dto.txn_date,
          },
          userId,
        );
      case 'payout':
        if (!dto.cashbox_id) {
          throw new BadRequestException(
            'payout from /payroll يتطلب cashbox_id — أو استخدم ' +
              'POST /employees/:id/settlements لاختيار method آخر',
          );
        }
        return this.empSvc.recordSettlement(
          dto.employee_id,
          {
            amount: dto.amount,
            settlement_date: dto.txn_date,
            method: 'cash',
            cashbox_id: dto.cashbox_id,
            notes: dto.description,
          },
          userId,
        );
      case 'wage':
        // Daily wage now flows exclusively through the attendance /
        // payable-day workflow (migration 082–083, PR #88). A manual
        // wage row from this modal would be a parallel, unlinked
        // source that the monthly Employee Profile (PR-B) can't
        // reconcile against GL — and which was silently racing with
        // the payable_days insert to produce the duplicate-entry
        // error users kept hitting. Reject with a clear redirect.
        throw new BadRequestException(
          'اليومية تُسجَّل من مسار الحضور / تثبيت يومية، وليست كحركة يدوية هنا. ' +
            'استخدم POST /attendance/admin/mark-payable-day لتسجيل يومية، ' +
            'ثم POST /employees/:id/pay-wage لصرف المبلغ من الخزنة.',
        );
    }
  }

  /**
   * Update narrative fields only. Amount/type are immutable — if you
   * need to correct a posted transaction, DELETE it (which triggers
   * a GL reversal) and re-create.
   */
  @Patch(':id')
  @Permissions('employee.deductions.manage')
  @ApiOperation({ summary: 'تعديل ملاحظات حركة (المبلغ/النوع ثابتان)' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePayrollDto,
  ) {
    const [row] = await this.ds.query(
      `UPDATE employee_transactions
          SET description = COALESCE($2, description),
              updated_at  = NOW()
        WHERE id = $1
        RETURNING *`,
      [id, dto.description ?? null],
    );
    if (!row) throw new NotFoundException('الحركة غير موجودة');
    return row;
  }

  /**
   * Admin-only void. The Payroll UI's delete button calls this
   * endpoint. It dispatches by the prefix encoded in the id (from
   * the UNION SELECT in `list()`):
   *
   *   bon:<id>  → employee_bonuses.is_void=true → cascade
   *               (migration 040 mirror DELETEs employee_transactions
   *               row → migration 038 fn_trg_employee_txn_post
   *               UPDATEs journal_entries.is_void=true)
   *   ded:<id>  → employee_deductions.is_void=true → same cascade
   *   set:<id>  → three-step: (a) fn_record_cashbox_txn reversing
   *               out if method=cash/bank, (b) UPDATE
   *               journal_entries.is_void=true for the linked JE,
   *               (c) UPDATE employee_settlements.is_void=true
   *   adv:<id>  → REFUSED (expense advances have their own flow;
   *               voiding here would orphan expense_no + cashbox)
   *   <uuid>    → employee_transactions DELETE (wage only, since
   *               bonus/deduction/expense types are disabled and
   *               advance/expense delegation routes through
   *               canonical tables via PR #77). Protected
   *               reference_types refused before delete.
   *
   * Protected reference types (hardcoded): never deletable from
   * here, regardless of role —
   *   * employee_ledger_reset_2026_04 (opening-balance adjustments)
   *   * expense_reclass_to_1123       (expense reclassifications)
   *
   * Role gate: admin only. Managers/accountants can create via the
   * regular flows but cannot void.
   */
  @Delete(':id')
  @Roles('admin')
  @ApiOperation({
    summary:
      'إلغاء أثر حركة (void — ليس حذف نهائي). Admin-only.',
  })
  async voidTxn(
    @Param('id') id: string,
    @CurrentUser() user: JwtUser,
  ) {
    const PROTECTED_REF_TYPES = [
      'employee_ledger_reset_2026_04',
      'expense_reclass_to_1123',
    ];
    const voidReason = 'Admin void via Payroll UI';
    const userId = user.userId;

    // Prefix dispatch
    if (id.startsWith('bon:')) {
      const rawId = id.slice(4);
      return this.ds.transaction(async (em) => {
        // Engine context — needed because the is_void UPDATE cascades
        // through mirror DELETE → fn_trg_employee_txn_post which
        // UPDATEs journal_entries.is_void=true. Without the context,
        // migration 068's strict guard blocks that UPDATE.
        await em.query(
          `SELECT set_config('app.engine_context', 'engine:admin_void_payroll', true)`,
        );
        const [row] = await em.query(
          `UPDATE employee_bonuses
              SET is_void = TRUE,
                  voided_at = NOW(),
                  voided_by = $2,
                  void_reason = $3
            WHERE id = $1::bigint AND is_void = FALSE
            RETURNING id`,
          [rawId, userId, voidReason],
        );
        if (!row) throw new NotFoundException('الحافز غير موجود أو ملغى مسبقاً');
        return { voided: true, source: 'employee_bonuses', id: rawId };
      });
    }

    if (id.startsWith('ded:')) {
      const rawId = id.slice(4);
      return this.ds.transaction(async (em) => {
        await em.query(
          `SELECT set_config('app.engine_context', 'engine:admin_void_payroll', true)`,
        );
        const [row] = await em.query(
          `UPDATE employee_deductions
              SET is_void = TRUE,
                  voided_at = NOW(),
                  voided_by = $2,
                  void_reason = $3
            WHERE id = $1::bigint AND is_void = FALSE
            RETURNING id`,
          [rawId, userId, voidReason],
        );
        if (!row) throw new NotFoundException('الخصم غير موجود أو ملغى مسبقاً');
        return { voided: true, source: 'employee_deductions', id: rawId };
      });
    }

    if (id.startsWith('set:')) {
      const rawId = id.slice(4);
      return this.ds.transaction(async (em) => {
        await em.query(
          `SELECT set_config('app.engine_context', 'engine:admin_void_payroll', true)`,
        );
        const [s] = await em.query(
          `SELECT id, user_id, amount, method, cashbox_id,
                  journal_entry_id, is_void, created_by
             FROM employee_settlements
            WHERE id = $1::bigint`,
          [rawId],
        );
        if (!s) throw new NotFoundException('التسوية غير موجودة');
        if (s.is_void) {
          throw new BadRequestException('التسوية ملغاة مسبقاً');
        }
        // (a) Reverse cashbox if cash moved
        if (
          (s.method === 'cash' || s.method === 'bank') &&
          s.cashbox_id
        ) {
          await em.query(
            `SELECT fn_record_cashbox_txn($1::uuid, 'out', $2::numeric,
                                          'employee_settlement_reversal',
                                          'other',
                                          $3::uuid, $4::uuid, $5)`,
            [
              s.cashbox_id,
              s.amount,
              s.journal_entry_id,
              userId,
              `${voidReason} — reversing settlement id=${s.id}`,
            ],
          );
        }
        // (b) Void the JE
        if (s.journal_entry_id) {
          await em.query(
            `UPDATE journal_entries
                SET is_void = TRUE,
                    voided_at = NOW(),
                    voided_by = $2,
                    void_reason = $3
              WHERE id = $1::uuid AND is_void = FALSE`,
            [s.journal_entry_id, userId, voidReason],
          );
        }
        // (c) Void the source row
        await em.query(
          `UPDATE employee_settlements
              SET is_void = TRUE,
                  voided_at = NOW(),
                  voided_by = $2,
                  void_reason = $3
            WHERE id = $1::bigint`,
          [rawId, userId, voidReason],
        );
        return { voided: true, source: 'employee_settlements', id: rawId };
      });
    }

    if (id.startsWith('adv:')) {
      throw new BadRequestException(
        'لا يمكن إلغاء سلفة من هذه الصفحة — استخدم صفحة المصروفات اليومية',
      );
    }

    // Fallback: UUID → employee_transactions direct insert (wage only
    // on new writes). Refuse if the linked JE has a protected
    // reference_type, even though those shouldn't reach the UI.
    const [je] = await this.ds.query(
      `SELECT je.reference_type
         FROM journal_entries je
        WHERE je.reference_type = 'employee_txn'
          AND je.reference_id::text = $1
          AND je.is_posted AND NOT je.is_void
        LIMIT 1`,
      [id],
    );
    if (!je) {
      throw new NotFoundException('الحركة غير موجودة');
    }
    // Protected-ref safety (defense-in-depth; UI never exposes these)
    if (PROTECTED_REF_TYPES.includes(je.reference_type)) {
      throw new ForbiddenException(
        'قيود التسوية والتصحيح محمية — لا يمكن إلغاؤها من هذه الواجهة',
      );
    }
    // Wage DELETE also triggers fn_trg_employee_txn_post → UPDATE
    // journal_entries.is_void=true. Same engine-context requirement.
    return this.ds.transaction(async (em) => {
      await em.query(
        `SELECT set_config('app.engine_context', 'engine:admin_void_payroll', true)`,
      );
      const res = await em.query(
        `DELETE FROM employee_transactions WHERE id = $1::uuid RETURNING id`,
        [id],
      );
      if (!res.length) throw new NotFoundException('الحركة غير موجودة');
      return { voided: true, source: 'employee_transactions', id };
    });
  }
}
