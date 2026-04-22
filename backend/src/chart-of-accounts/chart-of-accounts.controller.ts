import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MinLength,
  IsUUID,
  IsDateString,
  Min,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';

import { ChartOfAccountsService } from './chart-of-accounts.service';
import {
  JournalService,
  CreateJournalEntryDto,
} from './journal.service';
import { AccountingPostingService } from './posting.service';
import { AccountingReportsService } from './reports.service';
import { FixedAssetsService, FixedAssetDto } from './fixed-assets.service';
import { AccountingAnalyticsService } from './analytics.service';
import {
  BudgetsService,
  CreateBudgetDto,
} from './budgets.service';
import {
  CostCentersService,
  CreateCostCenterDto,
} from './cost-centers.service';
import { FxService, UpsertRateDto } from './fx.service';
import { ReconciliationService } from './reconciliation.service';
import { MigrationsService } from '../database/migrations.service';
import { Permissions } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  JwtUser,
} from '../common/decorators/current-user.decorator';

const ACC_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;
const NORMAL_BAL = ['debit', 'credit'] as const;

class CreateAccountDtoIn {
  @IsString() @MinLength(1) code: string;
  @IsString() @MinLength(1) name_ar: string;
  @IsOptional() @IsString() name_en?: string;
  @IsEnum(ACC_TYPES) account_type: (typeof ACC_TYPES)[number];
  @IsOptional() @IsEnum(NORMAL_BAL) normal_balance?: (typeof NORMAL_BAL)[number];
  @IsOptional() @IsUUID() parent_id?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsUUID() cashbox_id?: string;
}

class UpdateAccountDtoIn {
  @IsOptional() @IsString() name_ar?: string;
  @IsOptional() @IsString() name_en?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsUUID() cashbox_id?: string | null;
  @IsOptional() @IsNumber() sort_order?: number;
}

class JournalLineDtoIn {
  @IsUUID() account_id: string;
  @IsOptional() @IsNumber() @Min(0) debit?: number;
  @IsOptional() @IsNumber() @Min(0) credit?: number;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsUUID() cashbox_id?: string;
  @IsOptional() @IsUUID() warehouse_id?: string;
}

class CreateJournalDtoIn implements CreateJournalEntryDto {
  @IsDateString() entry_date: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() reference_type?: string;
  @IsOptional() @IsUUID() reference_id?: string;
  @IsArray() @ArrayMinSize(2)
  @ValidateNested({ each: true }) @Type(() => JournalLineDtoIn)
  lines: JournalLineDtoIn[];
  @IsOptional() @IsBoolean() post_immediately?: boolean;
}

class VoidJournalDtoIn {
  @IsString() @MinLength(3) reason: string;
}

@ApiBearerAuth()
@ApiTags('accounts')
@Controller('accounts')
export class ChartOfAccountsController {
  constructor(
    private readonly coa: ChartOfAccountsService,
    private readonly journal: JournalService,
    private readonly posting: AccountingPostingService,
    private readonly reports: AccountingReportsService,
    private readonly fixedAssets: FixedAssetsService,
    private readonly analytics: AccountingAnalyticsService,
    private readonly budgets: BudgetsService,
    private readonly costCenters: CostCentersService,
    private readonly fx: FxService,
    private readonly recon: ReconciliationService,
    private readonly migrations: MigrationsService,
  ) {}

  // ── Chart of Accounts ──────────────────────────────────────────────

  @Get('chart')
  @Permissions('accounts.chart.view')
  @ApiOperation({ summary: 'شجرة الحسابات' })
  list(@Query('include_inactive') includeInactive?: string) {
    return this.coa.list(includeInactive === 'true' || includeInactive === '1');
  }

  @Get('chart/trial-balance')
  @Permissions('accounts.chart.view')
  @ApiOperation({ summary: 'ميزان المراجعة' })
  trialBalance() {
    return this.coa.trialBalance();
  }

  @Get('chart/:id')
  @Permissions('accounts.chart.view')
  get(@Param('id') id: string) {
    return this.coa.get(id);
  }

