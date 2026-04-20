import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { ApiProperty, PartialType } from '@nestjs/swagger';

export enum CouponType {
  fixed = 'fixed',
  percentage = 'percentage',
}

export class CreateCouponDto {
  @ApiProperty()
  @IsString()
  code!: string;

  @ApiProperty()
  @IsString()
  name_ar!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  name_en?: string;

  @ApiProperty({ enum: CouponType })
  @IsEnum(CouponType)
  coupon_type!: CouponType;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  value!: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  max_discount_amount?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  applies_to_category?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  applies_to_product?: string;

  @ApiProperty({ required: false, default: 0 })
  @IsOptional()
  @IsNumber()
  min_order_value?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  starts_at?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  expires_at?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  max_uses_total?: number;

  @ApiProperty({ required: false, default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  max_uses_per_customer?: number;

  @ApiProperty({ required: false, default: true })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

export class UpdateCouponDto extends PartialType(CreateCouponDto) {}

export class ValidateCouponDto {
  @ApiProperty()
  @IsString()
  code!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  customer_id?: string;

  @ApiProperty({ required: false, default: 0 })
  @IsOptional()
  @IsNumber()
  subtotal?: number;
}
