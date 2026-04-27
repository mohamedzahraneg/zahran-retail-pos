import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  MinLength,
} from 'class-validator';
import { EmployeesService } from './employees.service';
import { Permissions } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  JwtUser,
} from '../common/decorators/current-user.decorator';

class RequestDto {
  // 'advance' removed from the generic dropdown (audit #4 — triple-path
  // dual-write risk). Approved advance requests used to chain through
  // a DB mirror trigger → employee_transactions → fn_post_employee_txn,
  // which writes journal_lines only (no cashbox_transactions) and can
  // duplicate an expenses.is_advance=TRUE entry for the same money.
  // Canonical advance path is POST /accounting/expenses{,/daily}
  // with is_advance=TRUE, which routes through FinancialEngine and
  // correctly writes both GL + cashbox. Historical advance requests
  // still read correctly; this generic endpoint refuses new advance
  // submissions to keep the surface narrow.
  //
  // PR-ESS-2A — self-service advance submission re-introduced via a
  // SEPARATE dedicated endpoint (POST /me/requests/advance, DTO below)
  // that lands in the same employee_requests table. The dedicated
  // endpoint is REQUEST-ONLY: it never posts GL/cashbox/expense and
  // never invokes FinancialEngineService. Disbursement of an approved
  // request will be wired in PR-ESS-2B (links the request to a Daily
  // Expense via source_employee_request_id and updates status only
  // after the canonical FinancialEngine.recordExpense path completes).
  @IsIn(['leave', 'overtime_extension', 'other']) kind:
    | 'leave'
    | 'overtime_extension'
    | 'other';
  @IsOptional() @IsNumber() amount?: number;
  @IsOptional() @IsDateString() starts_at?: string;
  @IsOptional() @IsDateString() ends_at?: string;
  @IsOptional() @IsString() reason?: string;
}

/**
 * PR-ESS-2A — self-service salary-advance REQUEST submission.
 *
 * IMPORTANT: this DTO captures a *request* only — it MUST NOT be used
 * to record an actual paid advance. Approval of a request created from
 * this DTO is a status flip in employee_requests; it never moves money,
 * never touches journal_entries / journal_lines / cashbox_transactions,
 * and never calls FinancialEngineService. The actual disbursement is
 * the operator's separate Daily Expense step (PR-ESS-2B will link the
 * two via expenses.source_employee_request_id).
 */
class AdvanceRequestDto {
  @IsNumber() @Min(0.01) amount: number;
  @IsString() @MinLength(1) reason: string;
  @IsOptional() @IsString() notes?: string;
}

class DecideDto {
  @IsIn(['approved', 'rejected']) decision: 'approved' | 'rejected';
  @IsOptional() @IsString() reason?: string;
}

class BonusDto {
  @IsNumber() @Min(0.01) amount: number;
  @IsOptional() @IsIn(['bonus', 'incentive', 'overtime', 'other']) kind?: string;
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsDateString() bonus_date?: string;
}

class DeductionDto {
  @IsNumber() @Min(0.01) amount: number;
  @IsString() @MinLength(1) reason: string;
  @IsOptional() @IsDateString() deduction_date?: string;
}

class SettlementDto {
  @IsNumber() @Min(0.01) amount: number;
  @IsOptional() @IsDateString() settlement_date?: string;
  @IsOptional() @IsIn(['cash', 'bank', 'payroll_deduction', 'other']) method?:
    | 'cash'
    | 'bank'
    | 'payroll_deduction'
    | 'other';
  @IsOptional() @IsUUID() cashbox_id?: string;
  // Offset account for method='other'. Required when method='other',
  // ignored otherwise. The settlement JE debits this account and
  // credits 1123 — so this is the non-cash DR side (e.g. '1114'
  // ewallet, a specific bank sub-account, or a write-off expense
  // account). Must not be 1123 itself.
  @IsOptional() @IsString() offset_account_code?: string;
  @IsOptional() @IsString() notes?: string;
  /** PR-15 follow-up — shift_id was being stripped by NestJS's
   *  whitelist validation because the DTO didn't declare it. The
   *  service-layer validation in recordSettlement therefore never
   *  fired (closed-shift checks, cashbox-mismatch checks). Declaring
   *  it here lets the validator pass it through to the service. */
  @IsOptional() @IsUUID() shift_id?: string;
}

