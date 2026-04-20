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

export class PaymentAllocationDto {
  @ApiProperty() @IsUUID() invoice_id: string;
  @ApiProperty() @IsNumber() @Min(0.01) amount: number;
}

export class CreateCustomerPaymentDto {
  @ApiProperty() @IsUUID() customer_id: string;
  @ApiProperty() @IsUUID() cashbox_id: string;

  @ApiProperty({ enum: ['cash', 'card', 'instapay', 'bank_transfer'] })
  @IsEnum(['cash', 'card', 'instapay', 'bank_transfer'])
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
}

export class CreateSupplierPaymentDto {
  @ApiProperty() @IsUUID() supplier_id: string;
  @ApiProperty() @IsUUID() cashbox_id: string;

  @ApiProperty({ enum: ['cash', 'card', 'instapay', 'bank_transfer'] })
  @IsEnum(['cash', 'card', 'instapay', 'bank_transfer'])
  payment_method: string;

  @ApiProperty() @IsNumber() @Min(0.01) amount: number;

  @ApiPropertyOptional() @IsOptional() @IsString() reference?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;

  @ApiPropertyOptional({ type: [PaymentAllocationDto] })
  @IsOptional() @IsArray() @ValidateNested({ each: true })
  @Type(() => PaymentAllocationDto)
  allocations?: PaymentAllocationDto[];
}
