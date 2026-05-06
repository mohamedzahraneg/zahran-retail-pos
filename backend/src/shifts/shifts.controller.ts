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
import { ShiftsService } from './shifts.service';
import {
  ApproveCloseDto,
  CloseShiftDto,
  OpenShiftDto,
} from './dto/shift.dto';
import { Roles, Permissions } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  JwtUser,
} from '../common/decorators/current-user.decorator';
import { AggregateDetailDto } from './dto/aggregate-detail.dto';
import { ListLiveSummaryDto } from './dto/list-live-summary.dto';
// PR-FIX-IDEMPOTENCY-DIRECT-CT-WRITES (Sprint 4 / PR-11A) — opt-in
// Idempotency-Key support on POST /shifts/:id/adjust-count. Without
// the header, behavior is exactly unchanged from today.
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';

@ApiBearerAuth()
@ApiTags('shifts')
@Permissions('shifts.open')
@Controller('shifts')
export class ShiftsController {
  constructor(private readonly svc: ShiftsService) {}

  @Post('open')
  @Roles('admin', 'manager', 'cashier')
  @ApiOperation({ summary: 'فتح وردية جديدة' })
  open(@Body() dto: OpenShiftDto, @CurrentUser() user: JwtUser) {
    return this.svc.open(dto, user.userId);
  }

  @Post(':id/close')
  @Roles('admin', 'manager', 'cashier')
  @ApiOperation({ summary: 'إغلاق الوردية + احتساب الفروقات' })
  // PR-FIX-IDEMPOTENCY-APPROVE-FAMILY (Sprint 4 / PR-11F) — direct
  // close (cashier path). Posts a shift_variance JE + paired CT
  // when variance ≠ 0. State guard `status='open'`. Engine guard on
  // `(reference_type='shift_variance', reference_id)` catches dup,
  // but the close button is double-click-prone in stress.
  @UseInterceptors(IdempotencyInterceptor)
  close(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseShiftDto,
    @CurrentUser() user: JwtUser,
  ) {
    // Pass the caller's effective permissions to the service so it can
    // enforce `shifts.variance.approve` when the shift has a non-zero
    // variance (migration 060). Cashiers without the flag get a clear
    // 403 instead of silently posting to the GL.
    return this.svc.close(id, dto, user.userId, user.permissions ?? []);
  }

  @Post(':id/request-close')
  @Permissions('shifts.close')
  @ApiOperation({ summary: 'طلب إقفال الوردية (ينتظر اعتماد المدير)' })
  requestClose(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseShiftDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.requestClose(
      id,
      { actual_closing: (dto as any).actual_closing, notes: (dto as any).notes },
      user.userId,
    );
  }

  @Get('pending-close')
  @Permissions('shifts.close_approve')
  @ApiOperation({ summary: 'الورديات بانتظار اعتماد الإقفال' })
  pendingCloses() {
    return this.svc.listPendingCloses();
  }

  @Post(':id/approve-close')
  // PermissionsGuard requires ALL listed, so we list a single code that
  // covers the same audience (admin + manager). Migration 060 grants
  // `shifts.variance.approve` to both roles; admin's `*` wildcard
  // trivially passes anyway.
  @Permissions('shifts.variance.approve')
  @ApiOperation({ summary: 'اعتماد طلب إقفال وردية + اختيار معالجة الفروقات' })
  // PR-FIX-IDEMPOTENCY-APPROVE-FAMILY (Sprint 4 / PR-11F) — terminal
  // close (manager-approval path). Same JE/CT side effects as
  // `close` above but on a request_close → approved transition.
  // State guard `status='pending_close'`.
  @UseInterceptors(IdempotencyInterceptor)
  approveClose(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveCloseDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.approveClose(id, user.userId, dto);
  }

  @Post(':id/reject-close')
  @Permissions('shifts.close_approve')
  @ApiOperation({ summary: 'رفض طلب إقفال وردية' })
  rejectClose(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { reason: string },
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.rejectClose(id, user.userId, body?.reason);
  }

