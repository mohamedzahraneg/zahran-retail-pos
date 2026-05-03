/**
 * finance.module.ts — PR-FIN-2 + PR-FIN-DASHBOARD-DRIFT-CANCEL-AWARE
 *
 * Read-only Financial Dashboard module. Single endpoint
 * `GET /finance/dashboard` powered by `FinanceDashboardService`.
 *
 * No write-capable providers from other accounting modules are
 * imported. The service composes its response from raw SELECT
 * queries against the existing schema.
 *
 * PR-FIN-DASHBOARD-DRIFT-CANCEL-AWARE — `CashboxGlDriftHelper` is a
 * stateless, read-only helper that the cash-desk module already
 * uses to subtract phantom drift from cancelled-return clusters
 * (PR #246). The dashboard's `health()` card needs the same
 * cancel-aware normalization so the "فروق تصنيف مراجع" KPI no
 * longer overstates reality. We register the helper as a local
 * provider here (rather than importing CashDeskModule) to keep
 * the dependency graph flat — no write-capable services pulled in.
 */

import { Module } from '@nestjs/common';
import { FinanceController } from './finance.controller';
import { FinanceDashboardService } from './finance-dashboard.service';
import { StatementsController } from './statements.controller';
import { StatementsService } from './statements.service';
import { CashboxGlDriftHelper } from '../cash-desk/cashbox-gl-drift.helper';

@Module({
  controllers: [FinanceController, StatementsController],
  providers: [FinanceDashboardService, StatementsService, CashboxGlDriftHelper],
})
export class FinanceModule {}