  @Post('chart')
  @Permissions('accounts.chart.manage')
  create(@Body() dto: CreateAccountDtoIn, @CurrentUser() user: JwtUser) {
    return this.coa.create(dto, user.userId);
  }

  @Patch('chart/:id')
  @Permissions('accounts.chart.manage')
  update(@Param('id') id: string, @Body() dto: UpdateAccountDtoIn) {
    return this.coa.update(id, dto);
  }

  @Delete('chart/:id')
  @Permissions('accounts.chart.manage')
  remove(@Param('id') id: string) {
    return this.coa.remove(id);
  }

  // ── Journal Entries ────────────────────────────────────────────────

  @Get('journal')
  @Permissions('accounts.journal.view')
  @ApiOperation({ summary: 'قائمة القيود اليومية' })
  listJournal(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('is_posted') is_posted?: string,
    @Query('is_void') is_void?: string,
    @Query('reference_type') reference_type?: string,
    @Query('account_id') account_id?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.journal.list({
      from,
      to,
      is_posted:
        is_posted === undefined
          ? undefined
          : is_posted === 'true' || is_posted === '1',
      is_void:
        is_void === undefined
          ? undefined
          : is_void === 'true' || is_void === '1',
      reference_type,
      account_id,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  @Get('journal/:id')
  @Permissions('accounts.journal.view')
  getJournal(@Param('id') id: string) {
    return this.journal.get(id);
  }

  @Post('journal')
  @Permissions('accounts.journal.post')
  createJournal(
    @Body() dto: CreateJournalDtoIn,
    @CurrentUser() user: JwtUser,
  ) {
    return this.journal.create(dto, user.userId);
  }

  @Post('journal/:id/void')
  @Permissions('accounts.journal.void')
  voidJournal(
    @Param('id') id: string,
    @Body() dto: VoidJournalDtoIn,
    @CurrentUser() user: JwtUser,
  ) {
    return this.journal.void(id, user.userId, dto.reason);
  }

  @Post('journal/backfill')
  @Permissions('accounts.journal.post')
  @ApiOperation({
    summary: 'ترحيل تلقائي لكل العمليات القديمة التي لم يتم ترحيلها',
  })
  backfill(
    @Body() body: { since?: string },
    @CurrentUser() user: JwtUser,
  ) {
    return this.posting.backfill({
      since: body?.since,
      userId: user.userId,
    });
  }

  // ── Reports ─────────────────────────────────────────────────────────

  @Get('chart/:id/ledger')
  @Permissions('accounts.chart.view')
  @ApiOperation({ summary: 'كشف حساب — كل قيود حساب معين' })
  accountLedger(
    @Param('id') id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reports.accountLedger(id, from, to);
  }

  @Get('reports/income-statement')
  @Permissions('accounts.chart.view')
  @ApiOperation({ summary: 'قائمة الدخل' })
  incomeStatement(@Query('from') from: string, @Query('to') to: string) {
    return this.reports.incomeStatement(from, to);
  }

  @Get('reports/balance-sheet')
  @Permissions('accounts.chart.view')
  @ApiOperation({ summary: 'الميزانية العمومية' })
  balanceSheet(@Query('as_of') as_of: string) {
    return this.reports.balanceSheet(as_of);
  }

  @Get('reports/aging')
  @Permissions('accounts.chart.view')
  @ApiOperation({ summary: 'تقرير أعمار الديون' })
  aging(
    @Query('type') type: 'receivable' | 'payable' = 'receivable',
    @Query('as_of') as_of?: string,
  ) {
    return this.reports.aging(
      type === 'payable' ? 'payable' : 'receivable',
      as_of,
    );
  }

  @Get('reports/customer-ledger/:id')
  @Permissions('accounts.chart.view')
  @ApiOperation({ summary: 'كشف حساب عميل' })
  customerLedger(
    @Param('id') id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reports.customerLedger(id, from, to);
  }

  @Get('reports/supplier-ledger/:id')
  @Permissions('accounts.chart.view')
  @ApiOperation({ summary: 'كشف حساب مورد' })
  supplierLedger(
    @Param('id') id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reports.supplierLedger(id, from, to);
  }

  @Post('close-year')
  @Permissions('accounts.close_year')
  @ApiOperation({ summary: 'إقفال السنة المالية' })
  closeYear(
    @Body() body: { fiscal_year_end: string },
    @CurrentUser() user: JwtUser,
  ) {
    return this.posting.closeFiscalYear(body.fiscal_year_end, user.userId);
  }

  @Post('depreciation/run')
  @Permissions('accounts.depreciation')
  @ApiOperation({ summary: 'تشغيل ترحيل الإهلاك الشهري يدوياً' })
  runDepreciation(@CurrentUser() user: JwtUser) {
    return this.posting.postMonthlyDepreciation(user.userId);
  }

  // ── Fixed asset schedules ────────────────────────────────────────────

  @Get('fixed-assets')
  @Permissions('accounts.depreciation')
  listFixedAssets() {
    return this.fixedAssets.list();
  }

  @Post('fixed-assets')
  @Permissions('accounts.depreciation')
  createFixedAsset(
    @Body() dto: FixedAssetDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.fixedAssets.create(dto, user.userId);
  }

  @Patch('fixed-assets/:id')
  @Permissions('accounts.depreciation')
  updateFixedAsset(
    @Param('id') id: string,
    @Body() dto: Partial<FixedAssetDto & { is_active: boolean }>,
  ) {
    return this.fixedAssets.update(id, dto);
  }

  @Delete('fixed-assets/:id')
  @Permissions('accounts.depreciation')
  removeFixedAsset(@Param('id') id: string) {
    return this.fixedAssets.remove(id);
  }

  // ── Analytics ────────────────────────────────────────────────────────

  @Get('analytics/daily-performance')
  @Permissions('accounts.chart.view')
  dailyPerformance(@Query('from') from: string, @Query('to') to: string) {
    return this.analytics.dailyPerformance({ from, to });
  }

  @Get('analytics/hourly-heatmap')
  @Permissions('accounts.chart.view')
  hourlyHeatmap(@Query('from') from: string, @Query('to') to: string) {
    return this.analytics.hourlyHeatmap({ from, to });
  }

  @Get('analytics/top-products')
  @Permissions('accounts.chart.view')
  topProducts(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('limit') limit?: string,
  ) {
    return this.analytics.topProducts({
      from,
      to,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('analytics/top-customers')
  @Permissions('accounts.chart.view')
  topCustomers(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('limit') limit?: string,
  ) {
    return this.analytics.topCustomers({
      from,
      to,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('analytics/top-salespeople')
  @Permissions('accounts.chart.view')
  topSalespeople(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('limit') limit?: string,
  ) {
    return this.analytics.topSalespeople({
      from,
      to,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('analytics/expense-breakdown')
  @Permissions('accounts.chart.view')
  expenseBreakdown(@Query('from') from: string, @Query('to') to: string) {
    return this.analytics.expenseBreakdown({ from, to });
  }

  @Get('analytics/indicators')
  @Permissions('accounts.chart.view')
  indicators(@Query('from') from: string, @Query('to') to: string) {
    return this.analytics.smartIndicators({ from, to });
  }

  @Get('analytics/recommendations')
  @Permissions('accounts.chart.view')
  recommendations(@Query('from') from: string, @Query('to') to: string) {
    return this.analytics.smartRecommendations({ from, to });
  }

  @Get('analytics/cashflow-waterfall')
  @Permissions('accounts.chart.view')
  cashflowWaterfall(
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.analytics.cashFlowWaterfall({ from, to });
  }

  // ── VAT return ──────────────────────────────────────────────────────

  @Get('reports/vat-return')
  @Permissions('accounts.chart.view')
  @ApiOperation({ summary: 'إقرار ضريبة القيمة المضافة' })
  vatReturn(@Query('from') from: string, @Query('to') to: string) {
    return this.analytics.vatReturn({ from, to });
  }

  @Post('reports/trial-balance-comparison')
  @Permissions('accounts.chart.view')
  @ApiOperation({ summary: 'ميزان مراجعة مقارن (فترات متعددة)' })
  trialBalanceComparison(
    @Body()
    body: { periods: Array<{ from: string; to: string; label: string }> },
  ) {
    return this.reports.trialBalanceComparison(body.periods || []);
  }

  // ── Budgets ─────────────────────────────────────────────────────────

  @Get('budgets')
  @Permissions('accounts.budget')
  listBudgets() {
    return this.budgets.list();
  }

  @Get('budgets/:id')
  @Permissions('accounts.budget')
  getBudget(@Param('id') id: string) {
    return this.budgets.get(id);
  }

  @Post('budgets')
  @Permissions('accounts.budget')
  createBudget(
    @Body() dto: CreateBudgetDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.budgets.create(dto, user.userId);
  }

  @Patch('budgets/:id')
  @Permissions('accounts.budget')
  updateBudget(
    @Param('id') id: string,
    @Body()
    dto: {
      name_ar?: string;
      is_active?: boolean;
      lines?: Array<{ account_id: string; month: number; amount: number }>;
    },
  ) {
    return this.budgets.update(id, dto);
  }

  @Delete('budgets/:id')
  @Permissions('accounts.budget')
  removeBudget(@Param('id') id: string) {
    return this.budgets.remove(id);
  }

  @Delete('budgets/:id/lines/:lineId')
  @Permissions('accounts.budget')
  removeBudgetLine(@Param('id') id: string, @Param('lineId') lineId: string) {
    return this.budgets.removeLine(id, lineId);
  }

  @Get('budgets/:id/variance')
  @Permissions('accounts.budget')
  @ApiOperation({ summary: 'موازنة vs فعلي' })
  budgetVariance(
    @Param('id') id: string,
    @Query('cost_center_id') cost_center_id?: string,
  ) {
    return this.budgets.variance(id, { cost_center_id });
  }

  // ── Cost Centers ────────────────────────────────────────────────────

  @Get('cost-centers')
  @Permissions('accounts.chart.view')
  listCostCenters(@Query('include_inactive') inc?: string) {
    return this.costCenters.list(inc === 'true' || inc === '1');
  }

  @Post('cost-centers')
  @Permissions('accounts.cost_centers')
  createCostCenter(@Body() dto: CreateCostCenterDto) {
    return this.costCenters.create(dto);
  }

  @Patch('cost-centers/:id')
  @Permissions('accounts.cost_centers')
  updateCostCenter(
    @Param('id') id: string,
    @Body() dto: Partial<CreateCostCenterDto> & { is_active?: boolean },
  ) {
    return this.costCenters.update(id, dto);
  }

  @Delete('cost-centers/:id')
  @Permissions('accounts.cost_centers')
  removeCostCenter(@Param('id') id: string) {
    return this.costCenters.remove(id);
  }

  // ── FX ────────────────────────────────────────────────────────────

  @Get('fx/rates')
  @Permissions('accounts.chart.view')
  listRates(
    @Query('currency') currency?: string,
    @Query('limit') limit?: string,
  ) {
    return this.fx.list(currency, limit ? Number(limit) : undefined);
  }

  @Post('fx/rates')
  @Permissions('accounts.fx')
  upsertRate(@Body() dto: UpsertRateDto, @CurrentUser() user: JwtUser) {
    return this.fx.upsert(dto, user.userId);
  }

  @Delete('fx/rates/:id')
  @Permissions('accounts.fx')
  removeRate(@Param('id') id: string) {
    return this.fx.remove(id);
  }

  @Post('fx/revalue')
  @Permissions('accounts.fx')
  @ApiOperation({ summary: 'إعادة تقييم العملات الأجنبية' })
  revalue(
    @Body() body: { as_of: string },
    @CurrentUser() user: JwtUser,
  ) {
    return this.fx.revalue(body.as_of, user.userId);
  }

  // ── Reconciliation / audit ───────────────────────────────────────────

  @Get('audit/summary')
  @Permissions('accounts.chart.view')
  @ApiOperation({ summary: 'ملخص انحرافات الحسابات' })
  auditSummary() {
    return this.recon.summary();
  }

  @Get('audit/cashboxes')
  @Permissions('accounts.chart.view')
  auditCashboxes() {
    return this.recon.auditCashboxes();
  }

  @Get('audit/invoices')
  @Permissions('accounts.chart.view')
  auditInvoices(@Query('limit') limit?: string) {
    return this.recon.auditInvoices(limit ? Number(limit) : undefined);
  }

  @Get('audit/expenses')
  @Permissions('accounts.chart.view')
  auditExpenses(@Query('limit') limit?: string) {
    return this.recon.auditExpenses(limit ? Number(limit) : undefined);
  }

  @Get('audit/payments')
  @Permissions('accounts.chart.view')
  auditPayments(@Query('limit') limit?: string) {
    return this.recon.auditPayments(limit ? Number(limit) : undefined);
  }

  @Post('audit/recompute-cashbox/:id')
  @Permissions('accounts.journal.post')
  @ApiOperation({ summary: 'إعادة حساب رصيد خزنة من حركاتها' })
  recomputeCashbox(@Param('id') id: string) {
    return this.recon.recomputeCashboxBalance(id);
  }

  @Post('audit/recompute-cashboxes')
  @Permissions('accounts.journal.post')
  recomputeAllCashboxes() {
    return this.recon.recomputeAllCashboxes();
  }

  @Post('audit/reset-auto-entries')
  @Permissions('accounts.journal.void')
  @ApiOperation({
    summary:
      'إلغاء كل القيود التلقائية لإعادة بنائها — خطر، استخدم مع الـ backfill',
  })
  resetAutoEntries() {
    return this.recon.resetAutoPostedEntries();
  }

  @Post('audit/purge-cancelled')
  @Permissions('accounts.journal.void')
  @ApiOperation({
    summary:
      'حذف نهائي للفواتير الملغاة + قيودها + حركات الخزنة المرتبطة',
  })
  purgeCancelled() {
    return this.recon.purgeCancelledInvoices();
  }

  @Post('audit/force-post-expenses')
  @Permissions('accounts.journal.post')
  @ApiOperation({
    summary:
      'ترحيل قسري لكل المصروفات المعتمدة التي لم يتم ترحيلها مع تشخيص الأخطاء',
  })
  forcePostExpenses(@CurrentUser() user: JwtUser) {
    return this.recon.forcePostApprovedExpenses(this.posting, user.userId);
  }

  @Post('audit/force-post-invoices')
  @Permissions('accounts.journal.post')
  @ApiOperation({
    summary: 'ترحيل قسري لكل الفواتير التي لم يتم ترحيلها',
  })
  forcePostInvoices(@CurrentUser() user: JwtUser) {
    return this.recon.forcePostInvoices(this.posting, user.userId);
  }

  @Post('audit/dedupe-cashbox')
  @Permissions('accounts.journal.post')
  @ApiOperation({
    summary:
      'إزالة الحركات المكررة في cashbox_transactions (نفس الفاتورة/المصروف مسجّل مرتين)',
  })
  dedupeCashbox() {
    return this.recon.dedupeCashboxTransactions();
  }

  @Post('audit/full-cleanup')
  @Permissions('accounts.journal.void')
  @ApiOperation({
    summary:
      'تنظيف شامل: حذف الملغاة + مسح كل قيود GL + توحيد الخزائن + إزالة التكرارات + ترحيل + إعادة حساب',
  })
  fullCleanup(@CurrentUser() user: JwtUser) {
    return this.recon.fullCleanup({
      posting: this.posting,
      userId: user.userId,
    });
  }

  // ── Migrations ──────────────────────────────────────────────────────

  @Get('audit/migrations')
  @Permissions('accounts.chart.view')
  @ApiOperation({ summary: 'حالة هجرات قاعدة البيانات' })
  migrationsStatus() {
    return this.migrations.status();
  }

  @Post('audit/run-migrations')
  @Permissions('accounts.journal.post')
  @ApiOperation({
    summary: 'تشغيل الهجرات المعلّقة يدوياً',
  })
  runMigrations() {
    return this.migrations.runPending();
  }
}
