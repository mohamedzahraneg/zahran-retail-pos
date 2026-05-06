import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseInterceptors,
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
import {
  DriftHistoricalCleanupService,
  EXECUTE_CONFIRM_TOKEN,
} from './drift-historical-cleanup.service';
import { MigrationsService } from '../database/migrations.service';
import { Permissions } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  JwtUser,
} from '../common/decorators/current-user.decorator';
// PR-AUDIT-IDEMPOTENCY-JOURNAL-CREATE — opt-in idempotency on the
// only direct manual-JE creation route. Without an Idempotency-Key
// header the behavior is exactly unchanged. The sibling void /
// backfill / closeYear / etc. handlers in this controller stay
// unprotected (out of scope — most are naturally idempotent today).
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';

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

/**
 * PR-FIN-PAYACCT-4D-DRIFT-HISTORICAL-CLEANUP-1
 * Body for `POST accounts/audit/drift-cleanup/historical`.
 * dryRun=true (default) returns the candidate plan; dryRun=false +
 * matching `confirm` token executes the soft-void + cashbox_id patch.
 */
class DriftHistoricalCleanupDtoIn {
  @IsOptional() @IsBoolean() dryRun?: boolean;
  @IsOptional() @IsString() confirm?: string;
  @IsOptional() @IsBoolean() rebuildCashboxBalance?: boolean;
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
    private readonly driftCleanup: DriftHistoricalCleanupService,
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
  // PR-AUDIT-IDEMPOTENCY-JOURNAL-CREATE — seventh protected endpoint
  // after /pos/invoices (#275), /cash-desk/transfer (#277),
  // /accounting/expenses + /accounting/expenses/daily (#279),
  // /cash-desk/customer-payments (#281), and /cash-desk/supplier-
  // payments (#283). This is the ONLY direct manual-JE creation
  // path in the system — every other JE write reaches the financial
  // engine via a parent entity (invoice, expense, transfer, payment)
  // whose UUID anchors `posting.safe()`'s (reference_type, reference_id)
  // dedupe. Manual entries auto-generate a fresh reference per call,
  // so duplicate submission today produces 2 independent posted JEs.
  // Optional Idempotency-Key header — without it, today's behavior.
  // With it, replays the cached 2xx for 24h or 425/409 for concurrent /
  // payload-mismatch.
  @UseInterceptors(IdempotencyInterceptor)
  createJournal(
    @Body() dto: CreateJournalDtoIn,
    @CurrentUser() user: JwtUser,
  ) {
    return this.journal.create(dto, user.userId);
  }

  @Post('journal/:id/void')
  @Permissions('accounts.journal.void')
  // PR-FIX-IDEMPOTENCY-VOID-CANCEL-REFUND-FAMILY (Sprint 4 / PR-11E) —
  // calls `posting.reverseByReference('manual', id)` which writes one
  // reversing JE via the engine. Engine guard catches dup; HTTP
  // interceptor adds the outer cleaner UX on retry. Without an
  // Idempotency-Key header, behavior is exactly unchanged.
  @UseInterceptors(IdempotencyInterceptor)
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
  // PR-FIX-IDEMPOTENCY-APPROVE-FAMILY (Sprint 4 / PR-11F) — annual
  // one-shot that posts year-end closing JEs (large batch). A
  // duplicate POST during a network retry could double-post the
  // entire closing entry set — catastrophic. The HTTP interceptor
  // is the cleanest defence.
  @UseInterceptors(IdempotencyInterceptor)
  closeYear(
    @Body() body: { fiscal_year_end: string },
    @CurrentUser() user: JwtUser,
  ) {
    return this.posting.closeFiscalYear(body.fiscal_year_end, user.userId);
  }

  @Post('depreciation/run')
  @Permissions('accounts.depreciation')
  @ApiOperation({ summary: 'تشغيل ترحيل الإهلاك الشهري يدوياً' })
  // PR-FIX-IDEMPOTENCY-APPROVE-FAMILY (Sprint 4 / PR-11F) — monthly
  // batch that posts depreciation JEs for all fixed assets. A
  // duplicate POST doubles the depreciation expense for the month
  // — catastrophic if the admin double-clicks the run button.
  @UseInterceptors(IdempotencyInterceptor)
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

  // ──────────────────────────────────────────────────────────────────
  //  Opening balance wizard — the ONE user-facing POST kept under /audit
  //  because the wizard at /opening-balance depends on it. Everything
  //  else that used to live here (recompute-*, reset-*, dedupe-*,
  //  force-post-*, purge-*, full-cleanup, factory-reset, quick-start,
  //  run-migrations) has been removed.
  //
  //  Justification:
  //    - Destructive maintenance buttons were explicitly rejected by
  //      the product owner ("الغي الزرار وجود الزرار مش صح").
  //    - The non-destructive repairs those endpoints used to drive
  //      (dedupe, recompute-balances) now run automatically on boot
  //      via database/migrations/056_auto_accounts_repair.sql.
  //    - Idempotent financial flows (FinancialEngineService) mean
  //      "force-post" is no longer needed — every in-flight operation
  //      posts on its own path; a replay via the idempotency guard is
  //      safe but never necessary.
  //    - Running migrations manually is not something the UI should
  //      expose; the boot-time runner handles it.
  //
  //  The read-only GET /audit/* endpoints above (summary, cashboxes,
  //  invoices, expenses, payments, data-snapshot, review-report,
  //  migrations-status) are kept — those are observability, not
  //  mutations.
  // ──────────────────────────────────────────────────────────────────

