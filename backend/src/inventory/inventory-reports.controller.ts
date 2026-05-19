/**
 * inventory-reports.controller.ts — PR-INVENTORY-REPORTS
 *
 * Read-only inventory analytics. Sits under /inventory/reports/*
 * so the existing legacy `/reports/stock-valuation`, `/low-stock`,
 * `/dead-stock` endpoints stay untouched (other modules consume them).
 *
 * Permissions: same `inventory.view` umbrella the rest of the new
 * inventory section uses.
 */
import { Controller, Get, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Permissions } from '../common/decorators/roles.decorator';
import { InventoryReportsService } from './inventory-reports.service';

@ApiBearerAuth()
@ApiTags('inventory-reports')
@Permissions('inventory.view')
@Controller('inventory/reports')
export class InventoryReportsController {
  constructor(private readonly svc: InventoryReportsService) {}

  // ─── valuation ──────────────────────────────────────────────────
  @Get('valuation')
  @ApiOperation({
    summary: 'تقييم المخزون (rows + totals)',
  })
  @ApiQuery({ name: 'branch_id', required: false })
  @ApiQuery({ name: 'warehouse_id', required: false })
  @ApiQuery({ name: 'group_id', required: false })
  @ApiQuery({ name: 'category_id', required: false })
  @ApiQuery({ name: 'brand_id', required: false })
  @ApiQuery({ name: 'search', required: false })
  valuation(
    @Query('branch_id', new ParseUUIDPipe({ optional: true }))
    branch_id?: string,
    @Query('warehouse_id', new ParseUUIDPipe({ optional: true }))
    warehouse_id?: string,
    @Query('group_id', new ParseUUIDPipe({ optional: true }))
    group_id?: string,
    @Query('category_id', new ParseUUIDPipe({ optional: true }))
    category_id?: string,
    @Query('brand_id', new ParseUUIDPipe({ optional: true }))
    brand_id?: string,
    @Query('search') search?: string,
  ) {
    return this.svc.valuation({
      branch_id,
      warehouse_id,
      group_id,
      category_id,
      brand_id,
      search,
    });
  }

  // ─── low / out of stock ─────────────────────────────────────────
  @Get('low-stock')
  @ApiOperation({ summary: 'تقرير النواقص (منخفض / نفد)' })
  @ApiQuery({ name: 'branch_id', required: false })
  @ApiQuery({ name: 'warehouse_id', required: false })
  @ApiQuery({ name: 'group_id', required: false })
  @ApiQuery({ name: 'category_id', required: false })
  @ApiQuery({ name: 'brand_id', required: false })
  lowStock(
    @Query('branch_id', new ParseUUIDPipe({ optional: true }))
    branch_id?: string,
    @Query('warehouse_id', new ParseUUIDPipe({ optional: true }))
    warehouse_id?: string,
    @Query('group_id', new ParseUUIDPipe({ optional: true }))
    group_id?: string,
    @Query('category_id', new ParseUUIDPipe({ optional: true }))
    category_id?: string,
    @Query('brand_id', new ParseUUIDPipe({ optional: true }))
    brand_id?: string,
  ) {
    return this.svc.lowStock({
      branch_id,
      warehouse_id,
      group_id,
      category_id,
      brand_id,
    });
  }

  // ─── dead stock ─────────────────────────────────────────────────
  @Get('dead-stock')
  @ApiOperation({ summary: 'تقرير المخزون الراكد' })
  @ApiQuery({ name: 'branch_id', required: false })
  @ApiQuery({ name: 'warehouse_id', required: false })
  @ApiQuery({ name: 'group_id', required: false })
  @ApiQuery({
    name: 'days',
    required: false,
    type: Number,
    description: 'النافذة الزمنية (افتراضي 90) — مسموح 1..365',
  })
  deadStock(
    @Query('branch_id', new ParseUUIDPipe({ optional: true }))
    branch_id?: string,
    @Query('warehouse_id', new ParseUUIDPipe({ optional: true }))
    warehouse_id?: string,
    @Query('group_id', new ParseUUIDPipe({ optional: true }))
    group_id?: string,
    @Query('days') daysRaw?: string,
  ) {
    const days = daysRaw ? Number(daysRaw) : undefined;
    return this.svc.deadStock({ branch_id, warehouse_id, group_id, days });
  }

  // ─── profitability ──────────────────────────────────────────────
  @Get('profitability')
  @ApiOperation({ summary: 'تقرير ربحية المنتجات' })
  @ApiQuery({ name: 'branch_id', required: false })
  @ApiQuery({ name: 'warehouse_id', required: false })
  @ApiQuery({ name: 'group_id', required: false })
  @ApiQuery({ name: 'date_from', required: false })
  @ApiQuery({ name: 'date_to', required: false })
  profitability(
    @Query('branch_id', new ParseUUIDPipe({ optional: true }))
    branch_id?: string,
    @Query('warehouse_id', new ParseUUIDPipe({ optional: true }))
    warehouse_id?: string,
    @Query('group_id', new ParseUUIDPipe({ optional: true }))
    group_id?: string,
    @Query('date_from') date_from?: string,
    @Query('date_to') date_to?: string,
  ) {
    return this.svc.profitability({
      branch_id,
      warehouse_id,
      group_id,
      date_from,
      date_to,
    });
  }
}
