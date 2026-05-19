/**
 * InventoryController — PR-FIX-INVENTORY-API-FOUNDATION
 *
 * Read-only inventory endpoints:
 *   GET /inventory/dashboard  — totals + top-N lists for the landing
 *   GET /inventory/balances   — paginated variant × warehouse balances
 *   GET /inventory/movements  — paginated stock-movements ledger
 *
 * All three are pure SELECTs; no writes, no idempotency interceptor,
 * no engine calls. Mounted under the existing `products.view`
 * permission family — operators who can see products can see the
 * inventory dashboards built from those products. A future
 * `inventory.view` permission can replace this in one place.
 */
import { Controller, Get, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { InventoryService } from './inventory.service';
import { Permissions } from '../common/decorators/roles.decorator';

@ApiBearerAuth()
@ApiTags('inventory')
@Permissions('products.view')
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'KPIs + top-N lists for the inventory landing' })
  @ApiQuery({ name: 'branch_id', required: false, description: 'Scope KPIs and top-N lists to warehouses linked to this branch' })
  dashboard(
    @Query('branch_id', new ParseUUIDPipe({ optional: true })) branch_id?: string,
  ) {
    return this.inventory.getDashboard({ branch_id });
  }

  @Get('balances')
  @ApiOperation({
    summary:
      'Paginated variant × warehouse balances with filters (search/warehouse/category/brand/color/size/group/low_stock/out_of_stock)',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'warehouse_id', required: false })
  @ApiQuery({ name: 'category_id', required: false })
  @ApiQuery({ name: 'brand_id', required: false })
  @ApiQuery({ name: 'color_id', required: false })
  @ApiQuery({ name: 'size_id', required: false })
  @ApiQuery({ name: 'group_id', required: false, description: 'Filter to variants in this product_group' })
  @ApiQuery({ name: 'branch_id', required: false, description: 'Restrict to warehouses linked to this branch (combinable with warehouse_id)' })
  @ApiQuery({ name: 'low_stock', required: false, type: Boolean })
  @ApiQuery({ name: 'out_of_stock', required: false, type: Boolean })
  balances(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('warehouse_id', new ParseUUIDPipe({ optional: true })) warehouse_id?: string,
    @Query('category_id', new ParseUUIDPipe({ optional: true })) category_id?: string,
    @Query('brand_id', new ParseUUIDPipe({ optional: true })) brand_id?: string,
    @Query('color_id', new ParseUUIDPipe({ optional: true })) color_id?: string,
    @Query('size_id', new ParseUUIDPipe({ optional: true })) size_id?: string,
    @Query('group_id', new ParseUUIDPipe({ optional: true })) group_id?: string,
    @Query('branch_id', new ParseUUIDPipe({ optional: true })) branch_id?: string,
    @Query('low_stock') low_stock?: string,
    @Query('out_of_stock') out_of_stock?: string,
  ) {
    return this.inventory.getBalances({
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      search,
      warehouse_id,
      category_id,
      brand_id,
      color_id,
      size_id,
      group_id,
      branch_id,
      low_stock: low_stock === 'true',
      out_of_stock: out_of_stock === 'true',
    });
  }

  @Get('movements')
  @ApiOperation({
    summary:
      'Paginated stock movements with filters (variant/product/warehouse/type/direction/reference_type/date range/search)',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'variant_id', required: false })
  @ApiQuery({ name: 'product_id', required: false })
  @ApiQuery({ name: 'warehouse_id', required: false })
  @ApiQuery({ name: 'movement_type', required: false })
  @ApiQuery({ name: 'direction', required: false, enum: ['in', 'out'] })
  @ApiQuery({ name: 'reference_type', required: false })
  @ApiQuery({ name: 'date_from', required: false, type: String })
  @ApiQuery({ name: 'date_to', required: false, type: String })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'group_id', required: false, description: 'Filter to movements on variants in this product_group' })
  @ApiQuery({ name: 'branch_id', required: false, description: 'Restrict to movements on warehouses linked to this branch' })
  movements(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('variant_id', new ParseUUIDPipe({ optional: true })) variant_id?: string,
    @Query('product_id', new ParseUUIDPipe({ optional: true })) product_id?: string,
    @Query('warehouse_id', new ParseUUIDPipe({ optional: true })) warehouse_id?: string,
    @Query('movement_type') movement_type?: string,
    @Query('direction') direction?: 'in' | 'out',
    @Query('reference_type') reference_type?: string,
    @Query('date_from') date_from?: string,
    @Query('date_to') date_to?: string,
    @Query('search') search?: string,
    @Query('group_id', new ParseUUIDPipe({ optional: true })) group_id?: string,
    @Query('branch_id', new ParseUUIDPipe({ optional: true })) branch_id?: string,
  ) {
    return this.inventory.getMovements({
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      variant_id,
      product_id,
      warehouse_id,
      movement_type,
      direction,
      reference_type,
      date_from,
      date_to,
      search,
      group_id,
      branch_id,
    });
  }
}
