import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

import {
  CustomerGroupsService,
  CreateCustomerGroupDto,
  UpdateCustomerGroupDto,
} from './customer-groups.service';
import { Roles, Permissions } from '../common/decorators/roles.decorator';

class CreateGroupDto implements CreateCustomerGroupDto {
  @IsString() @MinLength(2) code: string;
  @IsString() @MinLength(2) name_ar: string;
  @IsOptional() @IsString() name_en?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsBoolean() is_wholesale?: boolean;
  @IsOptional() @IsNumber() @Min(0) @Max(100) default_discount_pct?: number;
  @IsOptional() @IsNumber() @Min(0) min_order_amount?: number;
  @IsOptional() @IsNumber() @Min(0) credit_limit?: number;
  @IsOptional() @IsInt() @Min(0) payment_terms_days?: number;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsBoolean() is_default?: boolean;
}

class UpdateGroupDto implements UpdateCustomerGroupDto {
  @IsOptional() @IsString() code?: string;
  @IsOptional() @IsString() name_ar?: string;
  @IsOptional() @IsString() name_en?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsBoolean() is_wholesale?: boolean;
  @IsOptional() @IsNumber() @Min(0) @Max(100) default_discount_pct?: number;
  @IsOptional() @IsNumber() @Min(0) min_order_amount?: number;
  @IsOptional() @IsNumber() @Min(0) credit_limit?: number;
  @IsOptional() @IsInt() @Min(0) payment_terms_days?: number;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsBoolean() is_default?: boolean;
}

class PriceDto {
  @IsUUID() variant_id: string;
  @IsNumber() @Min(0) price: number;
  @IsOptional() @IsInt() @Min(1) min_qty?: number;
  @IsOptional() @IsDateString() valid_from?: string;
  @IsOptional() @IsDateString() valid_to?: string;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsString() notes?: string;
}

class BulkPricesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PriceDto)
  items: PriceDto[];
}

class CategoryRuleDto {
  @IsUUID() category_id: string;
  @IsNumber() @Min(0) @Max(100) discount_pct: number;
  @IsOptional() @IsBoolean() is_active?: boolean;
}

class ResolveDto {
  @IsArray()
  variant_ids: string[];
  @IsOptional() @IsUUID() customer_id?: string;
  @IsOptional() @IsInt() @Min(1) qty?: number;
}

@ApiBearerAuth()
@ApiTags('customer-groups')
@Permissions('customer_groups.manage')
@Controller('customer-groups')
export class CustomerGroupsController {
  constructor(private readonly svc: CustomerGroupsService) {}

  // ----- Groups

  @Get()
  @ApiOperation({ summary: 'قائمة مجموعات العملاء' })
  list(@Query('include_inactive') includeInactive?: string) {
    return this.svc.list(
      includeInactive === 'true' || includeInactive === '1',
    );
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.svc.get(id);
  }

  @Post()
  @Roles('admin', 'manager')
  create(@Body() dto: CreateGroupDto) {
    return this.svc.create(dto);
  }

  @Patch(':id')
  @Roles('admin', 'manager')
  update(@Param('id') id: string, @Body() dto: UpdateGroupDto) {
    return this.svc.update(id, dto);
  }

  @Delete(':id')
  @Roles('admin', 'manager')
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }

  // ----- Variant overrides

  @Get(':id/prices')
  listPrices(@Param('id') id: string) {
    return this.svc.listPrices(id);
  }

  @Post(':id/prices')
  @Roles('admin', 'manager')
  upsertPrice(@Param('id') id: string, @Body() dto: PriceDto) {
    return this.svc.upsertPrice(id, dto);
  }

  @Post(':id/prices/bulk')
  @Roles('admin', 'manager')
  bulkPrices(@Param('id') id: string, @Body() body: BulkPricesDto) {
    return this.svc.bulkUpsertPrices(id, body.items);
  }

  @Delete('prices/:priceId')
  @Roles('admin', 'manager')
  removePrice(@Param('priceId') priceId: string) {
    return this.svc.removePrice(priceId);
  }

  // ----- Category rules

  @Post(':id/categories')
  @Roles('admin', 'manager')
  upsertCategoryRule(
    @Param('id') id: string,
    @Body() dto: CategoryRuleDto,
  ) {
    return this.svc.upsertCategoryRule(id, dto);
  }

  @Delete('categories/:ruleId')
  @Roles('admin', 'manager')
  removeCategoryRule(@Param('ruleId') ruleId: string) {
    return this.svc.removeCategoryRule(ruleId);
  }

  // ----- Price resolver (used by POS + customer pages)

  @Post('resolve')
  @ApiOperation({
    summary: 'حساب الأسعار الفعلية لمنتج أو أكثر لعميل معين',
  })
  resolve(@Body() body: ResolveDto) {
    return this.svc.resolveMany(
      body.variant_ids,
      body.customer_id,
      body.qty ?? 1,
    );
  }
}
