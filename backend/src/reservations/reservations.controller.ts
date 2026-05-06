import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ReservationsService } from './reservations.service';
import {
  AddReservationPaymentDto,
  CancelReservationDto,
  ConvertReservationDto,
  CreateReservationDto,
  ExtendReservationDto,
  ListReservationsQueryDto,
} from './dto/reservation.dto';
import { Roles, Permissions } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  JwtUser,
} from '../common/decorators/current-user.decorator';
// PR-FIX-IDEMPOTENCY-DEFERRED-VOID-CANCEL-ROUTES (Sprint 4 / PR-11E-bis)
// Opt-in Idempotency-Key support on POST /reservations/:id/cancel.
// Without the header, behavior is exactly unchanged from today.
// PR-FIX-IDEMPOTENCY-DEFERRED-APPROVE-FAMILY (Sprint 4 / PR-11F-bis)
// Extended to also protect POST /reservations/:id/payments. Same
// import; module providers already wired in PR-11E-bis.
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';

@ApiBearerAuth()
@ApiTags('reservations')
@Permissions('reservations.view')
@Controller('reservations')
export class ReservationsController {
  constructor(private readonly svc: ReservationsService) {}

  @Post()
  @Roles('admin', 'manager', 'cashier')
  @ApiOperation({ summary: 'إنشاء حجز جديد (عربون + أصناف)' })
  create(@Body() dto: CreateReservationDto, @CurrentUser() user: JwtUser) {
    return this.svc.create(dto, user.userId);
  }

  @Get()
  @ApiOperation({ summary: 'قائمة الحجوزات مع فلاتر' })
  list(@Query() q: ListReservationsQueryDto) {
    return this.svc.list(q);
  }

  @Get(':id')
  @ApiOperation({ summary: 'تفاصيل حجز واحد بكل الأصناف والدفعات والمرتجعات' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.findOne(id);
  }

  @Post(':id/payments')
  @Roles('admin', 'manager', 'cashier')
  @ApiOperation({ summary: 'إضافة قسط/دفعة على الحجز' })
  // PR-FIX-IDEMPOTENCY-DEFERRED-APPROVE-FAMILY (Sprint 4 / PR-11F-bis)
  // Multi-stage installment: INSERTs `reservation_payments` row +
  // posts JE + CT (cash/bank). Duplicate POST without retry-safety
  // creates 2 payment rows + 2 JEs + 2 CTs (overcrediting customer's
  // remaining balance and double-charging cash). Same risk profile
  // as `POST /suppliers/:id/pay` (protected in PR-11F) and
  // `POST /purchases/:id/pay` (protected in PR-11D).
  @UseInterceptors(IdempotencyInterceptor)
  addPayment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddReservationPaymentDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.addPayment(id, dto, user.userId);
  }

  @Post(':id/convert')
  @Roles('admin', 'manager', 'cashier')
  @ApiOperation({
    summary:
      'تحويل الحجز إلى فاتورة بيع كاملة (العميل استلم البضاعة ودفع الباقي)',
  })
  convert(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConvertReservationDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.convert(id, dto, user.userId);
  }

  @Post(':id/cancel')
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'إلغاء الحجز وتطبيق سياسة الاسترداد' })
  // PR-FIX-IDEMPOTENCY-DEFERRED-VOID-CANCEL-ROUTES (Sprint 4 /
  // PR-11E-bis) — multi-stage cancel: INSERTs reservation_refunds
  // row (per refund policy) + UPDATEs reservation status, which
  // triggers stock.quantity_reserved release. State-guarded by
  // `mustBeActive(id)`; HTTP interceptor adds outer race defence
  // on retry. Without an Idempotency-Key header, behavior is
  // exactly unchanged. Deferred from PR-11E because this module
  // needed new IdempotencyCacheService + IdempotencyInterceptor
  // providers (added alongside in this same PR).
  @UseInterceptors(IdempotencyInterceptor)
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelReservationDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.cancel(id, dto, user.userId);
  }

  @Patch(':id/extend')
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'تمديد تاريخ انتهاء الحجز' })
  extend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ExtendReservationDto,
  ) {
    return this.svc.extend(id, dto);
  }
}
