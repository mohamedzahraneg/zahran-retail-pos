import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';
import { Roles } from '../common/decorators/roles.decorator';

@ApiBearerAuth()
@ApiTags('dashboard')
@Controller('dashboard')
// Dashboard is readable by any authenticated user — cashiers need their daily KPIs.
@Roles('admin', 'manager', 'accountant', 'cashier', 'inventory', 'salesperson')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  overview() {
    return this.dashboard.overview();
  }

  @Get('today')
  today() {
    return this.dashboard.today();
  }

  @Get('revenue')
  @ApiQuery({ name: 'days', required: false, type: Number })
  revenue(@Query('days') days?: string) {
    return this.dashboard.revenue(days ? parseInt(days, 10) : 30);
  }

  @Get('smart-suggestions')
  smart() {
    return this.dashboard.smart();
  }

  @Get('alerts')
  alerts(@Query('limit') limit?: string) {
    return this.dashboard.alerts(limit ? parseInt(limit, 10) : 50);
  }
}
