import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
} from 'class-validator';
import { StockService } from './stock.service';
import { Roles } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  JwtUser,
} from '../common/decorators/current-user.decorator';

class AdjustStockDto {
  @IsUUID() variant_id: string;
  @IsUUID() warehouse_id: string;
  @IsNumber() delta: number;
  @IsString() @MinLength(2) reason: string;
  @IsOptional() @IsNumber() unit_cost?: number;
}

@ApiBearerAuth()
@ApiTags('stock')
@Controller('stock')
export class StockController {
  constructor(private readonly stock: StockService) {}

  @Get('warehouses')
  warehouses() {
    return this.stock.listWarehouses();
  }

  @Get('variant/:variantId')
  forVariant(@Param('variantId') variantId: string) {
    return this.stock.getStockFor(variantId);
  }

  @Get('by-product/:productId')
  byProduct(
    @Param('productId') productId: string,
    @Query('warehouse_id') warehouseId?: string,
  ) {
    return this.stock.variantsWithStock(productId, warehouseId);
  }

  @Post('adjust')
  @Roles('admin', 'manager', 'stock_keeper')
  adjust(@Body() dto: AdjustStockDto, @CurrentUser() user: JwtUser) {
    return this.stock.adjust({ ...dto, user_id: user?.userId });
  }

  @Get('adjustments')
  listAdjustments(
    @Query('variant_id') variant_id?: string,
    @Query('warehouse_id') warehouse_id?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    return this.stock.listAdjustments({
      variant_id,
      warehouse_id,
      from,
      to,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('low')
  lowStock() {
    return this.stock.lowStock();
  }

  @Get('suggestions/reorder')
  reorder() {
    return this.stock.reorderSuggestions();
  }

  @Get('suggestions/dead')
  dead() {
    return this.stock.deadStock();
  }

  @Get('suggestions/loss')
  loss() {
    return this.stock.lossWarnings();
  }
}
