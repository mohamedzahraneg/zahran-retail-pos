import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AccountingService } from './accounting.service';
import {
  ExpenseApprovalService,
  CreateRuleDto,
} from './approval.service';
import { CostAccountResolver } from './cost-account-resolver.service';
import { CostReconciliationService } from './cost-reconciliation.service';
import {
  CurrentUser,
  JwtUser,
} from '../common/decorators/current-user.decorator';
import {
  CreateDailyExpenseDto,
  CreateExpenseCategoryDto,
  CreateExpenseDto,
  CreateExpenseEditRequestDto,
  ListExpensesDto,
  ReportRangeDto,
  UpdateExpenseCategoryDto,
  UpdateExpenseDto,
} from './dto/accounting.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles, Permissions } from '../common/decorators/roles.decorator';

@ApiTags('accounting')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Permissions('accounting.view')
@Controller('accounting')
export class AccountingController {
  constructor(
    private readonly service: AccountingService,
    private readonly approvals: ExpenseApprovalService,
    private readonly resolver: CostAccountResolver,
    private readonly reconciliation: CostReconciliationService,
  ) {}

  // ─── Cost reconciliation endpoints (migration 065) ─────────────
  /** Current resolver mapping — proof that every active category has a COA link. */
  @Get('cost/mappings')
  @Permissions('accounting.cost.reconcile')
  @ApiOperation({ summary: 'خريطة تصنيف المصروفات → شجرة الحسابات' })
  costMappings() {
    return this.resolver.listMappings();
  }

  /** Run a reconciliation pass. Idempotent per (report_date, adhoc). */
  @Post('cost/reconcile')
  @Permissions('accounting.cost.reconcile')
  @ApiOperation({ summary: 'تشغيل تسوية المصروفات لتاريخ معين' })
  runReconciliation(
    @Body() body: { report_date?: string; run_type?: 'daily' | 'adhoc' | 'hourly' | 'backfill' },
    @CurrentUser() user: JwtUser,
  ) {
    return this.reconciliation.run({
      reportDate: body?.report_date,
      runType: body?.run_type,
      generatedBy: user?.userId,
    });
  }

  @Get('cost/reconcile/history')
  @Permissions('accounting.cost.reconcile')
  @ApiOperation({ summary: 'تاريخ تقارير التسوية' })
  reconciliationHistory(@Query('limit') limit?: string) {
    return this.reconciliation.listHistory(limit ? parseInt(limit, 10) : 30);
  }

  @Get('cost/reconcile/:id')
  @Permissions('accounting.cost.reconcile')
  @ApiOperation({ summary: 'تفاصيل تقرير تسوية واحد' })
  reconciliationDetail(@Param('id') id: string) {
    return this.reconciliation.get(parseInt(id, 10));
  }

  /** Single reporting surface — NEVER read raw legacy/engine tables for expense analysis. */
  @Get('cost/unified-ledger')
  @Permissions('accounting.cost.reconcile')
  @ApiOperation({ summary: 'الدفتر الموحَّد للتكاليف (خالي من التكرار)' })
  unifiedLedger(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    return this.reconciliation.unifiedLedger({
      from,
      to,
      limit: limit ? parseInt(limit, 10) : 200,
    });
  }

  // ─── Expense approvals ───────────────────────────────────────────────

  @Get('approvals/rules')
  @Permissions('accounts.approval.manage')
  listApprovalRules() {
    return this.approvals.listRules();
  }

  @Post('approvals/rules')
  @Permissions('accounts.approval.manage')
  createApprovalRule(@Body() dto: CreateRuleDto) {
    return this.approvals.createRule(dto);
  }

  @Patch('approvals/rules/:id')
  @Permissions('accounts.approval.manage')
  updateApprovalRule(
    @Param('id') id: string,
    @Body() dto: Partial<CreateRuleDto> & { is_active?: boolean },
  ) {
    return this.approvals.updateRule(id, dto);
  }

  @Delete('approvals/rules/:id')
  @Permissions('accounts.approval.manage')
  removeApprovalRule(@Param('id') id: string) {
    return this.approvals.removeRule(id);
  }

  @Get('approvals/inbox')
  @Permissions('accounts.approval.decide')
  approvalInbox(@Req() req: any) {
    return this.approvals.inboxFor(req.user.sub ?? req.user.id ?? req.user.userId);
  }

