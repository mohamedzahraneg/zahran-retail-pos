import { Module } from '@nestjs/common';
import { CashDeskService } from './cash-desk.service';
import { CashDeskController } from './cash-desk.controller';
import { CashboxGlDriftHelper } from './cashbox-gl-drift.helper';

@Module({
  providers: [CashDeskService, CashboxGlDriftHelper],
  controllers: [CashDeskController],
  exports: [CashDeskService],
})
export class CashDeskModule {}
