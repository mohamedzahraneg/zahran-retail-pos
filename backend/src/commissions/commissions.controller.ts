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
import { IsNumber, IsOptional, Max, Min, ValidateIf } from 'class-validator';
import { CommissionsService } from './commissions.service';
import { Roles, Permissions } from '../common/decorators/roles.decorator';

class UpdateRateDto {
  @IsNumber()
  @Min(0)
  @Max(100)
  commission_rate: number;
}

/**
 * PR-T4.6 — patch DTO for the EditProfile modal.
 *   commission_rate                ∈ [0, 100]
 *   commission_target_amount       ≥ 0   or null  (null = no target system)
 *   commission_after_target_rate   ∈ [0, 100]  or null
 * Each field optional; undefined = leave unchanged, null = clear.
 */
class UpdateSellerSettingsDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  commission_rate?: number;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  @Min(0)
  commission_target_amount?: number | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  @Min(0)
  @Max(100)
  commission_after_target_rate?: number | null;
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

  @Get(':userId/seller-settings')
  @Roles('admin', 'manager', 'accountant')
  getSellerSettings(@Param('userId', ParseUUIDPipe) userId: string) {
    return this.svc.getSellerSettings(userId);
  }

  @Patch(':userId/seller-settings')
  @Roles('admin', 'manager')
  updateSellerSettings(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateSellerSettingsDto,
  ) {
    return this.svc.updateSellerSettings(userId, dto);
  }
}
