/**
 * inventory-reports.controller.ts — PR-INVENTORY-REPORTS
 *   + PR-USER-BRANCH-WAREHOUSE-ACCESS (warehouse_ids intersection from
 *     AccessScopeService)
 *
 * Read-only inventory analytics. Sits under /inventory/reports/*
 * so the existing legacy `/reports/stock-valuation`, `/low-stock`,
 * `/dead-stock` endpoints stay untouched (other modules consume them).
 */
import { Controller, Get, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Permissions } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  JwtUser,
} from '../common/decorators/current-user.decorator';
import { InventoryReportsService } from './inventory-reports.service';
import { AccessScopeService } from '../access-control/access-scope.service';

@ApiBearerAuth()
@ApiTags('inventory-reports')
@Permissions('inventory.view')
@Controller('inventory/reports')
export class InventoryReportsController {
  constructor(
    private readonly svc: InventoryReportsService,
    private readonly scope: AccessScopeService,
  ) {}

  private async resolveAllowed(
    user: JwtUser,
    requestedWarehouseId?: string,
  ): Promise<string[] | undefined> {
    const allowed = await this.scope.getUserWarehouseIds(user.userId, {
      role: user.role,
    });
    if (allowed === null) return undefined;
    if (!requestedWarehouseId) return allowed;
    return allowed.includes(requestedWarehouseId)
      ? [requestedWarehouseId]
      : [];
  }

  // ─── valuation ──────────────────────────────────────────────────
  @Get('valuation')
  @ApiOperation({ summary: 'تقييم المخزون (rows + totals)' })
  @ApiQuery({ name: 'branch_id', required: false })
  @ApiQuery({ name: 'warehouse_id', required: false })
  @ApiQuery({ name: 'group_id', required: false })
  @ApiQuery({ name: 'category_id', required: false })
  @ApiQuery({ name: 'brand_id', required: false })
  @ApiQuery({ name: 'search', required: false })
  async valuation(
    @CurrentUser() user: JwtUser,
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
    const warehouse_ids = await this.resolveAllowed(user, warehouse_id);
    return this.svc.valuation({
      branch_id,
      warehouse_id,
      group_id,
      category_id,
      brand_id,
      search,
      warehouse_ids,
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
  async lowStock(
    @CurrentUser() user: JwtUser,
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
    const warehouse_ids = await this.resolveAllowed(user, warehouse_id);
    return this.svc.lowStock({
      branch_id,
      warehouse_id,
      group_id,
      category_id,
      brand_id,
      warehouse_ids,
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
  async deadStock(
    @CurrentUser() user: JwtUser,
    @Query('branch_id', new ParseUUIDPipe({ optional: true }))
    branch_id?: string,
    @Query('warehouse_id', new ParseUUIDPipe({ optional: true }))
    warehouse_id?: string,
    @Query('group_id', new ParseUUIDPipe({ optional: true }))
    group_id?: string,
    @Query('days') daysRaw?: string,
  ) {
    const days = daysRaw ? Number(daysRaw) : undefined;
    const warehouse_ids = await this.resolveAllowed(user, warehouse_id);
    return this.svc.deadStock({
      branch_id,
      warehouse_id,
      group_id,
      days,
      warehouse_ids,
    });
  }

  // ─── profitability ──────────────────────────────────────────────
  @Get('profitability')
  @ApiOperation({ summary: 'تقرير ربحية المنتجات' })
  @ApiQuery({ name: 'branch_id', required: false })
  @ApiQuery({ name: 'warehouse_id', required: false })
  @ApiQuery({ name: 'group_id', required: false })
  @ApiQuery({ name: 'date_from', required: false })
  @ApiQuery({ name: 'date_to', required: false })
  async profitability(
    @CurrentUser() user: JwtUser,
    @Query('branch_id', new ParseUUIDPipe({ optional: true }))
    branch_id?: string,
    @Query('warehouse_id', new ParseUUIDPipe({ optional: true }))
    warehouse_id?: string,
    @Query('group_id', new ParseUUIDPipe({ optional: true }))
    group_id?: string,
    @Query('date_from') date_from?: string,
    @Query('date_to') date_to?: string,
  ) {
    const warehouse_ids = await this.resolveAllowed(user, warehouse_id);
    return this.svc.profitability({
      branch_id,
      warehouse_id,
      group_id,
      date_from,
      date_to,
      warehouse_ids,
    });
  }
}
