import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CouponsService } from './coupons.service';
import {
  CreateCouponDto,
  UpdateCouponDto,
  ValidateCouponDto,
} from './dto/coupon.dto';
import { Roles, Permissions } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  JwtUser,
} from '../common/decorators/current-user.decorator';

@ApiBearerAuth()
@ApiTags('coupons')
@Permissions('coupons.view')
@Controller('coupons')
export class CouponsController {
  constructor(private readonly svc: CouponsService) {}

  @Post()
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'إنشاء كوبون جديد' })
  create(@Body() dto: CreateCouponDto, @CurrentUser() user: JwtUser) {
    return this.svc.create(dto, user.userId);
  }

  @Patch(':id')
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'تحديث كوبون' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCouponDto,
  ) {
    return this.svc.update(id, dto);
  }

  @Delete(':id')
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'تعطيل كوبون' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.remove(id);
  }

  @Get()
  @ApiOperation({ summary: 'قائمة الكوبونات' })
  list(@Query('q') q?: string, @Query('active') active?: string) {
    return this.svc.list({ q, active });
  }

  @Get(':id')
  @ApiOperation({ summary: 'تفاصيل كوبون + استخداماته' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.findOne(id);
  }

  @Post('validate')
  @ApiOperation({
    summary: 'التحقق من كوبون + حساب قيمة الخصم (يستخدمه POS)',
  })
  validate(@Body() dto: ValidateCouponDto) {
    return this.svc.validate(dto);
  }
}