  @Post('audit/opening-balance')
  @Permissions('accounts.journal.post')
  @ApiOperation({
    summary:
      'تسجيل الرصيد الافتتاحي دفعة واحدة (نقد/ذمم/موردين/مخزون/أصول → رأس المال)',
  })
  openingBalance(
    @Body()
    body: {
      entry_date: string;
      cash_in_hand?: number;
      customer_dues?: number;
      supplier_dues?: number;
      inventory_value?: number;
      fixed_assets?: number;
      capital?: number;
      cashbox_id?: string;
      notes?: string;
    },
    @CurrentUser() user: JwtUser,
  ) {
    return this.recon.postOpeningBalance(body, user.userId);
  }

  @Get('audit/data-snapshot')
  @Permissions('accounts.chart.view')
  @ApiOperation({
    summary:
      'صورة كاملة من المبيعات والمصروفات والدفعات — للتصدير كنسخة احتياطية',
  })
  dataSnapshot() {
    return this.recon.dataSnapshot();
  }

  @Get('audit/review-report')
  @Permissions('accounts.chart.view')
  @ApiOperation({
    summary:
      'تقرير مراجعة مركّز (بنود الفواتير + المصروفات + الرصيد الافتتاحي)',
  })
  reviewReport() {
    return this.recon.reviewReport();
  }

  @Get('audit/migrations')
  @Permissions('accounts.chart.view')
  @ApiOperation({ summary: 'حالة هجرات قاعدة البيانات (قراءة فقط)' })
  migrationsStatus() {
    return this.migrations.status();
  }

  // ──────────────────────────────────────────────────────────────────
  //  Reconciliation diagnostics — read-only + sanctioned rebuilds
  // ──────────────────────────────────────────────────────────────────

  @Get('audit/cash-vs-gl')
  @Permissions('accounts.chart.view')
  @ApiOperation({
    summary:
      'مقارنة رصيد كل خزنة بين ٣ مصادر: cashboxes.current_balance، سجل الحركات، دفتر الأستاذ',
  })
  cashVsGl() {
    return this.recon.compareCashVsGl();
  }

  /**
   * Rebuild `cashboxes.current_balance` from the transaction log — the
   * ONE sanctioned path that writes the column outside the engine.
   * Read-only at the logical level: it just copies the ledger sum
   * into the derived column. Migration 058's trigger allows this
   * call because the service sets `app.engine_context = 'on'`
   * inside the transaction.
   */
  @Post('audit/rebuild-cashbox-balance/:id')
  @Permissions('accounts.journal.post')
  @ApiOperation({
    summary:
      'إعادة بناء رصيد خزنة من حركاتها (يجمع في ـ خارج) ويكتب الناتج في current_balance',
  })
  rebuildCashboxBalance(@Param('id') id: string) {
    return this.recon.rebuildCashboxBalance(id);
  }

  /**
   * PR-FIN-PAYACCT-4D-DRIFT-HISTORICAL-CLEANUP-1
   *
   * Generalized cleanup of the two historical drift patterns whose
   * forward-fixes shipped in PR-FIN-PAYACCT-4D-DRIFT-ROOT-FIX-1:
   *   • Pattern A — duplicate sale `cashbox_transactions` from
   *                 historical postInvoiceEdit (soft-void duplicates)
   *   • Pattern B — return refund JE cash legs missing `cashbox_id`
   *                 (populate from returns.cashbox_id)
   *
   * Defaults to a dry run that returns the candidate plan + expected
   * drift/balance impact. Execute requires both `dryRun=false` AND
   * `confirm = "DRIFT_HISTORICAL_CLEANUP_2026_05"`.
   *
   * Detection is generalized (no hard-coded invoice/return IDs);
   * execution operates only on candidate IDs computed inside the same
   * transaction with row-level WHERE guards (idempotent).
   */
  @Post('audit/drift-cleanup/historical')
  @Permissions('accounts.journal.post')
  @ApiOperation({
    summary:
      'تنظيف عام لانحرافات الخزينة التاريخية (Pattern A + Pattern B) — dry-run افتراضيًا',
  })
  driftHistoricalCleanup(
    @Body() dto: DriftHistoricalCleanupDtoIn,
    @CurrentUser() user: JwtUser,
  ) {
    const dryRun = dto?.dryRun !== false; // default true
    if (dryRun) return this.driftCleanup.dryRun();
    return this.driftCleanup.execute({
      confirm: dto?.confirm ?? '',
      rebuildCashboxBalance: dto?.rebuildCashboxBalance,
      actorUserId: user?.userId ?? null,
    });
  }
}

// re-export so the controller's confirm-token contract is documented
// next to the route declaration above.
export { EXECUTE_CONFIRM_TOKEN as DRIFT_HISTORICAL_CLEANUP_CONFIRM };
