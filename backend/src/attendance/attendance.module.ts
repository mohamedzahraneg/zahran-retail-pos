import { Module } from '@nestjs/common';
import { AttendanceService } from './attendance.service';
import { AttendanceController } from './attendance.controller';
import { EmployeesModule } from '../employees/employees.module';
import { AccountingModule } from '../accounting/accounting.module';

@Module({
  // EmployeesModule → EmployeesService.recordSettlement (for the 213
  // portion of pay-wage) + addBonus (for bonus classification).
  // AccountingModule → AccountingService.createDailyExpense (is_advance=TRUE)
  // for the advance classification. Both paths run through
  // FinancialEngine; no new accounting logic in AttendanceService.
  imports: [EmployeesModule, AccountingModule],
  providers: [AttendanceService],
  controllers: [AttendanceController],
  exports: [AttendanceService],
})
export class AttendanceModule {}
