import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InventoryCountsService } from './inventory-counts.service';
import {
  StartCountDto,
  SubmitCountDto,
  FinalizeCountDto,
} from './dto/inventory-count.dto';
import { Roles } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  JwtUser,
} from '../common/decorators/current-user.decorator';

@ApiBearerAuth()
@ApiTags('inventory-counts')
@Controller('inventory-counts')
export class InventoryCountsController {
  constructor(private readonly svc: InventoryCountsService) {}

  @Post('start')
  @Roles('admin', 'manager', 'stock_keeper')
  @ApiOperation({ summary: 'بدء جرد جديد (تجميد كميات النظام)' })
  start(@Body() dto: StartCountDto, @CurrentUser() user: JwtUser) {
    return this.svc.start(dto, user.userId);
  }

  @Post(':id/entries')
  @Roles('admin', 'manager', 'stock_keeper')
  @ApiOperation({ summary: 'إدخال كميات الجرد الفعلي' })
  submitEntries(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SubmitCountDto,
  ) {
    return this.svc.submitEntries(id, dto);
  }

  @Post(':id/finalize')
  @Roles('admin', 'manager', 'stock_keeper')
  @ApiOperation({
    summary: 'إنهاء الجرد وتطبيق الفروقات على المخزون',
  })
  finalize(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FinalizeCountDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.finalize(id, dto, user.userId);
  }

  @Post(':id/cancel')
  @Roles('admin', 'manager', 'stock_keeper')
  @ApiOperation({ summary: 'إلغاء الجرد (دون تطبيق فروقات)' })
  cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.cancel(id);
  }

  @Get()
  @ApiOperation({ summary: 'قائمة عمليات الجرد' })
  list(
    @Query('status') status?: string,
    @Query('warehouse_id') warehouseId?: string,
  ) {
    return this.svc.list(status, warehouseId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'تفاصيل جرد' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.findOne(id);
  }
}