class TaskDto {
  @IsUUID() user_id: string;
  @IsString() @MinLength(1) title: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsIn(['low', 'normal', 'high', 'urgent']) priority?:
    | 'low'
    | 'normal'
    | 'high'
    | 'urgent';
  @IsOptional() @IsDateString() due_at?: string;
}

class ProfileDto {
  @IsOptional() @IsString() employee_no?: string;
  @IsOptional() @IsString() job_title?: string;
  @IsOptional() @IsDateString() hire_date?: string;
  @IsOptional() @IsNumber() @Min(0) salary_amount?: number;
  @IsOptional() @IsIn(['daily', 'weekly', 'monthly']) salary_frequency?:
    | 'daily'
    | 'weekly'
    | 'monthly';
  @IsOptional() @IsNumber() @Min(0) target_hours_day?: number;
  @IsOptional() @IsNumber() @Min(0) target_hours_week?: number;
  @IsOptional() @IsNumber() @Min(0) overtime_rate?: number;
  @IsOptional() @IsString() shift_start_time?: string;   // "HH:MM"
  @IsOptional() @IsString() shift_end_time?: string;
  @IsOptional() @IsNumber() @Min(0) late_grace_min?: number;
}

@ApiBearerAuth()
@ApiTags('employees')
@Controller('employees')
export class EmployeesController {
  constructor(private readonly svc: EmployeesService) {}

  // ── Self-service (any authenticated user) ──────────────────────────
  @Get('me/dashboard')
  @Permissions('employee.dashboard.view')
  myDashboard(
    @CurrentUser() user: JwtUser,
    @Query('month') month?: string,
  ) {
    return this.svc.myDashboard(user.userId, month);
  }

  @Get('me/tasks')
  @Permissions('employee.dashboard.view')
  myTasks(@CurrentUser() user: JwtUser) {
    return this.svc.myTasks(user.userId);
  }

  @Post('me/tasks/:id/acknowledge')
  @Permissions('employee.dashboard.view')
  ackTask(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.svc.acknowledgeTask(id, user.userId);
  }

  @Post('me/tasks/:id/complete')
  @Permissions('employee.dashboard.view')
  completeTask(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    return this.svc.completeTask(id, user.userId);
  }

  @Get('me/requests')
  @Permissions('employee.dashboard.view')
  myRequests(@CurrentUser() user: JwtUser) {
    return this.svc.myRequests(user.userId);
  }

  @Post('me/requests')
  @Permissions('employee.requests.submit')
  submitRequest(@Body() dto: RequestDto, @CurrentUser() user: JwtUser) {
    return this.svc.submitRequest(user.userId, dto);
  }

  /**
   * PR-ESS-2A — self-service salary-advance REQUEST submission.
   *
   * Request-only path. Inserts an `employee_requests` row with
   * `kind='advance'` and `status='pending'`. Manager approval (via the
   * existing `POST /employees/requests/:id/decide` endpoint) flips
   * `status` to `'approved'` or `'rejected'` — and that's all it does.
   * No GL, no cashbox, no expense, no FinancialEngine call.
   *
   * Disbursement remains the operator's separate Daily Expense step.
   * PR-ESS-2B will add `expenses.source_employee_request_id` so an
   * approved request can be marked "disbursed" once the linked expense
   * posts via the canonical FinancialEngine path. Until then, the UI
   * should show approved advance requests as "موافق عليه — بانتظار
   * الصرف من قِبَل المحاسبة" so neither operators nor employees
   * mistake an approved request for an actual money movement.
   *
   * Permission: reuses `employee.requests.submit` (same gate as the
   * other self-service request types). A dedicated
   * `employee.advance.request` permission is intentionally NOT added
   * here — see PR-PERM-CATALOG-1 to normalize the permissions catalog
   * holistically (multiple existing self-service permissions are
   * declared in code only and missing from the DB `permissions`
   * catalog, so adding one in isolation would be inconsistent).
   */
  @Post('me/requests/advance')
  @Permissions('employee.requests.submit')
  submitAdvanceRequest(
    @Body() dto: AdvanceRequestDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.submitAdvanceRequest(user.userId, dto);
  }

