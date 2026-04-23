import { Module } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './dashboard.controller';
import { FinancialHealthService } from './financial-health.service';
import { FinancialDashboardController } from './financial-dashboard.controller';

@Module({
  providers: [DashboardService, FinancialHealthService],
  controllers: [DashboardController, FinancialDashboardController],
  exports: [DashboardService, FinancialHealthService],
})
export class DashboardModule {}
