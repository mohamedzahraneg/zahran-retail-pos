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