  @Post('approvals/:id/approve')
  @Permissions('accounts.approval.decide')
  approve(
    @Param('id') id: string,
    @Body() body: { note?: string },
    @Req() req: any,
  ) {
    return this.approvals.approve(
      id,
      req.user.sub ?? req.user.id ?? req.user.userId,
      body?.note,
    );
  }

  @Post('approvals/:id/reject')
  @Permissions('accounts.approval.decide')
  reject(
    @Param('id') id: string,
    @Body() body: { reason: string },
    @Req() req: any,
  ) {
    return this.approvals.reject(
      id,
      req.user.sub ?? req.user.id ?? req.user.userId,
      body?.reason,
    );
  }

  @Get('approvals/expense/:id')
  @Permissions('accounting.view')
  approvalsForExpense(@Param('id') id: string) {
    return this.approvals.listForExpense(id);
  }

  // ─── Categories ──────────────────────────────────────────────────────
  @Get('categories')
  @ApiOperation({ summary: 'List expense categories' })
  listCategories(@Query('include_inactive') includeInactive?: string) {
    return this.service.listCategories(includeInactive === 'true');
  }

  @Post('categories')
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'Create an expense category' })
  createCategory(@Body() dto: CreateExpenseCategoryDto) {
    return this.service.createCategory(dto);
  }

  @Patch('categories/:id')
  @Roles('admin', 'manager')
  updateCategory(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateExpenseCategoryDto,
  ) {
    return this.service.updateCategory(id, dto);
  }

  @Delete('categories/:id')
  @Roles('admin', 'manager')
  deleteCategory(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.deleteCategory(id);
  }

  // ─── Expenses ────────────────────────────────────────────────────────
  @Get('expenses')
  @ApiOperation({ summary: 'List expenses with filters' })
  listExpenses(@Query() filters: ListExpensesDto) {
    return this.service.listExpenses(filters);
  }

  @Post('expenses')
  @Roles('admin', 'manager', 'accountant')
  @ApiOperation({ summary: 'Create a new expense' })
  createExpense(@Body() dto: CreateExpenseDto, @Req() req: any) {
    return this.service.createExpense(dto, req.user.sub ?? req.user.id);
  }

  /**
   * Daily Expenses screen (migration 060). Requires the slim
   * `expenses.daily.create` permission — granted to admin + manager +
   * accountant (and the admin wildcard). Enforces an explicit
   * employee link on every row so the Employee Financial Ledger
   * can surface the entry.
   */
  @Post('expenses/daily')
  @Roles('admin', 'manager', 'accountant', 'cashier')
  @Permissions('expenses.daily.create')
  @ApiOperation({ summary: 'تسجيل مصروف يومي مرتبط بالموظف المسؤول' })
  createDailyExpense(
    @Body() dto: CreateDailyExpenseDto,
    @Req() req: any,
  ) {
    const userId = req.user.sub ?? req.user.id ?? req.user.userId;
    const permissions: string[] = Array.isArray(req.user?.permissions)
      ? req.user.permissions
      : [];
    return this.service.createDailyExpense(dto, userId, permissions);
  }

  @Patch('expenses/:id')
  @Roles('admin', 'manager', 'accountant')
  updateExpense(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateExpenseDto,
  ) {
    return this.service.updateExpense(id, dto);
  }

  @Post('expenses/:id/approve')
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'Approve an expense (posts to cashbox if cash)' })
  approveExpense(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: any,
  ) {
    return this.service.approveExpense(id, req.user.sub ?? req.user.id);
  }

  @Delete('expenses/:id')
  @Roles('admin', 'manager')
  deleteExpense(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.deleteExpense(id);
  }

  // ─── Expense edit-request workflow (migration 094) ─────────────────
  //
  // /accounting/expenses/:id/edit-request          POST  — file
  // /accounting/expenses/:id/edit-requests         GET   — history
  // /accounting/expenses/edit-requests/inbox       GET   — pending
  // /accounting/expenses/edit-requests/:id/approve POST  — apply
  // /accounting/expenses/edit-requests/:id/reject  POST  — reject
  // /accounting/expenses/edit-requests/:id/cancel  POST  — cancel own
  //
  // RBAC:
  //   * Filing requires `expenses.daily.edit.request` (admin / manager
  //     / cashier — all granted in migration 094).
  //   * Approving requires `expenses.daily.edit.approve` (admin /
  //     manager only).
  //   * Cancelling requires `expenses.daily.edit.request` AND being
  //     the original requester (enforced inside the service).
  // ───────────────────────────────────────────────────────────────────

  @Post('expenses/:id/edit-request')
  @Permissions('expenses.daily.edit.request')
  @ApiOperation({ summary: 'طلب تعديل مصروف يومي معتمد' })
  requestExpenseEdit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateExpenseEditRequestDto,
    @Req() req: any,
  ) {
    return this.service.requestExpenseEdit(
      id,
      { reason: dto.reason, new_values: (dto.new_values ?? {}) as Record<string, any> },
      req.user.sub ?? req.user.id ?? req.user.userId,
    );
  }

  @Get('expenses/:id/edit-requests')
  @ApiOperation({ summary: 'سجل طلبات التعديل لمصروف معيّن' })
  listEditRequestsForExpense(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.listEditRequestsForExpense(id);
  }

  @Get('expenses/edit-requests/inbox')
  @Permissions('expenses.daily.edit.approve')
  @ApiOperation({ summary: 'صندوق الموافقات على طلبات تعديل المصروفات' })
  editRequestsInbox() {
    return this.service.editRequestsInbox();
  }

  @Post('expenses/edit-requests/:id/approve')
  @Permissions('expenses.daily.edit.approve')
  @ApiOperation({ summary: 'الموافقة على طلب تعديل + ترحيل التصحيح' })
  approveEditRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: any,
  ) {
    return this.service.approveEditRequest(
      id,
      req.user.sub ?? req.user.id ?? req.user.userId,
    );
  }

  @Post('expenses/edit-requests/:id/reject')
  @Permissions('expenses.daily.edit.approve')
  @ApiOperation({ summary: 'رفض طلب التعديل' })
  rejectEditRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { reason: string },
    @Req() req: any,
  ) {
    return this.service.rejectEditRequest(
      id,
      req.user.sub ?? req.user.id ?? req.user.userId,
      body?.reason ?? '',
    );
  }

  @Post('expenses/edit-requests/:id/cancel')
  @Permissions('expenses.daily.edit.request')
  @ApiOperation({ summary: 'إلغاء طلب تعديل (لصاحب الطلب فقط)' })
  cancelEditRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: any,
  ) {
    return this.service.cancelEditRequest(
      id,
      req.user.sub ?? req.user.id ?? req.user.userId,
    );
  }

  // ─── Reports ─────────────────────────────────────────────────────────
  @Get('reports/profit-and-loss')
  @Roles('admin', 'manager', 'accountant')
  @ApiOperation({ summary: 'Profit & Loss for a date range' })
  profitAndLoss(@Query() dto: ReportRangeDto) {
    return this.service.profitAndLoss(dto);
  }

  @Get('reports/profit-and-loss/analysis')
  @Roles('admin', 'manager', 'accountant')
  @ApiOperation({ summary: 'Smart P&L analysis — verdict + reasons (Arabic)' })
  profitAndLossAnalysis(@Query() dto: ReportRangeDto) {
    return this.service.profitAndLossAnalysis(dto);
  }

  @Get('reports/cashflow')
  @Roles('admin', 'manager', 'accountant')
  @ApiOperation({ summary: 'Cashflow summary by category' })
  cashflow(@Query() dto: ReportRangeDto) {
    return this.service.cashflow(dto);
  }

  @Get('reports/trial-balance')
  @Roles('admin', 'manager', 'accountant')
  @ApiOperation({ summary: 'Trial balance per cashbox' })
  trialBalance(@Query() dto: ReportRangeDto) {
    return this.service.trialBalance(dto);
  }

  @Get('reports/general-ledger')
  @Roles('admin', 'manager', 'accountant')
  @ApiOperation({ summary: 'General ledger — paginated transactions' })
  generalLedger(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('cashbox_id') cashbox_id?: string,
    @Query('category') category?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.service.generalLedger({
      from,
      to,
      cashbox_id,
      category,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  @Get('kpis')
  @Roles('admin', 'manager', 'accountant')
  @ApiOperation({ summary: 'Accounting KPIs for dashboard' })
  kpis(
    @Query('date') date?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    // Either a single `date` or an inclusive `from`/`to` range (Cairo
    // calendar, YYYY-MM-DD). Omit everything to default to today.
    return this.service.kpis({ date, from, to });
  }
}
