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
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const RETURN_REASONS = [
  'defective',
  'wrong_size',
  'wrong_color',
  'customer_changed_mind',
  'not_as_described',
  'other',
] as const;

export const ITEM_CONDITIONS = ['resellable', 'damaged', 'defective'] as const;

export const PAYMENT_METHODS = [
  'cash',
  'card',
  'instapay',
  'bank_transfer',
] as const;

export type ReturnReason = (typeof RETURN_REASONS)[number];
export type ItemCondition = (typeof ITEM_CONDITIONS)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

// ---- Return items ----------------------------------------------------------

export class ReturnItemDto {
  @ApiPropertyOptional({
    description:
      'Invoice_items row being returned (optional — absent on standalone/walk-in refunds).',
  })
  @IsOptional()
  @IsUUID()
  original_invoice_item_id?: string;

  @ApiProperty() @IsUUID() variant_id: string;

  @ApiProperty({ minimum: 1 }) @IsNumber() @Min(1) quantity: number;

  @ApiProperty() @IsNumber() @Min(0) unit_price: number;

  @ApiProperty({ description: 'Refund amount for this line (usually qty*price)' })
  @IsNumber() @Min(0)
  refund_amount: number;

  @ApiPropertyOptional({ enum: ITEM_CONDITIONS, default: 'resellable' })
  @IsOptional()
  @IsIn(ITEM_CONDITIONS as unknown as string[])
  condition?: ItemCondition;

  @ApiPropertyOptional({
    default: true,
    description: 'If true, stock is restored. Damaged goods usually false.',
  })
  @IsOptional() @IsBoolean()
  back_to_stock?: boolean;

  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

// ---- Create return ---------------------------------------------------------

export class CreateReturnDto {
  /**
   * Original invoice is optional — walk-in refunds can be accepted
   * without a receipt (goodwill / replacement / lost receipt). When
   * absent, items are registered against a NULL invoice and stock is
   * restored by variant_id only.
   */
  @ApiPropertyOptional() @IsOptional() @IsUUID() original_invoice_id?: string;

  @ApiPropertyOptional() @IsOptional() @IsUUID() customer_id?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() warehouse_id?: string;

  @ApiProperty({ type: [ReturnItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReturnItemDto)
  items: ReturnItemDto[];

  @ApiPropertyOptional({ enum: RETURN_REASONS, default: 'other' })
  @IsOptional()
  @IsEnum(RETURN_REASONS as unknown as string[])
  reason?: ReturnReason;

  @ApiPropertyOptional() @IsOptional() @IsString() reason_details?: string;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional() @IsNumber() @Min(0)
  restocking_fee?: number;

  @ApiPropertyOptional({ enum: PAYMENT_METHODS })
  @IsOptional()
  @IsIn(PAYMENT_METHODS as unknown as string[])
  refund_method?: PaymentMethod;

  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

// ---- Lifecycle actions -----------------------------------------------------

export class ApproveReturnDto {
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class RejectReturnDto {
  @ApiProperty() @IsString() reason: string;
}

export class RefundReturnDto {
  @ApiProperty({ enum: PAYMENT_METHODS })
  @IsIn(PAYMENT_METHODS as unknown as string[])
  refund_method: PaymentMethod;

  /** PR-R1 — when refund_method='cash', exactly one of (shift_id) or
   *  (cashbox_id with shift_id null) must be supplied. The service
   *  validates the open/pending state and cashbox-shift consistency. */
  @ApiPropertyOptional({
    description:
      'Open/pending shift the cash refund is paid from. If set, cashbox_id is taken from the shift.',
  })
  @IsOptional() @IsUUID() shift_id?: string;

  @ApiPropertyOptional({
    description:
      'Direct cashbox the cash refund is paid from. Used only when shift_id is null. Requires returns.refund.direct_cashbox permission.',
  })
  @IsOptional() @IsUUID() cashbox_id?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() reference?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

// ---- Exchange --------------------------------------------------------------

export class ExchangeLineDto {
  @ApiProperty() @IsUUID() variant_id: string;
  @ApiProperty({ minimum: 1 }) @IsNumber() @Min(1) quantity: number;
  @ApiProperty() @IsNumber() @Min(0) unit_price: number;

  @ApiPropertyOptional({ enum: ITEM_CONDITIONS, default: 'resellable' })
  @IsOptional()
  @IsIn(ITEM_CONDITIONS as unknown as string[])
  condition?: ItemCondition;

  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class CreateExchangeDto {
  @ApiProperty() @IsUUID() original_invoice_id: string;

  @ApiProperty({
    type: [ExchangeLineDto],
    description: 'Items being returned (condition + qty)',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ExchangeLineDto)
  returned_items: ExchangeLineDto[];

  @ApiProperty({
    type: [ExchangeLineDto],
    description: 'New items customer wants instead',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ExchangeLineDto)
  new_items: ExchangeLineDto[];

  @ApiPropertyOptional({
    enum: PAYMENT_METHODS,
    description: 'Method customer used to pay any positive price difference',
  })
  @IsOptional()
  @IsIn(PAYMENT_METHODS as unknown as string[])
  payment_method?: PaymentMethod;

  @ApiPropertyOptional({
    enum: PAYMENT_METHODS,
    description: 'Method used to refund negative price difference',
  })
  @IsOptional()
  @IsIn(PAYMENT_METHODS as unknown as string[])
  refund_method?: PaymentMethod;

  @ApiPropertyOptional({ enum: RETURN_REASONS, default: 'other' })
  @IsOptional()
  @IsEnum(RETURN_REASONS as unknown as string[])
  reason?: ReturnReason;

  @ApiPropertyOptional() @IsOptional() @IsString() reason_details?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;

  /** PR-R1 — when there is a non-zero cash difference (in either
   *  direction), exactly one of (shift_id) or (cashbox_id with shift_id
   *  null) must be supplied. The service validates the open/pending
   *  state and cashbox-shift consistency. Equal exchanges ignore both. */
  @ApiPropertyOptional({
    description:
      'Open/pending shift the exchange-difference cash flows through. If set, cashbox_id is taken from the shift.',
  })
  @IsOptional() @IsUUID() shift_id?: string;

  @ApiPropertyOptional({
    description:
      'Direct cashbox the exchange-difference cash flows through. Used only when shift_id is null. Refund direction additionally requires returns.refund.direct_cashbox permission.',
  })
  @IsOptional() @IsUUID() cashbox_id?: string;
}

// ---- Query filters ---------------------------------------------------------

export class ListReturnsQueryDto {
  @ApiPropertyOptional({ enum: ['pending', 'approved', 'refunded', 'rejected'] })
  @IsOptional()
  @IsIn(['pending', 'approved', 'refunded', 'rejected'])
  status?: 'pending' | 'approved' | 'refunded' | 'rejected';

  @ApiPropertyOptional() @IsOptional() @IsUUID() customer_id?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() q?: string;
  @ApiPropertyOptional() @IsOptional() limit?: string;
  @ApiPropertyOptional() @IsOptional() offset?: string;
}
