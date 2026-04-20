import { Module } from '@nestjs/common';
import { RecurringExpensesService } from './recurring-expenses.service';
import { RecurringExpensesController } from './recurring-expenses.controller';

@Module({
  providers: [RecurringExpensesService],
  controllers: [RecurringExpensesController],
  exports: [RecurringExpensesService],
})
export class RecurringExpensesModule {}
