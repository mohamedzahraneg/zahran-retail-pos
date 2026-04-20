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
import { IsNumber, Max, Min } from 'class-validator';
import { CommissionsService } from './commissions.service';
import { Roles } from '../common/decorators/roles.decorator';

class UpdateRateDto {
  @IsNumber()
  @Min(0)
  @Max(100)
  commission_rate: number;
}

@ApiBearerAuth()
@ApiTags('commissions')
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

  @Patch(':userId/rate')
  @Roles('admin', 'manager')
  updateRate(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateRateDto,
  ) {
    return this.svc.updateRate(userId, dto.commission_rate);
  }
}
