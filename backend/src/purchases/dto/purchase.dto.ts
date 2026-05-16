import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class PurchaseItemDto {
  @IsUUID() variant_id: string;
  @IsInt() @Min(1) quantity: number;
  @IsNumber() @Min(0) unit_cost: number;
  @IsOptional() @IsNumber() @Min(0) discount?: number;
  @IsOptional() @IsNumber() @Min(0) tax?: number;
}

// PR-PURCHASES-P2.1 — landed-cost extras DTOs.
//
// `unit_cost` on PurchaseItemDto continues to carry the BASE price per
// piece (what the operator typed). The service-layer allocation engine
// converts it into the LANDED `purchase_items.unit_cost` after running
// through the extras list. Operators never need to think about base
// vs. landed at submit time.

export class PurchaseManualAllocationDto {
  @IsUUID() variant_id: string;
  @IsNumber() @Min(0.01) amount: number;
}

export class PurchaseExtraCostDto {
  @IsIn(['transport', 'labor', 'shipping', 'customs', 'packaging', 'other'])
  cost_type: 'transport' | 'labor' | 'shipping' | 'customs' | 'packaging' | 'other';

  @IsOptional() @IsString() label?: string;
  @IsNumber() @Min(0.01) amount: number;
  @IsOptional() @IsBoolean() capitalize_to_inventory?: boolean;

  @IsOptional()
  @IsIn(['by_value', 'by_quantity', 'manual'])
  allocation_method?: 'by_value' | 'by_quantity' | 'manual';

  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsInt() @Min(0) sort_order?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PurchaseManualAllocationDto)
  manual_allocations?: PurchaseManualAllocationDto[];
}

export class CreatePurchaseDto {
  @IsUUID() supplier_id: string;
  @IsUUID() warehouse_id: string;
  @IsOptional() @IsDateString() invoice_date?: string;
  @IsOptional() @IsDateString() due_date?: string;
  @IsOptional() @IsString() supplier_ref?: string;
  @IsOptional() @IsNumber() @Min(0) shipping_cost?: number;
  @IsOptional() @IsNumber() @Min(0) discount_amount?: number;
  @IsOptional() @IsNumber() @Min(0) tax_amount?: number;
  @IsOptional() @IsString() notes?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PurchaseItemDto)
  items: PurchaseItemDto[];

  // PR-PURCHASES-P2.1 — optional, undefined = legacy behavior.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PurchaseExtraCostDto)
  extra_costs?: PurchaseExtraCostDto[];
}

export class AddPurchasePaymentDto {
  @IsString() payment_method: string;
  @IsNumber() @Min(0.01) amount: number;
  @IsOptional() @IsString() reference_number?: string;
  @IsOptional() @IsString() notes?: string;
}

export class ListPurchasesDto {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsUUID() supplier_id?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}
