import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { LoyaltyService } from './loyalty.service';
import { CurrentUser, JwtUser } from '../common/decorators/current-user.decorator';
import { Permissions, Roles } from '../common/decorators/roles.decorator';

class PreviewDto {
  @IsInt() @Min(1) points: number;
  @IsNumber() @Min(0) subtotal: number;
}

class AdjustDto {
  @IsInt() delta: number;
  @IsOptional() @IsString() reason?: string;
}

class ConfigDto {
  @IsOptional() @IsNumber() points_per_egp?: number;
  @IsOptional() @IsNumber() egp_per_point?: number;
  @IsOptional() @IsInt() min_redeem?: number;
  @IsOptional() @IsNumber() max_redeem_ratio?: number;
}

@ApiBearerAuth()
@ApiTags('loyalty')
@Controller('loyalty')
export class LoyaltyController {
  constructor(private readonly svc: LoyaltyService) {}

  @Get('config')
  config() {
    return this.svc.getConfig();
  }

  @Get('customer/:id')
  customer(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.getCustomerBalance(id);
  }

  @Get('customer/:id/history')
  history(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.history(id, limit ? Number(limit) : 100);
  }

  @Post('customer/:id/preview')
  preview(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PreviewDto,
  ) {
    return this.svc.preview(id, dto.points, dto.subtotal);
  }

  @Get('customers')
  @Permissions('loyalty.view')
  customers(
    @Query('q') q?: string,
    @Query('tier') tier?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.listCustomers({
      q,
      tier,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post('customer/:id/adjust')
  @Permissions('loyalty.adjust')
  adjust(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdjustDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.adjust(id, {
      delta: dto.delta,
      reason: dto.reason,
      user_id: user.userId,
    });
  }

  @Patch('config')
  @Permissions('loyalty.config')
  updateConfig(@Body() dto: ConfigDto) {
    return this.svc.updateConfig(dto);
  }
}
