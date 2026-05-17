import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
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
