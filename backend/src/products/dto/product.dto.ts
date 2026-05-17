import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
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
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';

export class CreateProductDto {
  /**
   * Optional — if omitted or blank, the DB trigger auto-generates one in the
   * form "<TYPE>-NNNNN" (e.g. SH-00042). Kept optional so the UI can leave
   * it blank and trust the server.
   */
  @ApiPropertyOptional({ example: 'SH-00042 (auto if blank)' })
  @IsOptional()
  @IsString()
  sku_root?: string;

  @ApiProperty({ example: 'حذاء كلاسيك نسائي' })
  @IsString()
  name_ar: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name_en?: string;

  @ApiProperty({ enum: ['shoe', 'bag', 'accessory'] })
  @IsEnum(['shoe', 'bag', 'accessory'])
  type: 'shoe' | 'bag' | 'accessory';

  @ApiPropertyOptional() @IsOptional() @IsUUID() brand_id?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() category_id?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() supplier_id?: string;

  @ApiProperty({ example: 899.0 })
  @IsNumber() @Min(0) base_price: number;

  @ApiProperty({ example: 450.0 })
  @IsNumber() @Min(0) cost_price: number;

  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;

  @ApiPropertyOptional({ example: 'piece', description: 'piece / carton / box / pair' })
  @IsOptional() @IsString()
  uom?: string;

  @ApiPropertyOptional()
  @IsOptional() @IsString()
  primary_image_url?: string;
}

export class UpdateProductDto extends PartialType(CreateProductDto) {}

export class CreateVariantDto {
  @IsUUID() product_id: string;
  @IsOptional() @IsUUID() color_id?: string;
  @IsOptional() @IsUUID() size_id?: string;
  @IsOptional() @IsString() color?: string;
  @IsOptional() @IsString() size?: string;
  /**
   * Optional — if omitted, the DB trigger auto-generates one derived from the
   * product's sku_root + color + size (e.g. SH-00042-RD42).
   */
  @IsOptional() @IsString() sku?: string;
  @IsOptional() @IsString() barcode?: string;
  @IsOptional() @IsNumber() @Min(0) price_override?: number;
  @IsOptional() @IsNumber() @Min(0) cost_price?: number;
  @IsOptional() @IsNumber() @Min(0) selling_price?: number;
  @IsOptional() @IsString() image_url?: string;
}

export class UpdateVariantDto extends PartialType(CreateVariantDto) {}

// ─── PR-PURCHASES-P3.2 — manual apply suggested sale price ────────────────
// Pricing-only payload. Drives `POST /products/variants/apply-prices`.
// The endpoint updates `product_variants.selling_price` and inserts a
// `variant_price_history` audit row per change — nothing else.
export class ApplyVariantPriceItemDto {
  @ApiProperty({ example: '00000000-0000-0000-0000-000000000000' })
  @IsUUID()
  variant_id: string;

  @ApiProperty({ example: 145.0, minimum: 0.01 })
  @IsNumber()
  @Min(0.01)
  new_selling_price: number;
}

export class ApplyVariantPricesDto {
  /** Optional source purchase id — when the apply was triggered from
   *  the purchase flow we store it on every history row for traceability. */
  @ApiPropertyOptional() @IsOptional() @IsUUID() source_purchase_id?: string;

  /** Optional free-form reason; stored verbatim on every history row. */
  @ApiPropertyOptional() @IsOptional() @IsString() reason?: string;

  @ApiProperty({ type: () => [ApplyVariantPriceItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ApplyVariantPriceItemDto)
  items: ApplyVariantPriceItemDto[];
}

// ─── PR-PURCHASES-P3.5A — Smart Bulk Pricing Assistant ─────────────────
// Preview + apply DTOs. PRICING-ONLY:
//   · Reads cost_price for recommendation math but NEVER writes it.
//   · Writes only product_variants.selling_price + variant_price_history.
//   · Never calls posting/cashbox/stock/purchase paths.
// Cost adjustment is explicitly deferred to P3.5B (needs
// variant_cost_history + a separate permission + inventory revaluation
// policy).

export type SmartPricingScopeType = 'selected' | 'filtered' | 'all' | 'single';
export type SmartPricingStrategy =
  | 'conservative'
  | 'balanced'
  | 'aggressive'
  | 'clearance';
export type SmartPricingStatusFilter =
  | 'below_cost'
  | 'below_min_margin'
  | 'ok'
  | 'unknown_cost';

export class SmartPricingFiltersDto {
  @ApiPropertyOptional() @IsOptional() @IsString() q?: string;
  @ApiPropertyOptional({
    enum: ['below_cost', 'below_min_margin', 'ok', 'unknown_cost'],
  })
  @IsOptional()
  @IsIn(['below_cost', 'below_min_margin', 'ok', 'unknown_cost'])
  status?: SmartPricingStatusFilter;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() only_in_stock?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsUUID() supplier_id?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() needs_review_only?: boolean;
}

export class SmartPricingScopeDto {
  @ApiProperty({ enum: ['selected', 'filtered', 'all', 'single'] })
  @IsIn(['selected', 'filtered', 'all', 'single'])
  type: SmartPricingScopeType;

  /** Required when type ∈ {selected, single}. Ignored otherwise. */
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  variant_ids?: string[];

  /** Required when type=filtered. Ignored otherwise. */
  @ApiPropertyOptional({ type: () => SmartPricingFiltersDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SmartPricingFiltersDto)
  filters?: SmartPricingFiltersDto;
}

export class SmartPricingPreviewDto {
  @ApiProperty({ type: () => SmartPricingScopeDto })
  @ValidateNested()
  @Type(() => SmartPricingScopeDto)
  scope: SmartPricingScopeDto;

  @ApiProperty({
    enum: ['conservative', 'balanced', 'aggressive', 'clearance'],
  })
  @IsIn(['conservative', 'balanced', 'aggressive', 'clearance'])
  strategy: SmartPricingStrategy;

  @ApiPropertyOptional({ default: 1000 })
  @IsOptional() @IsNumber() @Min(1) @Max(5000)
  limit?: number;
}

export class SmartPricingApplyDto {
  @ApiProperty({ type: () => SmartPricingScopeDto })
  @ValidateNested()
  @Type(() => SmartPricingScopeDto)
  scope: SmartPricingScopeDto;

  @ApiProperty({
    enum: ['conservative', 'balanced', 'aggressive', 'clearance'],
  })
  @IsIn(['conservative', 'balanced', 'aggressive', 'clearance'])
  strategy: SmartPricingStrategy;

  /** When set, only these variant_ids out of the scope's preview will
   *  be applied. When omitted, every previewed row whose recommendation
   *  is `increase` / `decrease` will be applied. */
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  variant_ids_to_apply?: string[];

  @ApiProperty()
  @IsString()
  @MinLength(3)
  reason: string;

  /** Mandatory ONLY when scope.type === 'all'. Must match exactly the
   *  Arabic phrase the FE displays so a stray API caller can't
   *  accidentally rewrite every price. */
  @ApiPropertyOptional() @IsOptional() @IsString() confirm_all?: string;
}