  // ── Admin / HR ─────────────────────────────────────────────────────
  @Get('team')
  @Permissions('employee.team.view')
  team() {
    return this.svc.teamOverview();
  }

  @Get('requests/pending')
  @Permissions('employee.requests.approve')
  pending() {
    return this.svc.listPendingRequests();
  }

  /**
   * PR-ESS-2B — list `kind='advance_request'` rows for `:id` that are
   * currently in `status='approved'` AND not yet linked to any
   * `expenses.source_employee_request_id`. Drives the admin
   * AdvanceModal dropdown that lets the operator link a daily-expense
   * disbursement back to the originating request.
   *
   * Permission: `accounts.journal.post` is the existing gate that
   * already protects the AdvanceModal action surface, so it's the
   * natural choice here too — anyone who can post the disbursing
   * expense can see what's available to link.
   */
  @Get(':id/disbursable-advance-requests')
  @Permissions('accounts.journal.post')
  listDisbursableAdvanceRequests(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.listDisbursableAdvanceRequests(id);
  }

  @Post('requests/:id/decide')
  @Permissions('employee.requests.approve')
  decide(
    @Param('id') id: string,
    @Body() dto: DecideDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.decideRequest(id, dto.decision, user.userId, dto.reason);
  }

  @Patch(':id/profile')
  @Permissions('employee.profile.manage')
  updateProfile(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ProfileDto,
  ) {
    return this.svc.updateProfile(id, dto);
  }

  @Get(':id/bonuses')
  @Permissions('employee.bonuses.view')
  bonuses(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.svc.listBonuses(id, from, to);
  }

  @Post(':id/bonuses')
  @Permissions('employee.bonuses.manage')
  addBonus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BonusDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.addBonus(id, dto, user.userId);
  }

  @Get(':id/deductions')
  @Permissions('employee.deductions.view')
  deductions(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.listDeductions(id);
  }

  @Post(':id/deductions')
  @Permissions('employee.deductions.manage')
  addDeduction(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeductionDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.addDeduction(id, dto, user.userId);
  }

  @Post('tasks')
  @Permissions('employee.tasks.assign')
  createTask(@Body() dto: TaskDto, @CurrentUser() user: JwtUser) {
    return this.svc.createTask(dto, user.userId);
  }

  @Post('tasks/:id/cancel')
  @Permissions('employee.tasks.assign')
  cancelTask(@Param('id') id: string) {
    return this.svc.cancelTask(id);
  }

  @Get(':id/dashboard')
  @Permissions('employee.team.view')
  userDashboard(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('month') month?: string,
  ) {
    return this.svc.myDashboard(id, month);
  }

  // ── Financial Ledger (migration 060) ─────────────────────────────
  @Get('me/ledger')
  @Permissions('employee.dashboard.view')
  myLedger(
    @CurrentUser() user: JwtUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.svc.financialLedger(user.userId, from, to);
  }

  @Get(':id/ledger')
  @Permissions('employee.ledger.view')
  ledger(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.svc.financialLedger(id, from, to);
  }

  @Post(':id/settlements')
  @Permissions('employee.ledger.view')
  addSettlement(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SettlementDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.recordSettlement(id, dto, user.userId, user.permissions ?? []);
  }

  @Get('me/history')
  @Permissions('employee.dashboard.view')
  myHistory(
    @CurrentUser() user: JwtUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const today = new Date().toISOString().slice(0, 10);
    const thirty = new Date(Date.now() - 30 * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
    return this.svc.daysHistory(user.userId, from || thirty, to || today);
  }

  @Get(':id/history')
  @Permissions('employee.team.view')
  history(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const today = new Date().toISOString().slice(0, 10);
    const thirty = new Date(Date.now() - 30 * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
    return this.svc.daysHistory(id, from || thirty, to || today);
  }
}
