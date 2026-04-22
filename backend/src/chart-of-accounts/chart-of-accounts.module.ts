import { Global, Module } from '@nestjs/common';
import { ChartOfAccountsService } from './chart-of-accounts.service';
import { JournalService } from './journal.service';
import { ChartOfAccountsController } from './chart-of-accounts.controller';
import { AccountingPostingService } from './posting.service';

@Global()
@Module({
  providers: [ChartOfAccountsService, JournalService, AccountingPostingService],
  controllers: [ChartOfAccountsController],
  exports: [ChartOfAccountsService, JournalService, AccountingPostingService],
})
export class ChartOfAccountsModule {}
