import { Module } from '@nestjs/common';
import { AccountingController } from './accounting.controller';
import { AccountingService } from './accounting.service';
import { ExpenseApprovalService } from './approval.service';
import { CostAccountResolver } from './cost-account-resolver.service';
import { CostReconciliationService } from './cost-reconciliation.service';

@Module({
  controllers: [AccountingController],
  providers: [
    AccountingService,
    ExpenseApprovalService,
    CostAccountResolver,
    CostReconciliationService,
  ],
  exports: [
    AccountingService,
    ExpenseApprovalService,
    CostAccountResolver,
    CostReconciliationService,
  ],
})
export class AccountingModule {}
