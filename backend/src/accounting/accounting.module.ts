import { Module } from '@nestjs/common';
import { AccountingController } from './accounting.controller';
import { AccountingService } from './accounting.service';
import { ExpenseApprovalService } from './approval.service';

@Module({
  controllers: [AccountingController],
  providers: [AccountingService, ExpenseApprovalService],
  exports: [AccountingService, ExpenseApprovalService],
})
export class AccountingModule {}
