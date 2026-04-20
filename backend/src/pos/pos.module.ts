import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InvoiceEntity } from './entities/invoice.entity';
import { PosService } from './pos.service';
import { PosController } from './pos.controller';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([InvoiceEntity]),
    LoyaltyModule,
    NotificationsModule,
  ],
  providers: [PosService],
  controllers: [PosController],
  exports: [PosService],
})
export class PosModule {}
