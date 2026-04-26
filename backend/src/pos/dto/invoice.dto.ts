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

// PR-PAY-1 — Aligned with the existing `payment_method_code` enum.
// The legacy 4-value union (cash | card | instapay | bank_transfer)
// silently dropped non-cash because `card` was un-insertable. The DTO
// now mirrors the DB enum exactly so unknown methods fail validation
// at the boundary instead of converting to cash inside the engine.
export const PAYMENT_METHOD_VALUES = [
  'cash',
  'card_visa',
  'card_mastercard',
  'card_meeza',
  'instapay',
  'vodafone_cash',
  'orange_cash',
  'bank_transfer',
  'credit',
  'other',
] as const;

export type InvoicePaymentMethod = (typeof PAYMENT_METHOD_VALUES)[number];

export class InvoicePaymentDto {
  @ApiProperty({ enum: PAYMENT_METHOD_VALUES })
  @IsEnum(PAYMENT_METHOD_VALUES)
  payment_method: InvoicePaymentMethod;

  @ApiProperty() @IsNumber() @Min(0) amount: number;

  @ApiPropertyOptional() @IsOptional() @IsString() reference?: string;

  /** PR-PAY-1: optional FK to payment_accounts. Cash leaves it null;
   *  non-cash will be required by the POS UI in PR-PAY-3 once admin
   *  has configured at least one active account for the method. */
  @ApiPropertyOptional() @IsOptional() @IsUUID() payment_account_id?: string;
}

export class CreateInvoiceDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() customer_id?: string;
  @ApiProperty() @IsUUID() warehouse_id: string;

  /** Salesperson on the invoice level — required so sales can be
   *  attributed to a user for reports and commissions. */
  @ApiProperty() @IsUUID() salesperson_id: string;

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
