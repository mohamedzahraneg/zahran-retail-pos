import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class TransferItemDto {
  @ApiProperty()
  @IsUUID()
  variant_id!: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  quantity_requested!: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  notes?: string;
}

export class CreateTransferDto {
  @ApiProperty()
  @IsUUID()
  from_warehouse_id!: string;

  @ApiProperty()
  @IsUUID()
  to_warehouse_id!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiProperty({ type: [TransferItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TransferItemDto)
  items!: TransferItemDto[];
}

// PR-STOCK-TRANSFERS-WORKFLOW — patch payload. Every field is
// optional; the service rejects the request if the transfer is no
// longer in `draft|pending`.
export class UpdateTransferDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  from_warehouse_id?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  to_warehouse_id?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  notes?: string;

  /** Only `draft` ↔ `pending` transitions are accepted here. */
  @ApiProperty({ required: false, enum: ['draft', 'pending'] })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiProperty({ required: false, type: [TransferItemDto] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TransferItemDto)
  items?: TransferItemDto[];
}

export class ReceiveItemDto {
  @ApiProperty()
  @IsUUID()
  item_id!: string;

  @ApiProperty()
  @IsInt()
  @Min(0)
  quantity_received!: number;
}

export class ReceiveTransferDto {
  @ApiProperty({ type: [ReceiveItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReceiveItemDto)
  items!: ReceiveItemDto[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  notes?: string;
}
