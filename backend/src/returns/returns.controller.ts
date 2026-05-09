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
import { ReturnsService } from './returns.service';
import { ReturnsAuditService } from './returns-audit.service';
import { ReturnEditRequestsService } from './return-edit-requests.service';
import {
  ApplyEditRequestDto,
  ApproveReturnDto,
  CancelReturnDto,
  CreateEditRequestDto,
  CreateExchangeDto,
  CreateReturnDto,
  ListReturnsQueryDto,
  RefundReturnDto,
  RejectReturnDto,
  ReviewEditRequestDto,
} from './dto/return.dto';
import { Roles, Permissions } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  JwtUser,
} from '../common/decorators/current-user.decorator';
// PR-FIX-IDEMPOTENCY-EXCHANGES-INVOICE-EDITS (Sprint 4 / PR-11C) —
// opt-in Idempotency-Key support on POST /exchanges. Without the
// header, behavior is exactly unchanged from today.
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';

@ApiBearerAuth()
@ApiTags('returns')
@Permissions('returns.view')
@Controller()
export class ReturnsController {
  constructor(
    private readonly svc: ReturnsService,
    private readonly auditSvc: ReturnsAuditService,
    private readonly editReqSvc: ReturnEditRequestsService,
  ) {}

  // -------- Lookup invoice for return --------------------------------------
  @Get('returns/lookup/:invoice_no')
  @ApiOperation({
    summary: 'البحث عن فاتورة باستخدام رقمها لتحديد الأصناف المتاحة للإرجاع',
  })
  lookupInvoice(@Param('invoice_no') invoiceNo: string) {
    return this.svc.lookupInvoice(invoiceNo);
  }

  // -------- Returns ---------------------------------------------------------
  @Post('returns')
  @Roles('admin', 'manager', 'cashier')
  @ApiOperation({ summary: 'إنشاء مرتجع جديد (pending)' })
  create(@Body() dto: CreateReturnDto, @CurrentUser() user: JwtUser) {
    return this.svc.createReturn(dto, user.userId);
  }

  @Get('returns')
  @ApiOperation({ summary: 'قائمة المرتجعات مع فلاتر' })
  list(@Query() q: ListReturnsQueryDto) {
    return this.svc.list(q);
  }

