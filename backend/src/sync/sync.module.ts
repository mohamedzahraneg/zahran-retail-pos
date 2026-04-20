import { Module } from '@nestjs/common';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';
import { PosModule } from '../pos/pos.module';
import { ReturnsModule } from '../returns/returns.module';
import { ReservationsModule } from '../reservations/reservations.module';
import { CustomersModule } from '../customers/customers.module';
import { CashDeskModule } from '../cash-desk/cash-desk.module';

@Module({
  imports: [
    PosModule,
    ReturnsModule,
    ReservationsModule,
    CustomersModule,
    CashDeskModule,
  ],
  controllers: [SyncController],
  providers: [SyncService],
  exports: [SyncService],
})
export class SyncModule {}
