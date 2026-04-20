import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsInt, IsNumber, Min } from 'class-validator';
import { LoyaltyService } from './loyalty.service';

class PreviewDto {
  @IsInt() @Min(1) points: number;
  @IsNumber() @Min(0) subtotal: number;
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
}