  @Get('returns/:id')
  @ApiOperation({ summary: 'تفاصيل مرتجع' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.findOne(id);
  }

  @Post('returns/:id/approve')
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'اعتماد المرتجع (يُعيد المخزون)' })
  // PR-FIX-IDEMPOTENCY-APPROVE-FAMILY (Sprint 4 / PR-11F) —
  // `approve` calls `fn_adjust_stock` for each resellable item
  // (positive delta = stock-in to source warehouse). State guard
  // `status='pending'` exists, but a duplicate POST during a
  // network retry could race the state check and double-restore
  // stock. Refund posts JE/CT in a separate route — this approve
  // path is stock-only.
  @UseInterceptors(IdempotencyInterceptor)
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveReturnDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.approve(id, dto, user.userId);
  }

  @Post('returns/:id/refund')
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'صرف قيمة المرتجع للعميل' })
  // PR-FIX-IDEMPOTENCY-VOID-CANCEL-REFUND-FAMILY (Sprint 4 / PR-11E) —
  // P0 in this PR. `refund` writes a FRESH JE + CT per call (cash
  // path uses engine.recordCashOnlyMovement; non-cash uses standard
  // recordTransaction). Engine guard exists on (reference_type=
  // 'return_refund', reference_id) but the state guard `status=
  // 'approved'` doesn't fully serialize concurrent retries. The
  // Redis-backed interceptor's 60s lock + 24h replay is the cleaner
  // outer defence. Without an Idempotency-Key header, behavior is
  // exactly unchanged from today.
  @UseInterceptors(IdempotencyInterceptor)
  refund(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RefundReturnDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.refund(id, dto, user.userId, user.permissions ?? []);
  }

  @Post('returns/:id/reject')
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'رفض المرتجع' })
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectReturnDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.reject(id, dto, user.userId);
  }

  // PR-FIN-RETURNS-UX-1C — admin-only cancellation. Stacks @Roles
  // (admin only) AND @Permissions('returns.cancel') — both must pass.
  // Method-level @Permissions overrides the class-level
  // @Permissions('returns.view') via PermissionsGuard's
  // getAllAndOverride. Existing approve/refund/reject roles remain
  // untouched.
  @Post('returns/:id/cancel')
  @Roles('admin')
  @Permissions('returns.cancel')
  @ApiOperation({
    summary:
      'إلغاء مرتجع — أدمن فقط (يعكس النقد والمخزون والقيد المحاسبي)',
  })
  // PR-FIX-IDEMPOTENCY-VOID-CANCEL-REFUND-FAMILY (Sprint 4 / PR-11E) —
  // multi-stage reversal: voids JE via reverseByReference + reverses
  // paired cashbox transactions + INSERTs reversing stock_movements
  // for back_to_stock items. Engine guard catches the JE leg; stock
  // writes are cancellation-linkage-guarded; HTTP interceptor adds
  // outer defence + cleaner UX on retry.
  @UseInterceptors(IdempotencyInterceptor)
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelReturnDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.cancel(id, dto, user.userId);
  }

  // -------- Exchanges -------------------------------------------------------
  @Post('exchanges')
  @Roles('admin', 'manager', 'cashier')
  @ApiOperation({
    summary:
      'إرجاع منتج واستبداله بآخر في خطوة واحدة (مع حساب فرق السعر)',
  })
  // PR-FIX-IDEMPOTENCY-EXCHANGES-INVOICE-EDITS (Sprint 4 / PR-11C) —
  // exchanges have the largest blast radius of any route in the
  // system: a single POST writes a `returns` row + `return_items`,
  // a new `invoices` row + `invoice_items` + `invoice_payments`, and
  // both inbound and outbound `stock_movements`, plus the engine
  // posts JE/CT for both the refund and the new sale. A duplicate
  // POST during a network retry could partially apply some of these
  // stages before the engine guard catches the JE leg, leaving an
  // orphan return + invoice pair pointing at the same physical
  // goods. The Redis-backed interceptor's 60s lock + 24h replay is
  // the cleaner outer defence. Without an Idempotency-Key header,
  // behavior is exactly unchanged from today.
  @UseInterceptors(IdempotencyInterceptor)
  exchange(@Body() dto: CreateExchangeDto, @CurrentUser() user: JwtUser) {
    return this.svc.createExchange(dto, user.userId, user.permissions ?? []);
  }

  @Get('exchanges')
  @ApiOperation({ summary: 'قائمة عمليات الاستبدال' })
  listExchanges(@Query() q: ListReturnsQueryDto) {
    return this.svc.listExchanges(q);
  }

  @Get('exchanges/:id')
  @ApiOperation({ summary: 'تفاصيل عملية استبدال' })
  getExchange(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.getExchange(id);
  }

  // ─── Audit history (Phase 1 — read-only) ──────────────────────────
  // PR-FIN-RETURNS-EXCHANGES-AUDIT — both endpoints inherit the
  // class-level @Permissions('returns.view') gate.  Read-only
  // composition of audit_logs (DB-trigger row diffs — coverage lands
  // in migration 124) + activity_logs (high-level user actions) +
  // a Phase-4 amendments placeholder.  No mutation endpoints in
  // Phase 1.
  @Get('returns/:id/audit')
  @ApiOperation({ summary: 'سجل التعديلات على المرتجع' })
  getReturnAudit(@Param('id', ParseUUIDPipe) id: string) {
    return this.auditSvc.getReturnAudit(id);
  }

  @Get('exchanges/:id/audit')
  @ApiOperation({ summary: 'سجل التعديلات على الاستبدال' })
  getExchangeAudit(@Param('id', ParseUUIDPipe) id: string) {
    return this.auditSvc.getExchangeAudit(id);
  }

  // ─── Edit-request workflow (Phase 1 — request + review only) ───
  // PR-FIN-RETURNS-EXCHANGES-EDIT-REQUESTS:
  //   · Creating a request DOES NOT modify the parent return /
  //     exchange or its items.  Approval / rejection ONLY changes
  //     the request row's status.  Direct application of the
  //     requested payload is a later phase.
  //   · Roles mirror the existing returns lifecycle convention:
  //     create = admin/manager/cashier (same as createReturn /
  //     createExchange), review = admin only (same as cancel).
  //   · IdempotencyInterceptor on every mutation route, mirroring
  //     PR-FIX-IDEMPOTENCY-VOID-CANCEL-REFUND-FAMILY.

  @Get('returns/:id/edit-requests')
  @ApiOperation({ summary: 'قائمة طلبات تعديل المرتجع' })
  listReturnEditRequests(@Param('id', ParseUUIDPipe) id: string) {
    return this.editReqSvc.list('return', id);
  }

  @Post('returns/:id/edit-requests')
  @Roles('admin', 'manager', 'cashier')
  @ApiOperation({
    summary:
      'إنشاء طلب تعديل لمرتجع — حالة pending، لا يُطبَّق التعديل.',
  })
  @UseInterceptors(IdempotencyInterceptor)
  createReturnEditRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateEditRequestDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.editReqSvc.create({
      entity: 'return',
      parent_id: id,
      requested_action: dto.requested_action,
      requested_payload: dto.requested_payload,
      reason_text: dto.reason_text,
      user_id: user.userId,
    });
  }

  @Post('returns/:id/edit-requests/:requestId/approve')
  @Roles('admin')
  @ApiOperation({
    summary:
      'اعتماد طلب تعديل مرتجع — يحدّث حالة الطلب فقط، لا يُطبِّق التعديل.',
  })
  @UseInterceptors(IdempotencyInterceptor)
  approveReturnEditRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: ReviewEditRequestDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.editReqSvc.approve({
      entity: 'return',
      request_id: requestId,
      user_id: user.userId,
      review_notes: dto.review_notes ?? null,
    });
  }

  @Post('returns/:id/edit-requests/:requestId/reject')
  @Roles('admin')
  @ApiOperation({
    summary: 'رفض طلب تعديل مرتجع — ملاحظات المراجعة مطلوبة.',
  })
  @UseInterceptors(IdempotencyInterceptor)
  rejectReturnEditRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: ReviewEditRequestDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.editReqSvc.reject({
      entity: 'return',
      request_id: requestId,
      user_id: user.userId,
      review_notes: dto.review_notes ?? null,
    });
  }

  @Get('exchanges/:id/edit-requests')
  @ApiOperation({ summary: 'قائمة طلبات تعديل الاستبدال' })
  listExchangeEditRequests(@Param('id', ParseUUIDPipe) id: string) {
    return this.editReqSvc.list('exchange', id);
  }

  @Post('exchanges/:id/edit-requests')
  @Roles('admin', 'manager', 'cashier')
  @ApiOperation({
    summary:
      'إنشاء طلب تعديل لاستبدال — حالة pending، لا يُطبَّق التعديل.',
  })
  @UseInterceptors(IdempotencyInterceptor)
  createExchangeEditRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateEditRequestDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.editReqSvc.create({
      entity: 'exchange',
      parent_id: id,
      requested_action: dto.requested_action,
      requested_payload: dto.requested_payload,
      reason_text: dto.reason_text,
      user_id: user.userId,
    });
  }

  @Post('exchanges/:id/edit-requests/:requestId/approve')
  @Roles('admin')
  @ApiOperation({
    summary:
      'اعتماد طلب تعديل استبدال — يحدّث حالة الطلب فقط.',
  })
  @UseInterceptors(IdempotencyInterceptor)
  approveExchangeEditRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: ReviewEditRequestDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.editReqSvc.approve({
      entity: 'exchange',
      request_id: requestId,
      user_id: user.userId,
      review_notes: dto.review_notes ?? null,
    });
  }

  @Post('exchanges/:id/edit-requests/:requestId/reject')
  @Roles('admin')
  @ApiOperation({
    summary: 'رفض طلب تعديل استبدال — ملاحظات المراجعة مطلوبة.',
  })
  @UseInterceptors(IdempotencyInterceptor)
  rejectExchangeEditRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: ReviewEditRequestDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.editReqSvc.reject({
      entity: 'exchange',
      request_id: requestId,
      user_id: user.userId,
      review_notes: dto.review_notes ?? null,
    });
  }

  // ─── Edit-request APPLY (Phase 2A — admin-only, return-only) ───
  // PR-FIN-RETURNS-EXCHANGES-EDIT-REQUESTS-APPLY:
  //   · Return apply runs the reverse-and-replay strategy in a
  //     single DB transaction (see ReturnEditRequestsService for the
  //     exact step list + safety invariants).
  //   · Exchange apply intentionally returns 501 in this PR; the full
  //     implementation lands in Phase 2B with its own design report.
  //   · Both endpoints are gated with @Roles('admin') (mirrors the
  //     approve/reject gate; the BE is the source of truth) and the
  //     IdempotencyInterceptor (third layer of double-apply
  //     protection on top of FOR-UPDATE + applied_at IS NULL check).

  @Post('returns/:id/edit-requests/:requestId/apply')
  @Roles('admin')
  @ApiOperation({
    summary:
      'تطبيق طلب تعديل مرتجع معتمد — يحدّث البنود/الإجمالي ويعيد قيد ' +
      'الجزء المالي والمخزني عند الحاجة. تطبيق مرة واحدة فقط.',
  })
  @UseInterceptors(IdempotencyInterceptor)
  applyReturnEditRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: ApplyEditRequestDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.editReqSvc.applyApprovedReturn({
      entity: 'return',
      parent_id: id,
      request_id: requestId,
      user_id: user.userId,
      cashbox_id: dto.cashbox_id ?? null,
      shift_id: dto.shift_id ?? null,
      notes: dto.notes ?? null,
    });
  }

  @Post('exchanges/:id/edit-requests/:requestId/apply')
  @Roles('admin')
  @ApiOperation({
    summary:
      'تطبيق طلب تعديل استبدال — Phase 2A: يعيد 501 (قيد الإعداد).',
  })
  @UseInterceptors(IdempotencyInterceptor)
  applyExchangeEditRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: ApplyEditRequestDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.editReqSvc.applyApprovedExchange({
      entity: 'exchange',
      parent_id: id,
      request_id: requestId,
      user_id: user.userId,
      cashbox_id: dto.cashbox_id ?? null,
      shift_id: dto.shift_id ?? null,
      notes: dto.notes ?? null,
    });
  }
}
