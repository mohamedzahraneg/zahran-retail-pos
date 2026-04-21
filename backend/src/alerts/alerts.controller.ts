import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AlertsService } from './alerts.service';
import { CreateAlertDto } from './dto/alert.dto';
import { Roles, Permissions } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  JwtUser,
} from '../common/decorators/current-user.decorator';

@ApiBearerAuth()
@ApiTags('alerts')
@Permissions('alerts.view')
@Controller('alerts')
export class AlertsController {
  constructor(private readonly svc: AlertsService) {}

  @Get()
  @ApiOperation({ summary: 'قائمة التنبيهات' })
  list(
    @CurrentUser() user: JwtUser,
    @Query('unread') unread?: string,
    @Query('unresolved') unresolved?: string,
    @Query('severity') severity?: string,
    @Query('type') type?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.list({
      userId: user.userId,
      unreadOnly: unread === 'true',
      unresolvedOnly: unresolved === 'true',
      severity,
      type,
      limit: limit ? Number(limit) : 100,
    });
  }

  @Get('counts')
  @ApiOperation({ summary: 'أعداد التنبيهات (للأيقونة)' })
  counts(@CurrentUser() user: JwtUser) {
    return this.svc.counts(user.userId);
  }

  @Post()
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'إنشاء تنبيه يدوي' })
  create(@Body() dto: CreateAlertDto) {
    return this.svc.create(dto);
  }

  @Post(':id/read')
  @ApiOperation({ summary: 'تمييز كمقروء' })
  markRead(@Param('id', ParseIntPipe) id: number) {
    return this.svc.markRead(id);
  }

  @Post('mark-all-read')
  @ApiOperation({ summary: 'تمييز الكل كمقروء' })
  markAllRead(@CurrentUser() user: JwtUser) {
    return this.svc.markAllRead(user.userId);
  }

  @Post(':id/resolve')
  @ApiOperation({ summary: 'حل التنبيه' })
  resolve(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.resolve(id, user.userId);
  }

  @Post('scan')
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'تشغيل فحص شامل لإنشاء التنبيهات التلقائية',
  })
  runScan() {
    return this.svc.runScan();
  }
}
