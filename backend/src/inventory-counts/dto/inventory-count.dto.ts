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

// PR-INVENTORY-COUNTS-WORKFLOW — `create` is the new pure-header
// endpoint; `start` keeps the legacy create-and-freeze-in-one-step
// behavior for backward compat with the existing FE.
export class CreateCountDto {
  @ApiProperty()
  @IsUUID()
  warehouse_id!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  notes?: string;
}

export class FreezeCountDto {
  @ApiProperty({
    required: false,
    description:
      'إن تركت فارغاً، يتم تجميد رصيد كل الأصناف في المخزن',
  })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  variant_ids?: string[];

  // Scope filters — purely additive. If any are supplied, the
  // freeze snapshot is narrowed by those filters AT the freeze
  // moment. None of them apply pricing or stock changes.
  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  category_id?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  brand_id?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  group_id?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  product_id?: string;
}

// Legacy DTO — preserved for the existing /inventory-counts/start
// endpoint that the current FE still hits.
export class StartCountDto {
  @ApiProperty()
  @IsUUID()
  warehouse_id!: string;

  @ApiProperty({
    required: false,
    description: 'إن تركت فارغاً، يتم تجميد رصيد كل الأصناف في المخزن',
  })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  variant_ids?: string[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  notes?: string;
}

export class CountEntryDto {
  @ApiProperty()
  @IsUUID()
  item_id!: string;

  @ApiProperty()
  @IsInt()
  @Min(0)
  counted_qty!: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  notes?: string;
}

export class SubmitCountDto {
  @ApiProperty({ type: [CountEntryDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CountEntryDto)
  items!: CountEntryDto[];
}

export class FinalizeCountDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  notes?: string;
}

export class CancelCountDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  reason?: string;
}
