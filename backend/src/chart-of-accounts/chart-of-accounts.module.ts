import { Global, Module } from '@nestjs/common';
import { ChartOfAccountsService } from './chart-of-accounts.service';
import { JournalService } from './journal.service';
import { ChartOfAccountsController } from './chart-of-accounts.controller';
import { AccountingPostingService } from './posting.service';
import { AccountingReportsService } from './reports.service';
import { FixedAssetsService } from './fixed-assets.service';

@Global()
@Module({
  providers: [
    ChartOfAccountsService,
    JournalService,
    AccountingPostingService,
    AccountingReportsService,
    FixedAssetsService,
  ],
  controllers: [ChartOfAccountsController],
  exports: [
    ChartOfAccountsService,
    JournalService,
    AccountingPostingService,
    AccountingReportsService,
    FixedAssetsService,
  ],
})
export class ChartOfAccountsModule {}
