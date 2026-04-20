import {
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
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class InvoiceLineDto {
  @ApiProperty() @IsUUID() variant_id: string;
  @ApiProperty({ minimum: 1 }) @IsNumber() @Min(1) qty: number;
  @ApiProperty() @IsNumber() @Min(0) unit_price: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) discount?: number;

  /** Per-item salesperson (optional — falls back to invoice-level) */
  @ApiPropertyOptional() @IsOptional() @IsUUID() salesperson_id?: string;
}

export class InvoicePaymentDto {
  @ApiProperty({ enum: ['cash', 'card', 'instapay', 'bank_transfer'] })
  @IsEnum(['cash', 'card', 'instapay', 'bank_transfer'])
  payment_method: 'cash' | 'card' | 'instapay' | 'bank_transfer';

  @ApiProperty() @IsNumber() @Min(0) amount: number;

  @ApiPropertyOptional() @IsOptional() @IsString() reference?: string;
}

export class CreateInvoiceDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() customer_id?: string;
  @ApiProperty() @IsUUID() warehouse_id: string;

  /** Salesperson on the invoice level (applies to all items by default) */
  @ApiPropertyOptional() @IsOptional() @IsUUID() salesperson_id?: string;

  @ApiProperty({ type: [InvoiceLineDto] })
  @IsArray() @ValidateNested({ each: true }) @Type(() => InvoiceLineDto)
  lines: InvoiceLineDto[];

  @ApiProperty({ type: [InvoicePaymentDto] })
  @IsArray() @ValidateNested({ each: true }) @Type(() => InvoicePaymentDto)
  payments: InvoicePaymentDto[];

  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0)
  discount_total?: number;

  @ApiPropertyOptional() @IsOptional() @IsString() coupon_code?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;

  @ApiPropertyOptional({ description: 'Points to redeem against this invoice' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  redeem_points?: number;
}
