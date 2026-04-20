import { Module } from '@nestjs/common';
import { CashDeskService } from './cash-desk.service';
import { CashDeskController } from './cash-desk.controller';

@Module({
  providers: [CashDeskService],
  controllers: [CashDeskController],
  exports: [CashDeskService],
})
export class CashDeskModule {}
