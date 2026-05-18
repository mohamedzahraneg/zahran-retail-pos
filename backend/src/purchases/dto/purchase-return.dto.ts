/**
 * dto/purchase-return.dto.ts — PR-P2.4A
 *
 * Typed payload for `POST /purchases/returns` (the existing route,
 * upgraded with 4 settlement modes + per-item parent linkage). The
 * service layer enforces cross-field rules
 * (e.g. cash_refund → cashbox_id + refund_amount === total).
 */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export type PurchaseReturnSettlementType =
  | 'supplier_credit'
  | 'cash_refund'
  | 'bank_refund'
  | 'no_settlement';

export class CreatePurchaseReturnItemDto {
  @IsUUID() variant_id: string;
  @IsOptional() @IsUUID() purchase_item_id?: string;
  @IsNumber()
  @Min(0.001)
  quantity: number;
  @IsNumber()
  @Min(0)
  unit_cost: number;
}

export class CreatePurchaseReturnDto {
  @IsUUID() supplier_id: string;
  @IsUUID() warehouse_id: string;
  @IsOptional() @IsUUID() purchase_id?: string;
  @IsOptional() @IsISO8601() return_date?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => CreatePurchaseReturnItemDto)
  items: CreatePurchaseReturnItemDto[];

  @IsString()
  @MinLength(3)
  reason: string;

  @IsOptional() @IsString() notes?: string;

  @IsIn(['supplier_credit', 'cash_refund', 'bank_refund', 'no_settlement'])
  settlement_type: PurchaseReturnSettlementType;

  /** Required when settlement_type ∈ {cash_refund, bank_refund}. */
  @IsOptional() @IsUUID() cashbox_id?: string;

  /** Required when settlement_type ∈ {cash_refund, bank_refund}.
   *  P2.4A forces equality with the return's total_amount; partial
   *  refunds are explicitly out of scope. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  refund_amount?: number;
}
