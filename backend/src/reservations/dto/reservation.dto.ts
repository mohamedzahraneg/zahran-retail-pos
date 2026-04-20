import {
  ArrayMinSize,
  IsArray,
  IsDateString,
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

/** Single line item to be reserved */
export class ReservationItemDto {
  @ApiProperty() @IsUUID() variant_id: string;
  @ApiProperty({ minimum: 1 }) @IsNumber() @Min(1) quantity: number;
  @ApiProperty() @IsNumber() @Min(0) unit_price: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) discount_amount?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

/** Deposit / installment payment */
export class ReservationPaymentInputDto {
  @ApiProperty({ enum: ['cash', 'card', 'instapay', 'bank_transfer'] })
  @IsEnum(['cash', 'card', 'instapay', 'bank_transfer'])
  payment_method: 'cash' | 'card' | 'instapay' | 'bank_transfer';

  @ApiProperty({ minimum: 0.01 }) @IsNumber() @Min(0.01) amount: number;

  @ApiPropertyOptional({ enum: ['deposit', 'installment', 'final'] })
  @IsOptional()
  @IsIn(['deposit', 'installment', 'final'])
  kind?: 'deposit' | 'installment' | 'final';

  @ApiPropertyOptional() @IsOptional() @IsString() reference_number?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

/** Create a new reservation */
export class CreateReservationDto {
  @ApiProperty() @IsUUID() customer_id: string;
  @ApiProperty() @IsUUID() warehouse_id: string;

  @ApiProperty({ type: [ReservationItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReservationItemDto)
  items: ReservationItemDto[];

  @ApiProperty({
    type: [ReservationPaymentInputDto],
    description: 'at least the initial deposit',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReservationPaymentInputDto)
  payments: ReservationPaymentInputDto[];

  @ApiPropertyOptional({ minimum: 0 }) @IsOptional() @IsNumber() @Min(0)
  discount_amount?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional() @IsNumber() @Min(0)
  deposit_required_pct?: number;

  @ApiPropertyOptional({ description: 'ISO8601 expiry date' })
  @IsOptional() @IsDateString()
  expires_at?: string;

  @ApiPropertyOptional({ enum: ['full', 'partial', 'none'] })
  @IsOptional() @IsIn(['full', 'partial', 'none'])
  refund_policy?: 'full' | 'partial' | 'none';

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional() @IsNumber() @Min(0)
  cancellation_fee_pct?: number;

  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

/** Add an installment/final payment to an existing reservation */
export class AddReservationPaymentDto extends ReservationPaymentInputDto {}

/** Cancel a reservation */
export class CancelReservationDto {
  @ApiProperty() @IsString() reason: string;

  @ApiPropertyOptional({
    description:
      'Override stored policy for this cancellation. Otherwise the reservation refund_policy is used.',
    enum: ['full', 'partial', 'none'],
  })
  @IsOptional()
  @IsIn(['full', 'partial', 'none'])
  refund_policy?: 'full' | 'partial' | 'none';

  @ApiPropertyOptional({ enum: ['cash', 'card', 'instapay', 'bank_transfer'] })
  @IsOptional()
  @IsEnum(['cash', 'card', 'instapay', 'bank_transfer'])
  refund_method?: 'cash' | 'card' | 'instapay' | 'bank_transfer';
}

/** Convert reservation to a completed invoice (customer collects product) */
export class ConvertReservationDto {
  @ApiPropertyOptional({
    type: [ReservationPaymentInputDto],
    description:
      'Final payments collected at POS to settle remaining balance. Required if remaining > 0.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReservationPaymentInputDto)
  final_payments?: ReservationPaymentInputDto[];

  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

/** Extend the expiry date */
export class ExtendReservationDto {
  @ApiProperty({ description: 'New expiry (ISO8601)' })
  @IsDateString()
  expires_at: string;
}

/** Query filters for listing */
export class ListReservationsQueryDto {
  @ApiPropertyOptional({ enum: ['active', 'completed', 'cancelled', 'expired'] })
  @IsOptional()
  @IsIn(['active', 'completed', 'cancelled', 'expired'])
  status?: 'active' | 'completed' | 'cancelled' | 'expired';

  @ApiPropertyOptional() @IsOptional() @IsUUID() customer_id?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() q?: string;
  @ApiPropertyOptional() @IsOptional() limit?: string;
  @ApiPropertyOptional() @IsOptional() offset?: string;
}
