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
  ],
})
export class ChartOfAccountsModule {}
