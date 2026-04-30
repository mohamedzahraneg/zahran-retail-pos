import { IsBoolean, IsDefined, IsOptional, IsString, IsUUID, Length } from 'class-validator';

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
  /**
   * PR-FIN-PAYACCT-4D-UX-FIX-6 — tightened from `@IsString()` to
   * `@IsOptional() @IsUUID()` so the validator rejects the
   * `"undefined"` / `"null"` sentinels that previously slipped through
   * and produced
   * `invalid input syntax for type uuid: "undefined"` at the SQL
   * boundary. The single live FE caller (Settings → "الخزائن"
   * `CashboxModal`) always sends a real warehouse UUID picked from a
   * dropdown — the form's "حفظ" button is disabled until one is
   * selected — so the contract tightening doesn't break any existing
   * call. The service-layer fallback (look up the first active
   * warehouse) covers the optional path for parity with
   * `cash-desk.service.createCashbox`.
   */
  @IsOptional() @IsUUID() warehouse_id?: string;
  @IsOptional() @IsBoolean() is_active?: boolean;
}
