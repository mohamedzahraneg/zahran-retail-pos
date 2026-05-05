import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsUUID,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * PR-FIX-SHIFTS-PAGE-BULK-LIVE-VARIANCE
 *
 * Body for POST /shifts/reports/list-live-summary. Lightweight bulk
 * endpoint serving the main Shifts list page. Returns LIVE
 * variance + cash/non-cash totals per shift in 5 grouped SQL
 * queries (NOT N × computeSummary fan-out). Capped at 100 ids.
 */
export class ListLiveSummaryDto {
  @ApiProperty({
    description:
      'Closed-shift ids to summarize. Max 100 per request to keep DB pool usage bounded.',
    type: [String],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  shift_ids!: string[];
}
