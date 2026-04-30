import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const PAYMENT_METHODS = [
  'cash',
  'card_visa',
  'card_mastercard',
  'card_meeza',
  'instapay',
  'vodafone_cash',
  'orange_cash',
  'wallet',         // PR-PAY-3.1
  'bank_transfer',
  'check',          // PR-FIN-PAYACCT-4B — cheque accounts in admin UI
  'credit',
  'other',
] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export class CreatePaymentAccountDto {
  @ApiProperty({ enum: PAYMENT_METHODS })
  @IsEnum(PAYMENT_METHODS)
  method: PaymentMethod;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  provider_key?: string;

  @ApiProperty()
  @IsString()
  display_name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  identifier?: string;

  @ApiProperty({
    description:
      'Existing chart_of_accounts.code. Validated by the DB trigger.',
    example: '1114',
  })
  @IsString()
  gl_account_code: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  is_default?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  /**
   * PR-FIN-PAYACCT-4A — optional pin to a specific physical cashbox
   * (drawer / bank record / wallet number). When set, the service-layer
   * validator enforces method↔cashbox.kind compatibility:
   *   • card_visa / card_meeza / card_mastercard / bank_transfer → bank
   *   • instapay / wallet / vodafone_cash / orange_cash             → ewallet
   *   • cash                                                         → cash
   *   • check                                                        → check
   * Leave NULL when the balance should live at gl_account_code level only
   * (the historical default for InstaPay handles, etc).
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  cashbox_id?: string | null;
}

export class UpdatePaymentAccountDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  display_name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  identifier?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  gl_account_code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  provider_key?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  /**
   * PR-FIN-PAYACCT-4A — see CreatePaymentAccountDto.cashbox_id.
   * Pass `null` to clear an existing pin.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  cashbox_id?: string | null;
}

/**
 * PR-FIN-PAYACCT-4D-UX-FIX-9 — historical-payment reconciliation.
 *
 * Operator-triggered backfill that maps historical
 * `invoice_payments` rows where `payment_account_id IS NULL` onto
 * the method's single active default payment_account.
 *
 * Strict guard rails (enforced in the service):
 *   • method must be in the supported subset (`instapay` only in this PR).
 *   • Exactly ONE active default payment_account must exist for the
 *     method — if 0 or >1, the call fails with a clear Arabic error.
 *   • dryRun=true returns counts/total without UPDATE (default true).
 *   • dryRun=false runs the UPDATE, returns before/after counts.
 *   • The UPDATE only writes `payment_account_id` and
 *     `payment_account_snapshot`. No JE / journal_lines /
 *     cashbox_transactions touched. No amounts, dates,
 *     customer_id, or invoice_id changed.
 *   • Idempotent — a second run matches zero rows.
 */
export class BackfillUnattachedDto {
  @ApiProperty({ enum: PAYMENT_METHODS })
  @IsEnum(PAYMENT_METHODS)
  method: PaymentMethod;

  @ApiPropertyOptional({
    default: true,
    description:
      'When true, returns counts/total without writing. Default true so accidental calls do not mutate.',
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}
