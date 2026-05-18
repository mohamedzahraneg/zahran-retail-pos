/**
 * dto/product-group.dto.ts — PR-P9.1a
 *
 * DTOs for the manual product-groups module. Pure validation; no
 * business rules. Mirrors the shape used by the existing
 * categories module so the operator-facing 400 messages stay
 * predictable.
 */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateProductGroupDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name_ar: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name_en?: string;

  @IsOptional()
  @IsString()
  description?: string;

  /** Optional hex tag like '#22c55e'. Stored verbatim; validated for
   *  the exact `#RRGGBB` shape so the UI can render it as a swatch. */
  @IsOptional()
  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/, {
    message: 'color must be a 6-digit hex code like #22c55e',
  })
  color?: string;
}

export class UpdateProductGroupDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name_ar?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name_en?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/, {
    message: 'color must be a 6-digit hex code like #22c55e',
  })
  color?: string;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

export class AddProductGroupVariantsDto {
  /** Bulk add — idempotent on the server. Capped at 500 to match
   *  the existing cost-adjustment / smart-pricing apply batch
   *  ceiling and avoid runaway transactions. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @Type(() => String)
  @IsUUID('all', { each: true })
  variant_ids: string[];
}
