import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ReturnsAnalyticsService } from './returns-analytics.service';
import { Roles, Permissions } from '../common/decorators/roles.decorator';

@ApiBearerAuth()
@ApiTags('returns-analytics')
@Permissions('returns.view')
@Controller('returns/analytics')
export class ReturnsAnalyticsController {
  constructor(private readonly svc: ReturnsAnalyticsService) {}

  @Get()
  @Roles('admin', 'manager', 'accountant')
  @ApiOperation({ summary: 'كل بيانات التحليل (ملخّص، أسباب، أعلى المنتجات، اتجاه)' })
  all() {
    return this.svc.all();
  }

  @Get('summary')
  @Roles('admin', 'manager', 'accountant')
  @ApiOperation({ summary: 'ملخّص KPIs للمرتجعات' })
  summary() {
    return this.svc.summary();
  }

  @Get('by-reason')
  @Roles('admin', 'manager', 'accountant')
  @ApiOperation({ summary: 'تفصيل المرتجعات حسب السبب' })
  byReason() {
    return this.svc.byReason();
  }

  @Get('top-products')
  @Roles('admin', 'manager', 'accountant')
  @ApiOperation({ summary: 'أعلى المنتجات مرتجعة' })
  topProducts(@Query('limit') limit?: string) {
    return this.svc.topProducts(limit ? parseInt(limit, 10) : 20);
  }

  @Get('trend')
  @Roles('admin', 'manager', 'accountant')
  @ApiOperation({ summary: 'اتجاه المرتجعات (يومي أو شهري)' })
  trend(@Query('granularity') granularity?: 'daily' | 'monthly') {
    return this.svc.trend(granularity || 'monthly');
  }

  @Get('by-condition')
  @Roles('admin', 'manager', 'accountant')
  @ApiOperation({ summary: 'تفصيل حسب حالة المنتج المرتجع' })
  byCondition() {
    return this.svc.byCondition();
  }

  @Get('widget')
  @ApiOperation({ summary: 'بيانات مختصرة لويدجت الداشبورد' })
  widget(@Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.widget({ from, to });
  }
}
