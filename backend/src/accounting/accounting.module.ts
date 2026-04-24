import { Module } from '@nestjs/common';
import { AccountingController } from './accounting.controller';
import { AccountingService } from './accounting.service';
import { ExpenseApprovalService } from './approval.service';
import { CostAccountResolver } from './cost-account-resolver.service';
import { CostReconciliationService } from './cost-reconciliation.service';
import { ReclassifyTo1123Service } from './reclassify-to-1123.service';
import { EmployeeLedgerReset202604Service } from './employee-ledger-reset-2026-04.service';

@Module({
  controllers: [AccountingController],
  providers: [
    AccountingService,
    ExpenseApprovalService,
    CostAccountResolver,
    CostReconciliationService,
    ReclassifyTo1123Service,
    EmployeeLedgerReset202604Service,
  ],
  exports: [
    AccountingService,
    ExpenseApprovalService,
    CostAccountResolver,
    CostReconciliationService,
  ],
})
export class AccountingModule {}
