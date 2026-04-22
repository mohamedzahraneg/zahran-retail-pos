import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MinLength,
  IsUUID,
  IsDateString,
  Min,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';

import { ChartOfAccountsService } from './chart-of-accounts.service';
import {
  JournalService,
  CreateJournalEntryDto,
} from './journal.service';
import { AccountingPostingService } from './posting.service';
import { Permissions } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  JwtUser,
} from '../common/decorators/current-user.decorator';

const ACC_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;
const NORMAL_BAL = ['debit', 'credit'] as const;

class CreateAccountDtoIn {
  @IsString() @MinLength(1) code: string;
  @IsString() @MinLength(1) name_ar: string;
  @IsOptional() @IsString() name_en?: string;
  @IsEnum(ACC_TYPES) account_type: (typeof ACC_TYPES)[number];
  @IsOptional() @IsEnum(NORMAL_BAL) normal_balance?: (typeof NORMAL_BAL)[number];
  @IsOptional() @IsUUID() parent_id?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsUUID() cashbox_id?: string;
}

class UpdateAccountDtoIn {
  @IsOptional() @IsString() name_ar?: string;
  @IsOptional() @IsString() name_en?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsUUID() cashbox_id?: string | null;
  @IsOptional() @IsNumber() sort_order?: number;
}

class JournalLineDtoIn {
  @IsUUID() account_id: string;
  @IsOptional() @IsNumber() @Min(0) debit?: number;
  @IsOptional() @IsNumber() @Min(0) credit?: number;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsUUID() cashbox_id?: string;
  @IsOptional() @IsUUID() warehouse_id?: string;
}

class CreateJournalDtoIn implements CreateJournalEntryDto {
  @IsDateString() entry_date: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() reference_type?: string;
  @IsOptional() @IsUUID() reference_id?: string;
  @IsArray() @ArrayMinSize(2)
  @ValidateNested({ each: true }) @Type(() => JournalLineDtoIn)
  lines: JournalLineDtoIn[];
  @IsOptional() @IsBoolean() post_immediately?: boolean;
}

class VoidJournalDtoIn {
  @IsString() @MinLength(3) reason: string;
}

@ApiBearerAuth()
@ApiTags('accounts')
@Controller('accounts')
export class ChartOfAccountsController {
  constructor(
    private readonly coa: ChartOfAccountsService,
    private readonly journal: JournalService,
    private readonly posting: AccountingPostingService,
  ) {}

  // ── Chart of Accounts ──────────────────────────────────────────────

  @Get('chart')
  @Permissions('accounts.chart.view')
  @ApiOperation({ summary: 'شجرة الحسابات' })
  list(@Query('include_inactive') includeInactive?: string) {
    return this.coa.list(includeInactive === 'true' || includeInactive === '1');
  }

  @Get('chart/trial-balance')
  @Permissions('accounts.chart.view')
  @ApiOperation({ summary: 'ميزان المراجعة' })
  trialBalance() {
    return this.coa.trialBalance();
  }

  @Get('chart/:id')
  @Permissions('accounts.chart.view')
  get(@Param('id') id: string) {
    return this.coa.get(id);
  }

  @Post('chart')
  @Permissions('accounts.chart.manage')
  create(@Body() dto: CreateAccountDtoIn, @CurrentUser() user: JwtUser) {
    return this.coa.create(dto, user.userId);
  }

  @Patch('chart/:id')
  @Permissions('accounts.chart.manage')
  update(@Param('id') id: string, @Body() dto: UpdateAccountDtoIn) {
    return this.coa.update(id, dto);
  }

  @Delete('chart/:id')
  @Permissions('accounts.chart.manage')
  remove(@Param('id') id: string) {
    return this.coa.remove(id);
  }

  // ── Journal Entries ────────────────────────────────────────────────

  @Get('journal')
  @Permissions('accounts.journal.view')
  @ApiOperation({ summary: 'قائمة القيود اليومية' })
  listJournal(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('is_posted') is_posted?: string,
    @Query('is_void') is_void?: string,
    @Query('reference_type') reference_type?: string,
    @Query('account_id') account_id?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.journal.list({
      from,
      to,
      is_posted:
        is_posted === undefined
          ? undefined
          : is_posted === 'true' || is_posted === '1',
      is_void:
        is_void === undefined
          ? undefined
          : is_void === 'true' || is_void === '1',
      reference_type,
      account_id,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  @Get('journal/:id')
  @Permissions('accounts.journal.view')
  getJournal(@Param('id') id: string) {
    return this.journal.get(id);
  }

  @Post('journal')
  @Permissions('accounts.journal.post')
  createJournal(
    @Body() dto: CreateJournalDtoIn,
    @CurrentUser() user: JwtUser,
  ) {
    return this.journal.create(dto, user.userId);
  }

  @Post('journal/:id/void')
  @Permissions('accounts.journal.void')
  voidJournal(
    @Param('id') id: string,
    @Body() dto: VoidJournalDtoIn,
    @CurrentUser() user: JwtUser,
  ) {
    return this.journal.void(id, user.userId, dto.reason);
  }

  @Post('journal/backfill')
  @Permissions('accounts.journal.post')
  @ApiOperation({
    summary: 'ترحيل تلقائي لكل العمليات القديمة التي لم يتم ترحيلها',
  })
  backfill(
    @Body() body: { since?: string },
    @CurrentUser() user: JwtUser,
  ) {
    return this.posting.backfill({
      since: body?.since,
      userId: user.userId,
    });
  }
}