  @Get()
  @ApiOperation({ summary: 'قائمة الورديات' })
  list(
    @Query('status') status?: string,
    @Query('user_id') userId?: string,
    @Query('cashbox_id') cashboxId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.svc.list(status, userId, cashboxId, from, to);
  }

  @Get('current')
  @ApiOperation({ summary: 'الوردية المفتوحة للمستخدم الحالي' })
  current(@CurrentUser() user: JwtUser) {
    return this.svc.currentOpen(user.userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'تفاصيل وردية' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.findOne(id);
  }

  @Get(':id/summary')
  @ApiOperation({ summary: 'ملخص مالي حي للوردية (للإقفال والمتابعة)' })
  summary(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.summary(id);
  }

  // ─── PR-SHIFT-REPORTS-AGGREGATED-DETAIL-BE ──────────────────────
  // POST /shifts/reports/aggregate-detail
  // Consolidated detailed report across N selected shifts (max 50).
  // Selection wins over filters when both are supplied. JSON only;
  // PDF/XLSX deferred to a follow-up. Existing single-shift summary
  // and shifts list endpoints are unchanged.
  // ────────────────────────────────────────────────────────────────
  @Post('reports/aggregate-detail')
  @ApiOperation({
    summary:
      'تقرير مفصل مجمّع للورديات المحددة أو ناتج الفلاتر الحالية',
  })
  aggregateDetail(
    @Body() dto: AggregateDetailDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.aggregateDetail(
      { shift_ids: dto.shift_ids, filters: dto.filters },
      { user_id: user.userId, username: user.username ?? null },
    );
  }

  // ─── PR-FIX-SHIFTS-PAGE-BULK-LIVE-VARIANCE ──────────────────────
  // POST /shifts/reports/list-live-summary
  // Lightweight bulk live-summary for the Shifts list page
  // (replaces the per-row N×summary fan-out that exhausted the
  // Supavisor pooler). Body: { shift_ids: string[] } (max 100).
  // Returns one row per shift with cash-only expected/actual/
  // variance + cash/non-cash totals + invoice/sales counts.
  // ────────────────────────────────────────────────────────────────
  @Post('reports/list-live-summary')
  @ApiOperation({
    summary:
      'ملخص LIVE خفيف لقائمة الورديات (5 استعلامات مجمّعة بدون fan-out)',
  })
  listLiveSummary(@Body() dto: ListLiveSummaryDto) {
    return this.svc.listLiveSummary(dto.shift_ids);
  }

  // ─── PR-B1 — Counted-cash adjustment workflow (migration 096) ───
  // POST /shifts/:id/adjust-count → permission-gated correction
  // GET  /shifts/:id/adjustments  → audit history (any viewer)
  // ────────────────────────────────────────────────────────────────

  @Post(':id/adjust-count')
  @Permissions('shifts.close.adjust')
  @ApiOperation({ summary: 'تعديل مبلغ الإقفال للوردية (تصحيح العد)' })
  // PR-FIX-IDEMPOTENCY-DIRECT-CT-WRITES (Sprint 4 / PR-11A) — second
  // P0 direct-CT writer protected (the other is POST /cash-desk/deposit).
  // `adjustCount` is hand-rolled and writes to cashbox_transactions
  // outside the FinancialEngine path, so the engine-level
  // (reference_type, reference_id) guard does NOT cover it.
  // Operator double-clicks on the variance-adjustment button were the
  // motivating risk. Without an Idempotency-Key header, behavior is
  // exactly unchanged from today (no protection).
  @UseInterceptors(IdempotencyInterceptor)
  adjustCount(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { new_actual_closing: number; reason: string },
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.adjustCount(id, body, user.userId);
  }

  @Get(':id/adjustments')
  @ApiOperation({ summary: 'سجل تعديلات مبلغ الإقفال للوردية' })
  listAdjustments(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.listAdjustments(id);
  }
}
