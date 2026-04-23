import { Module } from '@nestjs/common';
import { EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';
import { PayrollController } from './payroll.controller';

@Module({
  // PayrollController shares the same module as EmployeesController
  // (no new module — extends existing per user constraint).
  controllers: [EmployeesController, PayrollController],
  providers: [EmployeesService],
  exports: [EmployeesService],
})
export class EmployeesModule {}
