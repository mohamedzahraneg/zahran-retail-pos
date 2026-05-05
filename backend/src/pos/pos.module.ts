import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InvoiceEntity } from './entities/invoice.entity';
import { PosService } from './pos.service';
import { PosController } from './pos.controller';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { NotificationsModule } from '../notifications/notifications.module';
// PR-FIX-POS-INVOICE-EDIT-REFRESH-CLOSED-SHIFT-SNAPSHOT
// PosService.editInvoice depends on ShiftsService.refreshClosedShiftSnapshot
// to refresh the parent shift's stored close-time snapshot when an
// invoice belonging to a closed shift is edited. ShiftsService is not
// @Global, so PosModule must explicitly import ShiftsModule.
import { ShiftsModule } from '../shifts/shifts.module';
// PR-AUDIT-IDEMPOTENCY-INTERCEPTOR-POS-INVOICE — pilot interceptor
// applied to POST /pos/invoices only in this PR.
import { IdempotencyCacheService } from '../common/cache/idempotency-cache.service';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';

@Module({
  imports: [
    TypeOrmModule.forFeature([InvoiceEntity]),
    LoyaltyModule,
    NotificationsModule,
    ShiftsModule,
  ],
  providers: [PosService, IdempotencyCacheService, IdempotencyInterceptor],
  controllers: [PosController],
  exports: [PosService],
})
export class PosModule {}
