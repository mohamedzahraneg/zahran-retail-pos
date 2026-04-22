import { Module } from '@nestjs/common';
import { ChartOfAccountsService } from './chart-of-accounts.service';
import { JournalService } from './journal.service';
import { ChartOfAccountsController } from './chart-of-accounts.controller';

@Module({
  providers: [ChartOfAccountsService, JournalService],
  controllers: [ChartOfAccountsController],
  exports: [ChartOfAccountsService, JournalService],
})
export class ChartOfAccountsModule {}
