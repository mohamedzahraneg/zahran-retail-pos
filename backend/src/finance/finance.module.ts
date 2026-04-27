/**
 * finance.module.ts — PR-FIN-2
 *
 * Read-only Financial Dashboard module. Single endpoint
 * `GET /finance/dashboard` powered by `FinanceDashboardService`.
 *
 * No providers from other accounting modules are imported because
 * the service composes its response from raw SELECT queries against
 * the existing schema. This keeps the dependency graph flat and
 * guarantees zero risk of pulling in a write-capable provider by
 * accident.
 */

import { Module } from '@nestjs/common';
import { FinanceController } from './finance.controller';
import { FinanceDashboardService } from './finance-dashboard.service';

@Module({
  controllers: [FinanceController],
  providers: [FinanceDashboardService],
})
export class FinanceModule {}
