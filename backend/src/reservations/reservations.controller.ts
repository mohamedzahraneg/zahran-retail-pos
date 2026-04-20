import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
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
import { Roles } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  JwtUser,
} from '../common/decorators/current-user.decorator';

@ApiBearerAuth()
@ApiTags('reservations')
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
