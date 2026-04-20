import { IsOptional, IsISO8601, IsEnum } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class DateRangeDto {
  @ApiPropertyOptional() @IsOptional() @IsISO8601() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() to?: string;
}

export class SalesReportDto extends DateRangeDto {
  @ApiPropertyOptional({ enum: ['day', 'week', 'month'] })
  @IsOptional() @IsEnum(['day', 'week', 'month'])
  group_by?: 'day' | 'week' | 'month';
}

export class ExportFormatDto {
  @ApiPropertyOptional({ enum: ['json', 'xlsx', 'pdf'] })
  @IsOptional() @IsEnum(['json', 'xlsx', 'pdf'])
  format?: 'json' | 'xlsx' | 'pdf';
}
