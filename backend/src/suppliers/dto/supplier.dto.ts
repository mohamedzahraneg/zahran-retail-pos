import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateSupplierDto {
  @IsOptional()
  @IsString()
  @MaxLength(12)
  @Matches(/^[0-9]+$/, { message: 'كود المورد لازم يكون أرقام إنجليزي فقط' })
  code?: string;

  @IsString() @MaxLength(150) name: string;

  @IsOptional() @IsString() @MaxLength(32) phone?: string;
  @IsOptional() @IsString() @MaxLength(32) alt_phone?: string;
  @IsOptional() @IsString() @MaxLength(150) email?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() @MaxLength(150) contact_person?: string;
  @IsOptional() @IsString() @MaxLength(50) tax_number?: string;

  @IsOptional()
  @IsIn(['cash', 'credit', 'installments'])
  supplier_type?: 'cash' | 'credit' | 'installments';

  @IsOptional() @IsNumber() @Min(0) credit_limit?: number;
  @IsOptional() @IsNumber() @Min(0) opening_balance?: number;
  @IsOptional() @IsNumber() @Min(0) payment_terms_days?: number;

  @IsOptional() @IsString() notes?: string;
}

export class UpdateSupplierDto extends CreateSupplierDto {
  @IsOptional() @IsString() @MaxLength(150) declare name: string;
}
