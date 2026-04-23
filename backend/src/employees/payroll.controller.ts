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
import { Permissions } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  JwtUser,
} from '../common/decorators/current-user.decorator';

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
  @IsIn(['wage', 'bonus', 'deduction', 'expense', 'advance', 'payout'])
  type!: 'wage' | 'bonus' | 'deduction' | 'expense' | 'advance' | 'payout';
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
  constructor(private readonly ds: DataSource) {}

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
    return this.ds.query(
      `
      WITH rollup AS (
        SELECT
          u.id                                              AS employee_id,
          u.username,
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
          )::numeric(14,2) AS wages_total,
          (
            COALESCE((SELECT SUM(amount) FROM employee_transactions t
                       WHERE t.employee_id = u.id AND t.type='bonus'), 0)
            + COALESCE((SELECT SUM(amount) FROM employee_bonuses b
                         WHERE b.user_id = u.id), 0)
          )::numeric(14,2) AS bonuses_total,
          (
            COALESCE((SELECT SUM(amount) FROM employee_transactions t
                       WHERE t.employee_id = u.id AND t.type='deduction'), 0)
            + COALESCE((SELECT SUM(amount) FROM employee_deductions d
                         WHERE d.user_id = u.id), 0)
          )::numeric(14,2) AS deductions_total,
          (
            COALESCE((SELECT SUM(amount) FROM employee_transactions t
                       WHERE t.employee_id = u.id AND t.type='expense'), 0)
          )::numeric(14,2) AS expenses_total,
          (
            COALESCE((SELECT SUM(amount) FROM employee_transactions t
                       WHERE t.employee_id = u.id AND t.type='advance'), 0)
            + COALESCE((SELECT SUM(amount) FROM expenses e
                         WHERE e.employee_user_id = u.id AND e.is_advance = TRUE), 0)
          )::numeric(14,2) AS advances_total,
          (
            COALESCE((SELECT SUM(amount) FROM employee_transactions t
                       WHERE t.employee_id = u.id AND t.type='payout'), 0)
            + COALESCE((SELECT SUM(amount) FROM employee_settlements s
                         WHERE s.user_id = u.id), 0)
          )::numeric(14,2) AS payouts_total,
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
      )
      SELECT
        r.employee_id,
        r.employee_name,
        r.username,
        r.employee_no,
        r.job_title,
        r.salary_amount::numeric(14,2),
        r.salary_frequency,
        r.wages_total,
        r.bonuses_total,
        r.deductions_total,
        r.expenses_total,
        r.advances_total,
        r.payouts_total,
        -- Signed balance: credits - debits
        ((r.wages_total + r.bonuses_total + r.expenses_total)
         - (r.deductions_total + r.advances_total + r.payouts_total))::numeric(14,2) AS balance,
        -- What the employee owes (AR perspective)
        GREATEST(0, ((r.deductions_total + r.advances_total + r.payouts_total)
                     - (r.wages_total + r.bonuses_total + r.expenses_total)))::numeric(14,2) AS outstanding,
        r.last_txn_date,
        -- COA link — every employee balance lives under 1123
        coa.code     AS coa_account_code,
        coa.name_ar  AS coa_account_name_ar
      FROM rollup r, coa
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
   * Create a new payroll transaction. The `trg_employee_txn_post`
   * database trigger automatically posts the matching GL entry and
   * cashbox movement (if applicable) inside the same transaction.
   */
  @Post()
  @Permissions('employee.deductions.manage')
  @ApiOperation({ summary: 'تسجيل حركة راتب / خصم / سلفة / مكافأة' })
  async create(@Body() dto: CreatePayrollDto, @CurrentUser() user: JwtUser) {
    if (!(Number(dto.amount) > 0)) {
      throw new BadRequestException('المبلغ يجب أن يكون أكبر من صفر');
    }
    const [row] = await this.ds.query(
      `
      INSERT INTO employee_transactions
        (employee_id, txn_date, type, amount, description,
         cashbox_id, shift_id, created_by)
      VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, $4, $5, $6, $7, $8)
      RETURNING *
      `,
      [
        dto.employee_id,
        dto.txn_date ?? null,
        dto.type,
        dto.amount,
        dto.description ?? null,
        dto.cashbox_id ?? null,
        dto.shift_id ?? null,
        user.userId,
      ],
    );
    return row;
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

  @Delete(':id')
  @Permissions('employee.deductions.manage')
  @ApiOperation({ summary: 'حذف حركة (الـ trigger يعكس القيد تلقائياً)' })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    const res = await this.ds.query(
      `DELETE FROM employee_transactions WHERE id = $1 RETURNING id`,
      [id],
    );
    if (!res.length) throw new NotFoundException('الحركة غير موجودة');
    return { deleted: true, id };
  }
}
