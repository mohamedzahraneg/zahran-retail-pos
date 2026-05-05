import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class AggregateDetailFiltersDto {
  @ApiPropertyOptional({ description: 'YYYY-MM-DD (Cairo)' })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD (Cairo)' })
  @IsOptional()
  @IsString()
  to?: string;

  @ApiPropertyOptional({ enum: ['open', 'closed', 'pending_close', 'all'] })
  @IsOptional()
  @IsIn(['open', 'closed', 'pending_close', 'all'])
  status?: string;

  @ApiPropertyOptional({ description: 'Cashier user_id (opened_by)' })
  @IsOptional()
  @IsUUID()
  user_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  cashbox_id?: string;
}

export class AggregateDetailDto {
  @ApiPropertyOptional({
    description:
      'Explicit shift selection. Wins over `filters` when present and non-empty.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  shift_ids?: string[];

  @ApiPropertyOptional({ type: AggregateDetailFiltersDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AggregateDetailFiltersDto)
  filters?: AggregateDetailFiltersDto;
}
