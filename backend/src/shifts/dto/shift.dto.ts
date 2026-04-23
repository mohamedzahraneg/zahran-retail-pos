import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export type VarianceTreatment =
  | 'charge_employee'
  | 'company_loss'
  | 'revenue'
  | 'suspense';

export class OpenShiftDto {
  @ApiProperty() @IsUUID() cashbox_id: string;
  @ApiProperty() @IsUUID() warehouse_id: string;
  @ApiProperty() @IsNumber() @Min(0) opening_balance: number;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class CloseShiftDto {
  @ApiProperty() @IsNumber() @Min(0) actual_closing: number;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  /**
   * Optional cash denomination breakdown: { "200": 3, "100": 7, "50": 12, ... }.
   * When supplied, stored on the shift for the audit trail. The server does
   * NOT re-derive actual_closing from this — the client is responsible for
   * sending the explicit total.
   */
  @ApiPropertyOptional() @IsOptional()
  denominations?: Record<string, number>;

  /**
   * Manager's decision on how to treat the counted variance (migration 060).
   * Required when the shift is closed with a non-zero variance by a user
   * who has `shifts.variance.approve`. Cashiers never supply this — they
   * go through request-close → approve-close instead.
   */
  @ApiPropertyOptional() @IsOptional()
  @IsIn(['charge_employee', 'company_loss', 'revenue', 'suspense'])
  variance_treatment?: VarianceTreatment;

  /** Required when variance_treatment = 'charge_employee'. */
  @ApiPropertyOptional() @IsOptional() @IsUUID()
  variance_employee_id?: string;

  @ApiPropertyOptional() @IsOptional() @IsString()
  variance_notes?: string;
}

/**
 * Payload for `POST /shifts/:id/approve-close`. The manager picks the
 * variance treatment here; the service validates it against the sign
 * of the variance and then delegates to `close()` with the stored
 * decision.
 */
export class ApproveCloseDto {
  @ApiPropertyOptional() @IsOptional()
  @IsIn(['charge_employee', 'company_loss', 'revenue', 'suspense'])
  variance_treatment?: VarianceTreatment;

  @ApiPropertyOptional() @IsOptional() @IsUUID()
  variance_employee_id?: string;

  @ApiPropertyOptional() @IsOptional() @IsString()
  variance_notes?: string;
}
