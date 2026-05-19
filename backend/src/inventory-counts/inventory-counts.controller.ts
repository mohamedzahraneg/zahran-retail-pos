/**
 * inventory-counts.controller.ts — PR-INVENTORY-COUNTS-WORKFLOW
 *
 * Branch-aware stocktaking endpoints. The legacy `start` and
 * `entries` routes are preserved as aliases for `create+freeze` and
 * `update-items`, respectively, so the existing FE keeps working
 * unchanged.
 */
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { InventoryCountsService } from './inventory-counts.service';
import {
  CancelCountDto,
  CreateCountDto,
  FinalizeCountDto,
  FreezeCountDto,
  StartCountDto,
  SubmitCountDto,
} from './dto/inventory-count.dto';
import { Roles, Permissions } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  JwtUser,
} from '../common/decorators/current-user.decorator';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';

@ApiBearerAuth()
@ApiTags('inventory-counts')
@Permissions('inventory.count')
@Controller('inventory-counts')
export class InventoryCountsController {
  constructor(private readonly svc: InventoryCountsService) {}

  // ─── Create header only (no snapshot) ───────────────────────────
  @Post()
  @Roles('admin', 'manager', 'stock_keeper')
  @ApiOperation({
    summary: 'إنشاء جلسة جرد (مسودة) — بدون تحريك مخزون',
  })
  @UseInterceptors(IdempotencyInterceptor)
  create(@Body() dto: CreateCountDto, @CurrentUser() user: JwtUser) {
    return this.svc.create(dto, user.userId);
  }

  // ─── Freeze: snapshot stock into items ──────────────────────────
  @Post(':id/freeze')
  @Roles('admin', 'manager', 'stock_keeper')
  @ApiOperation({
    summary: 'تجميد رصيد المخزن في عناصر الجرد (مسودة → فتح) — لا يحرك مخزون',
  })
  @UseInterceptors(IdempotencyInterceptor)
  freeze(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FreezeCountDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.freeze(id, dto ?? {}, user.userId);
  }

  // ─── Legacy start (create + freeze in one step) ─────────────────
  @Post('start')
  @Roles('admin', 'manager', 'stock_keeper')
  @ApiOperation({ summary: 'بدء جرد جديد (إنشاء + تجميد في خطوة واحدة)' })
  @UseInterceptors(IdempotencyInterceptor)
  start(@Body() dto: StartCountDto, @CurrentUser() user: JwtUser) {
    return this.svc.start(dto, user.userId);
  }

  // ─── Update counted quantities ──────────────────────────────────
  @Patch(':id/items')
  @Roles('admin', 'manager', 'stock_keeper')
  @ApiOperation({
    summary: 'تعديل الكميات المعدودة — لا يحرك مخزون',
  })
  updateItems(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SubmitCountDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.updateItems(id, dto, user.userId);
  }

  // Legacy alias preserved so the existing FE keeps working.
  @Post(':id/entries')
  @Roles('admin', 'manager', 'stock_keeper')
  @ApiOperation({
    summary: 'إدخال الكميات المعدودة (alias تاريخي لـ PATCH /items)',
  })
  submitEntries(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SubmitCountDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.updateItems(id, dto, user.userId);
  }

  // ─── Move to review ─────────────────────────────────────────────
  @Post(':id/review')
  @Roles('admin', 'manager', 'stock_keeper')
  @ApiOperation({
    summary: 'نقل الجرد إلى مرحلة المراجعة — لا يحرك مخزون',
  })
  @UseInterceptors(IdempotencyInterceptor)
  review(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.review(id, user.userId);
  }

  // ─── Finalize (apply variances via v2) ──────────────────────────
  @Post(':id/finalize')
  @Roles('admin', 'manager', 'stock_keeper')
  @ApiOperation({
    summary:
      'اعتماد الجرد وتطبيق الفروقات عبر fn_adjust_stock_v2',
  })
  @UseInterceptors(IdempotencyInterceptor)
  finalize(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FinalizeCountDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.finalize(id, dto, user.userId);
  }

  // ─── Cancel pre-finalize ────────────────────────────────────────
  @Post(':id/cancel')
  @Roles('admin', 'manager', 'stock_keeper')
  @ApiOperation({
    summary: 'إلغاء الجرد قبل الاعتماد — لا يحرك مخزون',
  })
  @UseInterceptors(IdempotencyInterceptor)
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelCountDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.cancel(id, dto ?? {}, user.userId);
  }

  // ─── Reads ──────────────────────────────────────────────────────
  @Get()
  @ApiOperation({ summary: 'قائمة الجرد' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'warehouse_id', required: false })
  @ApiQuery({ name: 'branch_id', required: false })
  @ApiQuery({ name: 'date_from', required: false })
  @ApiQuery({ name: 'date_to', required: false })
  @ApiQuery({ name: 'search', required: false })
  list(
    @Query('status') status?: string,
    @Query('warehouse_id', new ParseUUIDPipe({ optional: true }))
    warehouseId?: string,
    @Query('branch_id', new ParseUUIDPipe({ optional: true }))
    branchId?: string,
    @Query('date_from') dateFrom?: string,
    @Query('date_to') dateTo?: string,
    @Query('search') search?: string,
  ) {
    return this.svc.list({
      status,
      warehouse_id: warehouseId,
      branch_id: branchId,
      date_from: dateFrom,
      date_to: dateTo,
      search,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'تفاصيل جرد' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.findOne(id);
  }
}
