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
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  Max,
  IsBoolean,
  IsDateString,
  IsUUID,
  MinLength,
} from 'class-validator';
import {
  RecurringExpensesService,
  CreateRecurringExpenseDto,
  UpdateRecurringExpenseDto,
  Frequency,
} from './recurring-expenses.service';
import { Roles, Permissions } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  JwtUser,
} from '../common/decorators/current-user.decorator';

class CreateDto implements CreateRecurringExpenseDto {
  @IsString() @MinLength(2) code: string;
  @IsString() @MinLength(2) name_ar: string;
  @IsOptional() @IsString() name_en?: string;
  @IsUUID() category_id: string;
  @IsUUID() warehouse_id: string;
  @IsOptional() @IsUUID() cashbox_id?: string;
  @IsNumber() @Min(0) amount: number;
  @IsOptional() @IsString() payment_method?: string;
  @IsOptional() @IsString() vendor_name?: string;
  @IsOptional() @IsString() description?: string;
  @IsEnum([
    'daily',
    'weekly',
    'biweekly',
    'monthly',
    'quarterly',
    'semiannual',
    'annual',
    'custom_days',
  ])
  frequency: Frequency;
  @IsOptional() @IsNumber() @Min(1) custom_interval_days?: number;
  @IsOptional() @IsNumber() @Min(1) @Max(31) day_of_month?: number;
  @IsDateString() start_date: string;
  @IsOptional() @IsDateString() end_date?: string;
  @IsOptional() @IsBoolean() auto_post?: boolean;
  @IsOptional() @IsBoolean() auto_paid?: boolean;
  @IsOptional() @IsNumber() @Min(0) notify_days_before?: number;
  @IsOptional() @IsBoolean() require_approval?: boolean;
}

class UpdateDto implements UpdateRecurringExpenseDto {
  @IsOptional() @IsString() code?: string;
  @IsOptional() @IsString() name_ar?: string;
  @IsOptional() @IsString() name_en?: string;
  @IsOptional() @IsUUID() category_id?: string;
  @IsOptional() @IsUUID() warehouse_id?: string;
  @IsOptional() @IsUUID() cashbox_id?: string;
  @IsOptional() @IsNumber() @Min(0) amount?: number;
  @IsOptional() @IsString() payment_method?: string;
  @IsOptional() @IsString() vendor_name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional()
  @IsEnum([
    'daily',
    'weekly',
    'biweekly',
    'monthly',
    'quarterly',
    'semiannual',
    'annual',
    'custom_days',
  ])
  frequency?: Frequency;
  @IsOptional() @IsNumber() @Min(1) custom_interval_days?: number;
  @IsOptional() @IsNumber() @Min(1) @Max(31) day_of_month?: number;
  @IsOptional() @IsDateString() start_date?: string;
  @IsOptional() @IsDateString() end_date?: string;
  @IsOptional() @IsBoolean() auto_post?: boolean;
  @IsOptional() @IsBoolean() auto_paid?: boolean;
  @IsOptional() @IsNumber() @Min(0) notify_days_before?: number;
  @IsOptional() @IsBoolean() require_approval?: boolean;
  @IsOptional() @IsEnum(['active', 'paused', 'ended']) status?: 'active' | 'paused' | 'ended';
}

@ApiBearerAuth()
@ApiTags('recurring-expenses')
@Roles('admin', 'manager', 'accountant')
@Permissions('recurring_expenses.manage')
@Controller('recurring-expenses')
export class RecurringExpensesController {
  constructor(private readonly svc: RecurringExpensesService) {}

  @Get()
  @ApiOperation({ summary: 'قائمة المصروفات الدورية' })
  list(
    @Query('status') status?: string,
    @Query('warehouse_id') warehouse_id?: string,
    @Query('due_only') due_only?: string,
  ) {
    return this.svc.list({
      status,
      warehouse_id,
      due_only: due_only === 'true' || due_only === '1',
    });
  }

  @Get('stats')
  stats() {
    return this.svc.stats();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.svc.get(id);
  }

  @Post()
  create(@Body() dto: CreateDto, @CurrentUser() user: JwtUser) {
    return this.svc.create(dto, user.userId);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateDto) {
    return this.svc.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }

  @Post(':id/pause')
  pause(@Param('id') id: string) {
    return this.svc.pause(id);
  }

  @Post(':id/resume')
  resume(@Param('id') id: string) {
    return this.svc.resume(id);
  }

  @Post(':id/run')
  @ApiOperation({ summary: 'توليد المصروف المستحق من القالب' })
  runOne(
    @Param('id') id: string,
    @Body() body: { dry_run?: boolean },
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.runOne(id, user.userId, { dryRun: body?.dry_run });
  }

  @Post('process-due')
  @ApiOperation({ summary: 'معالجة كل القوالب المستحقة الآن (cron/يدوي)' })
  processDue(
    @Body() body: { limit?: number },
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.processDue({ userId: user.userId, limit: body?.limit });
  }
}
