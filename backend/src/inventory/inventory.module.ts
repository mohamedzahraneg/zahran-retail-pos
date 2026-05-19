/**
 * InventoryModule — PR-FIX-INVENTORY-API-FOUNDATION + PR-INVENTORY-REPORTS
 *
 * Read-only inventory APIs. No entity repositories needed (every
 * query is raw SQL via DataSource); no idempotency interceptor
 * needed (no POST/PATCH/DELETE endpoints).
 *
 * PR-INVENTORY-REPORTS adds a dedicated `inventory/reports/*` sub-
 * controller for valuation / low-stock / dead-stock / profitability.
 */
import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { InventoryReportsController } from './inventory-reports.controller';
import { InventoryReportsService } from './inventory-reports.service';

@Module({
  controllers: [InventoryController, InventoryReportsController],
  providers: [InventoryService, InventoryReportsService],
  exports: [InventoryService, InventoryReportsService],
})
export class InventoryModule {}
