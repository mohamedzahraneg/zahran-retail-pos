import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InventoryCountsService } from './inventory-counts.service';
import {
  StartCountDto,
  SubmitCountDto,
  FinalizeCountDto,
} from './dto/inventory-count.dto';
import { Roles, Permissions } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  JwtUser,
} from '../common/decorators/current-user.decorator';
// PR-FIX-IDEMPOTENCY-DEFERRED-APPROVE-FAMILY (Sprint 4 / PR-11F-bis)
// Opt-in Idempotency-Key support on POST /inventory-counts/:id/finalize.
// Without the header, behavior is exactly unchanged. Deferred from
// PR-11F because this module needed new IdempotencyCacheService +
// IdempotencyInterceptor providers (added alongside in this same PR).
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';

@ApiBearerAuth()
@ApiTags('inventory-counts')
@Permissions('inventory.count')
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
  // PR-FIX-IDEMPOTENCY-DEFERRED-APPROVE-FAMILY (Sprint 4 / PR-11F-bis)
  // Multi-stage finalization: applies stock variance adjustments
  // (UPDATE stock + INSERT stock_movements per variance) + posts
  // adjustment JE for the net P/L impact + transitions count to
  // `finalized` status. State-guarded by status check; HTTP
  // interceptor adds outer race defence on retry.
  @UseInterceptors(IdempotencyInterceptor)
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
