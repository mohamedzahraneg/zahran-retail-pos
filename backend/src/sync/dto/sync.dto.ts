import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';

export type SyncEntity =
  | 'invoice'
  | 'return'
  | 'reservation'
  | 'customer'
  | 'cash_movement';

export class SyncOperationDto {
  /** client-generated stable id for idempotency */
  @IsString()
  @Length(1, 60)
  offline_id!: string;

  @IsString()
  @IsIn([
    'invoice',
    'return',
    'reservation',
    'customer',
    'cash_movement',
  ])
  entity!: SyncEntity;

  @IsString()
  @IsIn(['I', 'U', 'D'])
  operation!: 'I' | 'U' | 'D';

  @IsObject()
  payload!: Record<string, any>;

  @IsDateString()
  client_created_at!: string;
}

export class PushSyncDto {
  @IsString()
  @Length(1, 60)
  client_id!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => SyncOperationDto)
  operations!: SyncOperationDto[];
}

export class PullSyncDto {
  @IsOptional()
  @IsDateString()
  since?: string;

  @IsOptional()
  @IsString()
  client_id?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  entities?: SyncEntity[];
}

export interface SyncOperationResult {
  offline_id: string;
  entity: SyncEntity;
  state: 'synced' | 'conflict' | 'failed' | 'duplicate';
  server_id?: string | null;
  result?: any;
  conflict_reason?: string | null;
  error?: string;
}
