import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { CommissionsService } from './commissions.service';
import { Roles, Permissions } from '../common/decorators/roles.decorator';

class UpdateRateDto {
  @IsNumber()
  @Min(0)
  @Max(100)
  commission_rate: number;
}

/**
 * PR-T4.6 — patch DTO for the EditProfile modal's seller settings
 * section. Each field optional; undefined = leave unchanged,
 * null = clear. Backend cross-field guard: when sales_target_period
 * is "none", sales_target_amount is forced to null.
 */
class UpdateSellerSettingsDto {
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsBoolean()
  is_salesperson?: boolean | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  commission_rate?: number;

  @IsOptional()
  @IsIn(['general', 'after_target', 'over_target', 'general_plus_over_target'])
  commission_mode?: string;

  @IsOptional()
  @IsIn(['none', 'daily', 'weekly', 'monthly'])
  sales_target_period?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  @Min(0)
  sales_target_amount?: number | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  @Min(0)
  @Max(100)
  commission_after_target_rate?: number | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  @Min(0)
  @Max(100)
  over_target_commission_rate?: number | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  effective_from?: string | null;
}

@ApiBearerAuth()
@ApiTags('commissions')
@Permissions('accounting.view')
@Controller('commissions')
export class CommissionsController {
  constructor(private readonly svc: CommissionsService) {}

  @Get('salespeople')
  @Roles('admin', 'manager', 'accountant')
  salespeople() {
    return this.svc.listSalespeople();
  }

  @Get('summary')
  @Roles('admin', 'manager', 'accountant')
  summary(@Query('from') from: string, @Query('to') to: string) {
    return this.svc.summary({ from, to });
  }

  @Get(':userId/detail')
  @Roles('admin', 'manager', 'accountant')
  detail(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.svc.detail(userId, { from, to });
  }

  @Get(':userId/category-breakdown')
  @Roles('admin', 'manager', 'accountant')
  categoryBreakdown(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.svc.categoryBreakdown(userId, { from, to });
  }

  @Patch(':userId/rate')
  @Roles('admin', 'manager')
  updateRate(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateRateDto,
  ) {
    return this.svc.updateRate(userId, dto.commission_rate);
  }

  // PR-T4.6 — read uses the broad accounting.view (same gate as the
  // rest of this controller); write reuses employee.profile.manage,
  // matching the canonical "edit employee profile" gate (employees
  // controller, line 190). Keeps the gate single-source-of-truth.
  @Get(':userId/seller-settings')
  @Roles('admin', 'manager', 'accountant')
  getSellerSettings(@Param('userId', ParseUUIDPipe) userId: string) {
    return this.svc.getSellerSettings(userId);
  }

  @Patch(':userId/seller-settings')
  @Permissions('employee.profile.manage')
  updateSellerSettings(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateSellerSettingsDto,
  ) {
    return this.svc.updateSellerSettings(userId, dto);
  }
}
