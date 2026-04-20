import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';

export class CreateProductDto {
  @ApiProperty({ example: 'ZHR-SHO-001' })
  @IsString()
  sku_root: string;

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
  @IsString() sku: string;
  @IsOptional() @IsString() barcode?: string;
  @IsOptional() @IsNumber() @Min(0) price_override?: number;
  @IsOptional() @IsNumber() @Min(0) cost_price?: number;
  @IsOptional() @IsNumber() @Min(0) selling_price?: number;
  @IsOptional() @IsString() image_url?: string;
}

export class UpdateVariantDto extends PartialType(CreateVariantDto) {}
