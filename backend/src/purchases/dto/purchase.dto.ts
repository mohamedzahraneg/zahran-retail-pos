import {
  IsArray,
  IsDateString,
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
