import { Global, Module } from '@nestjs/common';
import { ChartOfAccountsService } from './chart-of-accounts.service';
import { JournalService } from './journal.service';
import { ChartOfAccountsController } from './chart-of-accounts.controller';
import { AccountingPostingService } from './posting.service';
import { AccountingReportsService } from './reports.service';

@Global()
@Module({
  providers: [
    ChartOfAccountsService,
    JournalService,
    AccountingPostingService,
    AccountingReportsService,
  ],
  controllers: [ChartOfAccountsController],
  exports: [
    ChartOfAccountsService,
    JournalService,
    AccountingPostingService,
    AccountingReportsService,
  ],
})
export class ChartOfAccountsModule {}
