import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';
import { Permissions } from '../common/decorators/roles.decorator';

@ApiBearerAuth()
@ApiTags('dashboard')
@Controller('dashboard')
// Dashboard is permission-gated on dashboard.view. Admins pass via '*'.
@Permissions('dashboard.view')
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

  /**
   * Aggregate for a picked period — today / week / month / custom.
   * Returns revenue, cogs, profit, margin, expenses, returns, net, and
   * best/worst/losing products inside the same window.
   */
  @Get('analytics')
  @ApiQuery({ name: 'from', required: false, type: String })
  @ApiQuery({ name: 'to', required: false, type: String })
  analytics(@Query('from') from?: string, @Query('to') to?: string) {
    return this.dashboard.analytics(from, to);
  }

  /**
   * PR-PAY-5 — Owner dashboard payment channel totals across the
   * picked period. Read-only; defaults to today.
   */
  @Get('payment-channels')
  @ApiQuery({ name: 'from', required: false, type: String })
  @ApiQuery({ name: 'to', required: false, type: String })
  paymentChannels(@Query('from') from?: string, @Query('to') to?: string) {
    return this.dashboard.paymentChannels(from, to);
  }
}
