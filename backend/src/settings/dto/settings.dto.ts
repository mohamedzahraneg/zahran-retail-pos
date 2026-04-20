import { IsBoolean, IsDefined, IsOptional, IsString, Length } from 'class-validator';

export class UpsertSettingDto {
  @IsString()
  @Length(1, 80)
  key!: string;

  /** jsonb payload — accept any shape (object, array, primitive). */
  @IsDefined()
  value!: any;

  @IsOptional()
  @IsString()
  @Length(1, 40)
  group_name?: string;

  @IsOptional()
  @IsBoolean()
  is_public?: boolean;

  @IsOptional()
  @IsString()
  description?: string;
}

export class UpdateCompanyProfileDto {
  @IsOptional() @IsString() name_ar?: string;
  @IsOptional() @IsString() name_en?: string;
  @IsOptional() @IsString() tax_number?: string;
  @IsOptional() @IsString() commercial_register?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() logo_url?: string;
  @IsOptional() @IsString() receipt_footer_ar?: string;
  @IsOptional() @IsString() receipt_footer_en?: string;
  @IsOptional() currency?: string;
  @IsOptional() tax_rate?: number;
}

export class UpsertWarehouseDto {
  @IsString()
  code!: string;

  @IsString()
  name_ar!: string;

  @IsOptional() @IsString() name_en?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() manager_id?: string;
  @IsOptional() @IsBoolean() is_main?: boolean;
  @IsOptional() @IsBoolean() is_retail?: boolean;
  @IsOptional() @IsBoolean() is_active?: boolean;
}

export class UpsertCashboxDto {
  @IsString()
  name_ar!: string;

  @IsOptional() @IsString() name_en?: string;
  @IsString() warehouse_id!: string;
  @IsOptional() @IsBoolean() is_active?: boolean;
}
