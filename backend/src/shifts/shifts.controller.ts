import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ShiftsService } from './shifts.service';
import { OpenShiftDto, CloseShiftDto } from './dto/shift.dto';
import { Roles, Permissions } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  JwtUser,
} from '../common/decorators/current-user.decorator';

@ApiBearerAuth()
@ApiTags('shifts')
@Permissions('shifts.open')
@Controller('shifts')
export class ShiftsController {
  constructor(private readonly svc: ShiftsService) {}

  @Post('open')
  @Roles('admin', 'manager', 'cashier')
  @ApiOperation({ summary: 'فتح وردية جديدة' })
  open(@Body() dto: OpenShiftDto, @CurrentUser() user: JwtUser) {
    return this.svc.open(dto, user.userId);
  }

  @Post(':id/close')
  @Roles('admin', 'manager', 'cashier')
  @ApiOperation({ summary: 'إغلاق الوردية + احتساب الفروقات' })
  close(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseShiftDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.close(id, dto, user.userId);
  }

  @Get()
  @ApiOperation({ summary: 'قائمة الورديات' })
  list(@Query('status') status?: string, @Query('user_id') userId?: string) {
    return this.svc.list(status, userId);
  }

  @Get('current')
  @ApiOperation({ summary: 'الوردية المفتوحة للمستخدم الحالي' })
  current(@CurrentUser() user: JwtUser) {
    return this.svc.currentOpen(user.userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'تفاصيل وردية' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.findOne(id);
  }

  @Get(':id/summary')
  @ApiOperation({ summary: 'ملخص مالي حي للوردية (للإقفال والمتابعة)' })
  summary(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.summary(id);
  }
}
