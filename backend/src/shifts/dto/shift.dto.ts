import {
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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
}
