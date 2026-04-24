import { Module } from '@nestjs/common';
import { AccountingController } from './accounting.controller';
import { AccountingService } from './accounting.service';
import { ExpenseApprovalService } from './approval.service';
import { CostAccountResolver } from './cost-account-resolver.service';
import { CostReconciliationService } from './cost-reconciliation.service';
import { ReclassifyTo1123Service } from './reclassify-to-1123.service';

@Module({
  controllers: [AccountingController],
  providers: [
    AccountingService,
    ExpenseApprovalService,
    CostAccountResolver,
    CostReconciliationService,
    ReclassifyTo1123Service,
  ],
  exports: [
    AccountingService,
    ExpenseApprovalService,
    CostAccountResolver,
    CostReconciliationService,
  ],
})
export class AccountingModule {}
