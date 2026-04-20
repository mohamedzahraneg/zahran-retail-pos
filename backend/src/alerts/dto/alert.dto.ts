import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  IsObject,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export enum AlertType {
  low_stock = 'low_stock',
  out_of_stock = 'out_of_stock',
  reservation_expiring = 'reservation_expiring',
  reservation_expired = 'reservation_expired',
  loss_product = 'loss_product',
  price_below_cost = 'price_below_cost',
  large_discount = 'large_discount',
  cash_mismatch = 'cash_mismatch',
  custom = 'custom',
}

export enum AlertSeverity {
  info = 'info',
  warning = 'warning',
  critical = 'critical',
}

export class CreateAlertDto {
  @ApiProperty({ enum: AlertType })
  @IsEnum(AlertType)
  alert_type!: AlertType;

  @ApiProperty({ enum: AlertSeverity, default: AlertSeverity.info })
  @IsOptional()
  @IsEnum(AlertSeverity)
  severity?: AlertSeverity;

  @ApiProperty()
  @IsString()
  title!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  message?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  entity?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  entity_id?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  target_user_id?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  target_role_id?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}
