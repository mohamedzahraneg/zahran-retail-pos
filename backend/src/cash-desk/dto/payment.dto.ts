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

/**
 * PR-FIN-PAYACCT-4C — extended method enum.
 *
 * Pre-this-PR contract was a 4-value enum ('cash','card','instapay',
 * 'bank_transfer') which forced operators to pick a generic method
 * with no way to identify which terminal / handle / IBAN was used.
 * The new enum aligns with `payment_method_code` (DB) minus 'credit'
 * and 'other' (which don't make sense for cash-desk operations).
 *
 * The legacy 'card' value is preserved for backward compatibility
 * with any existing callers; new FE always sends one of the
 * card_visa/card_mastercard/card_meeza variants.
 */
const PAYMENT_METHOD_VALUES = [
  'cash',
  'card', // legacy — kept so existing rows/clients don't break
  'card_visa',
  'card_mastercard',
  'card_meeza',
  'instapay',
  'vodafone_cash',
  'orange_cash',
  'wallet',
  'bank_transfer',
] as const;

export class PaymentAllocationDto {
  @ApiProperty() @IsUUID() invoice_id: string;
  @ApiProperty() @IsNumber() @Min(0.01) amount: number;
}

export class CreateCustomerPaymentDto {
  @ApiProperty() @IsUUID() customer_id: string;
  @ApiProperty() @IsUUID() cashbox_id: string;

  @ApiProperty({ enum: PAYMENT_METHOD_VALUES })
  @IsEnum(PAYMENT_METHOD_VALUES)
  payment_method: string;

  @ApiProperty() @IsNumber() @Min(0.01) amount: number;

  @ApiPropertyOptional({ enum: ['settle_invoices', 'deposit', 'refund'] })
  @IsOptional() @IsEnum(['settle_invoices', 'deposit', 'refund'])
  kind?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() reference?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;

  @ApiPropertyOptional({ type: [PaymentAllocationDto] })
  @IsOptional() @IsArray() @ValidateNested({ each: true })
  @Type(() => PaymentAllocationDto)
  allocations?: PaymentAllocationDto[];

  /**
   * PR-FIN-PAYACCT-4C — REQUIRED when method ≠ 'cash' AND active
   * payment_accounts exist for the chosen method (the service
   * enforces this; the DB trigger
   * `trg_customer_payment_account_consistency` is the backstop). Cash
   * methods MUST pass null/undefined.
   */
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional() @IsUUID()
  payment_account_id?: string | null;
}

export class CreateSupplierPaymentDto {
  @ApiProperty() @IsUUID() supplier_id: string;
  @ApiProperty() @IsUUID() cashbox_id: string;

  @ApiProperty({ enum: PAYMENT_METHOD_VALUES })
  @IsEnum(PAYMENT_METHOD_VALUES)
  payment_method: string;

  @ApiProperty() @IsNumber() @Min(0.01) amount: number;

  @ApiPropertyOptional() @IsOptional() @IsString() reference?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;

  @ApiPropertyOptional({ type: [PaymentAllocationDto] })
  @IsOptional() @IsArray() @ValidateNested({ each: true })
  @Type(() => PaymentAllocationDto)
  allocations?: PaymentAllocationDto[];

  /** PR-FIN-PAYACCT-4C — mirror of CreateCustomerPaymentDto.payment_account_id. */
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional() @IsUUID()
  payment_account_id?: string | null;
}
