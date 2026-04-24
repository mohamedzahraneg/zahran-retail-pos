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
  @IsIn(['advance', 'leave', 'overtime_extension', 'other']) kind:
    | 'advance'
    | 'leave'
    | 'overtime_extension'
    | 'other';
  @IsOptional() @IsNumber() amount?: number;
  @IsOptional() @IsDateString() starts_at?: string;
  @IsOptional() @IsDateString() ends_at?: string;
  @IsOptional() @IsString() reason?: string;
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
  myDashboard(@CurrentUser() user: JwtUser) {
    return this.svc.myDashboard(user.userId);
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
  userDashboard(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.myDashboard(id);
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
    return this.svc.recordSettlement(id, dto, user.userId);
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
