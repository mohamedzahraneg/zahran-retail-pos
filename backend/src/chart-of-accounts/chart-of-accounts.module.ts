import { Global, Module } from '@nestjs/common';
import { ChartOfAccountsService } from './chart-of-accounts.service';
import { JournalService } from './journal.service';
import { ChartOfAccountsController } from './chart-of-accounts.controller';
import { AccountingPostingService } from './posting.service';
import { AccountingReportsService } from './reports.service';
import { FixedAssetsService } from './fixed-assets.service';
import { AccountingAnalyticsService } from './analytics.service';
import { BudgetsService } from './budgets.service';
import { CostCentersService } from './cost-centers.service';
import { FxService } from './fx.service';
import { ReconciliationService } from './reconciliation.service';
import { FinancialEngineService } from './financial-engine.service';
import { DriftHistoricalCleanupService } from './drift-historical-cleanup.service';
// PR-AUDIT-IDEMPOTENCY-JOURNAL-CREATE — reuse the same Redis-backed
// interceptor + cache shipped in PR #275 (POS) / #277 (cash-desk
// transfer) / #279 (accounting expenses) / #281 (customer-payments) /
// #283 (supplier-payments). Registered as providers here so the
// @UseInterceptors decorator on createJournal() can resolve them.
// No CommonModule refactor in this PR (minimal scope).
import { IdempotencyCacheService } from '../common/cache/idempotency-cache.service';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';

@Global()
@Module({
  providers: [
    ChartOfAccountsService,
    JournalService,
    AccountingPostingService,
    AccountingReportsService,
    FixedAssetsService,
    AccountingAnalyticsService,
    BudgetsService,
    CostCentersService,
    FxService,
    ReconciliationService,
    FinancialEngineService,
    DriftHistoricalCleanupService,
    IdempotencyCacheService,
    IdempotencyInterceptor,
  ],
  controllers: [ChartOfAccountsController],
  exports: [
    ChartOfAccountsService,
    JournalService,
    AccountingPostingService,
    AccountingReportsService,
    FixedAssetsService,
    AccountingAnalyticsService,
    BudgetsService,
    CostCentersService,
    FxService,
    ReconciliationService,
    FinancialEngineService,
    DriftHistoricalCleanupService,
  ],
})
export class ChartOfAccountsModule {}
