import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReservationEntity } from './entities/reservation.entity';
import { ReservationsService } from './reservations.service';
import { ReservationsController } from './reservations.controller';
// PR-FIX-IDEMPOTENCY-DEFERRED-VOID-CANCEL-ROUTES (Sprint 4 / PR-11E-bis)
// Wire the existing Redis-backed IdempotencyInterceptor + cache service
// so `@UseInterceptors(IdempotencyInterceptor)` on
// `ReservationsController.cancel` can resolve them. Same minimal
// pattern used in CashDeskModule (PR #277), ShiftsModule (PR #306),
// Stock/Purchases/StockTransfers (PR #307), ReturnsModule (PR #308),
// EmployeesModule (PR #309), AttendanceModule (this PR). PR-11E
// deferred this wiring to avoid expanding scope.
import { IdempotencyCacheService } from '../common/cache/idempotency-cache.service';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';

@Module({
  imports: [TypeOrmModule.forFeature([ReservationEntity])],
  providers: [
    ReservationsService,
    IdempotencyCacheService,
    IdempotencyInterceptor,
  ],
  controllers: [ReservationsController],
  exports: [ReservationsService],
})
export class ReservationsModule {}
