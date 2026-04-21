import { Module } from '@nestjs/common';
import { RecurringExpensesService } from './recurring-expenses.service';
import { RecurringExpensesController } from './recurring-expenses.controller';
import { RecurringExpensesScheduler } from './recurring-expenses.scheduler';

@Module({
  providers: [RecurringExpensesService, RecurringExpensesScheduler],
  controllers: [RecurringExpensesController],
  exports: [RecurringExpensesService],
})
export class RecurringExpensesModule {}
