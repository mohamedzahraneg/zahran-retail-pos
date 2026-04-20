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
} from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ProductsService } from './products.service';
import {
  CreateProductDto,
  CreateVariantDto,
  UpdateProductDto,
  UpdateVariantDto,
} from './dto/product.dto';
import { Roles } from '../common/decorators/roles.decorator';

@ApiBearerAuth()
@ApiTags('products')
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
  lookup(@Param('code') code: string) {
    return this.products.findByBarcode(code);
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
