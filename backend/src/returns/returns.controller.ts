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
import {
  ApproveReturnDto,
  CancelReturnDto,
  CreateExchangeDto,
  CreateReturnDto,
  ListReturnsQueryDto,
  RefundReturnDto,
  RejectReturnDto,
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
  constructor(private readonly svc: ReturnsService) {}

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
}
