import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ProductsService } from './products.service';
import {
  ApplyVariantPricesDto,
  CreateProductDto,
  CreateVariantDto,
  SmartPricingApplyDto,
  SmartPricingPreviewDto,
  UpdateProductDto,
  UpdateVariantDto,
} from './dto/product.dto';
import { Roles, Permissions } from '../common/decorators/roles.decorator';

@ApiBearerAuth()
@ApiTags('products')
@Permissions('products.view')
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  @ApiQuery({ name: 'type', required: false, enum: ['shoe', 'bag', 'accessory'] })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'active', required: false, type: Boolean })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'warehouse_id', required: false })
  @ApiQuery({ name: 'category_id', required: false })
  list(
    @Query('type') type?: 'shoe' | 'bag' | 'accessory',
    @Query('q') q?: string,
    @Query('active') active?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('warehouse_id') warehouse_id?: string,
    @Query('category_id') category_id?: string,
  ) {
    return this.products.findAll({
      type,
      q,
      active: active === undefined ? undefined : active === 'true',
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      warehouse_id,
      category_id,
    });
  }

  @Get('barcode/:code')
  @ApiQuery({ name: 'warehouse_id', required: false })
  // PR-POS-STOCK-1 — `warehouse_id` is optional; when supplied the
  // service LEFT JOINs `stock` and returns `available_stock` for the
  // matched variant in that warehouse so the POS Enter / scanner /
  // image-scan path can refuse out-of-stock adds in one round-trip.
  lookup(
    @Param('code') code: string,
    @Query('warehouse_id') warehouse_id?: string,
  ) {
    return this.products.findByBarcode(code, warehouse_id);
  }

  @Get('catalog/colors')
  colors() {
    return this.products.listColors();
  }

  @Get('catalog/sizes')
  sizes() {
    return this.products.listSizes();
  }

  @Get('catalog/next-sku')
  nextProductSku(@Query('type') type?: string) {
    return this.products.previewProductSku(type || 'other');
  }

  @Get('catalog/next-variant-sku')
  nextVariantSku(
    @Query('product_id', ParseUUIDPipe) product_id: string,
    @Query('color_id', ParseUUIDPipe) color_id: string,
    @Query('size_id') size_id?: string,
  ) {
    return this.products.previewVariantSku(
      product_id,
      color_id,
      size_id || null,
    );
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.products.findOne(id);
  }

  @Get(':id/variants')
  variants(@Param('id', ParseUUIDPipe) id: string) {
    return this.products.listVariants(id);
  }

  @Post()
  @Roles('admin', 'manager')
  create(@Body() dto: CreateProductDto) {
    return this.products.create(dto);
  }

  @Post('variants')
  @Roles('admin', 'manager')
  addVariant(@Body() dto: CreateVariantDto) {
    return this.products.addVariant(dto);
  }

  // ─── PR-PURCHASES-P3.2 — manual apply suggested sale price ──────────
  // Gated by the `products.price_change` permission slug (registered in
  // settings since the role-permission framework went live). Pricing-
  // only: updates product_variants.selling_price + inserts an audit row
  // per change. Never touches accounting / cashbox / stock / POS.
  @Post('variants/apply-prices')
  @Permissions('products.price_change')
  applyVariantPrices(
    @Body() dto: ApplyVariantPricesDto,
    @Req() req: any,
  ) {
    return this.products.applyVariantPrices(dto, req.user?.userId);
  }

  // ─── PR-PURCHASES-P3.5A — Smart Bulk Pricing Assistant ─────────────
  // Pricing-only by design:
  //   · Preview is read-only — open to authenticated callers under the
  //     existing class-level @Permissions('products.view').
  //   · Apply mutates only product_variants.selling_price + inserts
  //     variant_price_history audit rows — gated by
  //     @Permissions('products.price_change').
  // Never touches accounting / cashbox / stock / POS / purchases.
  // Cost adjustment is explicitly deferred to P3.5B.
  @Post('variants/smart-pricing/preview')
  smartPricingPreview(@Body() dto: SmartPricingPreviewDto) {
    return this.products.smartPricingPreview(dto);
  }

  @Post('variants/smart-pricing/apply')
  @Permissions('products.price_change')
  smartPricingApply(
    @Body() dto: SmartPricingApplyDto,
    @Req() req: any,
  ) {
    return this.products.smartPricingApply(dto, req.user?.userId);
  }

  @Patch('variants/:id')
  @Roles('admin', 'manager')
  updateVariant(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateVariantDto,
  ) {
    return this.products.updateVariant(id, dto);
  }

  @Delete('variants/:id')
  @Roles('admin', 'manager')
  removeVariant(@Param('id', ParseUUIDPipe) id: string) {
    return this.products.removeVariant(id);
  }

  @Patch(':id')
  @Roles('admin', 'manager')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.products.update(id, dto);
  }

  @Delete(':id')
  @Roles('admin', 'manager')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.products.remove(id);
  }
}
