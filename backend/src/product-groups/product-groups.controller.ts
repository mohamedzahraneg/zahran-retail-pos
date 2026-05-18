/**
 * product-groups.controller.ts — PR-P9.1a
 *
 * Manual product-groups CRUD + membership routes.
 *
 * Auth pattern matches the broader catalog: class-level
 * `@Permissions('products.view')` gates the read routes; write
 * routes require the new `products.groups_manage` slug (added to
 * the settings catalog in settings.service.ts under "المنتجات").
 *
 * Hard rule: no `apply` verb. Group membership is selector-only —
 * the existing smart-pricing / cost-adjustment apply endpoints
 * stay the only way to mutate prices/costs.
 */
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
import { Permissions } from '../common/decorators/roles.decorator';
import { ProductGroupsService } from './product-groups.service';
import {
  AddProductGroupVariantsDto,
  CreateProductGroupDto,
  UpdateProductGroupDto,
} from './dto/product-group.dto';

@ApiBearerAuth()
@ApiTags('product-groups')
@Permissions('products.view')
@Controller('product-groups')
export class ProductGroupsController {
  constructor(private readonly service: ProductGroupsService) {}

  @Get()
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'is_active', required: false, type: Boolean })
  list(
    @Query('q') q?: string,
    @Query('is_active') isActive?: string,
  ) {
    const filters: { q?: string; is_active?: boolean } = {};
    if (q) filters.q = q;
    if (isActive !== undefined) {
      filters.is_active = !(isActive === 'false' || isActive === '0');
    }
    return this.service.list(filters);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @Permissions('products.groups_manage')
  create(@Body() dto: CreateProductGroupDto, @Req() req: any) {
    return this.service.create(dto, req.user?.userId);
  }

  @Patch(':id')
  @Permissions('products.groups_manage')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductGroupDto,
  ) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @Permissions('products.groups_manage')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(id);
  }

  @Post(':id/variants')
  @Permissions('products.groups_manage')
  addVariants(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddProductGroupVariantsDto,
    @Req() req: any,
  ) {
    return this.service.addVariants(id, dto, req.user?.userId);
  }

  @Delete(':id/variants/:variant_id')
  @Permissions('products.groups_manage')
  removeVariant(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('variant_id', ParseUUIDPipe) variantId: string,
  ) {
    return this.service.removeVariant(id, variantId);
  }
}
