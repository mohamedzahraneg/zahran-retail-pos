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
}
