import { Module } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './dashboard.controller';
import { FinancialHealthService } from './financial-health.service';
import { FinancialDashboardController } from './financial-dashboard.controller';
import { FinancialControlTowerScheduler } from './financial-control-tower.scheduler';
import { AccountingModule } from '../accounting/accounting.module';

@Module({
  imports: [AccountingModule],
  providers: [
    DashboardService,
    FinancialHealthService,
    FinancialControlTowerScheduler,
  ],
  controllers: [DashboardController, FinancialDashboardController],
  exports: [DashboardService, FinancialHealthService],
})
export class DashboardModule {}
