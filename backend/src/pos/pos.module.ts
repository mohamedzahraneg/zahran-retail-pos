import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InvoiceEntity } from './entities/invoice.entity';
import { PosService } from './pos.service';
import { PosController } from './pos.controller';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { NotificationsModule } from '../notifications/notifications.module';
// PR-AUDIT-IDEMPOTENCY-INTERCEPTOR-POS-INVOICE — pilot interceptor
// applied to POST /pos/invoices only in this PR.
import { IdempotencyCacheService } from '../common/cache/idempotency-cache.service';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';

@Module({
  imports: [
    TypeOrmModule.forFeature([InvoiceEntity]),
    LoyaltyModule,
    NotificationsModule,
  ],
  providers: [PosService, IdempotencyCacheService, IdempotencyInterceptor],
  controllers: [PosController],
  exports: [PosService],
})
export class PosModule {}
