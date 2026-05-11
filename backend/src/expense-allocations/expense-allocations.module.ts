import { Module } from '@nestjs/common';
import { ExpenseAllocationsService } from './expense-allocations.service';
import { ExpenseAllocationsController } from './expense-allocations.controller';
import { ExpenseAllocationsReportsController } from './expense-allocations-reports.controller';

/**
 * ExpenseAllocationsModule — PR-PHASE2-B1 (read-only foundation).
 *
 * Wires the read-only periods controller + the two report controllers.
 * No write paths in this PR.  No FinancialEngine dependency.  Only
 * needs the global DataSource (provided by DatabaseModule, already
 * imported globally in AppModule).
 */
@Module({
  providers: [ExpenseAllocationsService],
  controllers: [
    ExpenseAllocationsController,
    ExpenseAllocationsReportsController,
  ],
  exports: [ExpenseAllocationsService],
})
export class ExpenseAllocationsModule {}
