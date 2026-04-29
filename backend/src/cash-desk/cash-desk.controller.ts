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
import {
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
  Min,
} from 'class-validator';
import { CashDeskService } from './cash-desk.service';
import {
  CreateCustomerPaymentDto,
  CreateSupplierPaymentDto,
} from './dto/payment.dto';
import { Roles, Permissions } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  JwtUser,
} from '../common/decorators/current-user.decorator';

class VoidPaymentDto {
  @IsString() @MinLength(3) reason: string;
}

class CashDepositDto {
  @IsUUID() cashbox_id: string;
  @IsIn(['in', 'out']) direction: 'in' | 'out';
  @IsNumber() @Min(0.01) amount: number;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsDateString() txn_date?: string;
}

class CashboxCreateDto {
  @IsString() @MinLength(1) name_ar: string;
  @IsIn(['cash', 'bank', 'ewallet', 'check']) kind:
    | 'cash'
    | 'bank'
    | 'ewallet'
    | 'check';
  @IsOptional() @IsUUID() warehouse_id?: string;
  @IsOptional() @IsString() currency?: string;
  @IsOptional() @IsNumber() @Min(0) opening_balance?: number;
  @IsOptional() @IsString() color?: string;
  @IsOptional() @IsString() institution_code?: string;
  @IsOptional() @IsString() bank_branch?: string;
  @IsOptional() @IsString() account_number?: string;
  @IsOptional() @IsString() iban?: string;
  @IsOptional() @IsString() swift_code?: string;
  @IsOptional() @IsString() account_holder_name?: string;
  @IsOptional() @IsString() account_manager_name?: string;
  @IsOptional() @IsString() account_manager_phone?: string;
  @IsOptional() @IsString() account_manager_email?: string;
  @IsOptional() @IsString() wallet_phone?: string;
  @IsOptional() @IsString() wallet_owner_name?: string;
  @IsOptional() @IsString() check_issuer_name?: string;
  @IsOptional() @IsString() notes?: string;
}

/**
 * Update is partial — every field optional so lightweight calls like
 * `{ is_active: true }` don't fail validation.
 */
class CashboxUpdateDto {
  @IsOptional() @IsString() @MinLength(1) name_ar?: string;
  @IsOptional() @IsIn(['cash', 'bank', 'ewallet', 'check'])
  kind?: 'cash' | 'bank' | 'ewallet' | 'check';
  @IsOptional() @IsUUID() warehouse_id?: string;
  @IsOptional() @IsString() currency?: string;
  @IsOptional() @IsNumber() @Min(0) opening_balance?: number;
  @IsOptional() @IsString() color?: string;
  @IsOptional() @IsString() institution_code?: string;
  @IsOptional() @IsString() bank_branch?: string;
  @IsOptional() @IsString() account_number?: string;
  @IsOptional() @IsString() iban?: string;
  @IsOptional() @IsString() swift_code?: string;
  @IsOptional() @IsString() account_holder_name?: string;
  @IsOptional() @IsString() account_manager_name?: string;
  @IsOptional() @IsString() account_manager_phone?: string;
  @IsOptional() @IsString() account_manager_email?: string;
  @IsOptional() @IsString() wallet_phone?: string;
  @IsOptional() @IsString() wallet_owner_name?: string;
  @IsOptional() @IsString() check_issuer_name?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() is_active?: boolean;
}

class TransferDto {
  @IsUUID() from_cashbox_id: string;
  @IsUUID() to_cashbox_id: string;
  @IsNumber() @Min(0.01) amount: number;
  @IsOptional() @IsString() notes?: string;
}

@ApiBearerAuth()
@ApiTags('cash-desk')
@Permissions('cashdesk.view')
@Controller('cash-desk')
export class CashDeskController {
  constructor(private readonly svc: CashDeskService) {}

  @Get('cashboxes')
  cashboxes(@Query('include_inactive') includeInactive?: string) {
    return this.svc.listCashboxes(
      includeInactive === 'true' || includeInactive === '1',
    );
  }

  @Get('institutions')
  institutions(@Query('kind') kind?: 'bank' | 'ewallet' | 'check_issuer') {
    return this.svc.listInstitutions(kind);
  }

  @Post('cashboxes')
  @Roles('admin', 'manager', 'accountant')
  @Permissions('cashdesk.manage_accounts')
  createCashbox(
    @Body() dto: CashboxCreateDto,
    @CurrentUser() user: JwtUser,
  ) {
    // PR-FIN-PAYACCT-1: userId is threaded through so the engine-backed
    // opening JE has a real `created_by` / `posted_by` (not the legacy
    // 'system' literal). The service still falls back to 'system' if
    // userId is null for internal callers.
    return this.svc.createCashbox(dto, user.userId);
  }

  @Post('cashboxes/:id')
  @Roles('admin', 'manager', 'accountant')
  @Permissions('cashdesk.manage_accounts')
  updateCashbox(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CashboxUpdateDto,
  ) {
    return this.svc.updateCashbox(id, dto);
  }

  @Post('cashboxes/:id/delete')
  @Roles('admin', 'manager', 'accountant')
  @Permissions('cashdesk.manage_accounts')
  removeCashbox(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.removeCashbox(id);
  }

  @Post('transfer')
  @Roles('admin', 'manager', 'accountant')
  @Permissions('cashdesk.view')
  @ApiOperation({ summary: 'تحويل نقدية بين خزنتين' })
  transfer(@Body() dto: TransferDto, @CurrentUser() user: JwtUser) {
    return this.svc.transferBetweenCashboxes(dto, user.userId);
  }

  // ── Bank reconciliation ────────────────────────────────────────────

  @Get('reconciliation')
  @Permissions('accounts.reconcile')
  @ApiOperation({ summary: 'حركات للتسوية البنكية' })
  listReconciliation(
    @Query('cashbox_id', ParseUUIDPipe) cashbox_id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('status') status?: 'all' | 'reconciled' | 'open',
  ) {
    return this.svc.listReconciliation({ cashbox_id, from, to, status });
  }

  @Post('reconciliation/mark')
  @Permissions('accounts.reconcile')
  markReconciled(
    @Body() body: { txn_ids: string[]; reference?: string },
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.markReconciled(
      body.txn_ids,
      body.reference ?? null,
      user.userId,
    );
  }

  @Post('reconciliation/unmark')
  @Permissions('accounts.reconcile')
  unmarkReconciled(@Body() body: { txn_ids: string[] }) {
    return this.svc.unmarkReconciled(body.txn_ids);
  }

  @Post('reconciliation/auto-match')
  @Permissions('accounts.reconcile')
  @ApiOperation({ summary: 'مطابقة تلقائية لكشف بنك' })
  autoMatch(
    @Body()
    body: {
      cashbox_id: string;
      lines: Array<{
        date: string;
        amount: number;
        direction: 'in' | 'out';
        reference?: string;
      }>;
    },
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.autoMatchStatement(
      body.cashbox_id,
      body.lines || [],
      user.userId,
    );
  }

  @Get('cashflow/today')
  cashflowToday() {
    return this.svc.cashflowToday();
  }

  /**
   * PR-FIN-PAYACCT-4B — per-cashbox stored vs GL drift, sourced from
   * `v_cashbox_gl_drift`. Used by the Payment Accounts admin page's
   * accounting-alerts panel to surface cashbox-vs-GL variances. Read-only.
   */
  @Get('gl-drift')
  glDrift() {
    return this.svc.getGlDrift();
  }

  @Get('shift-variances')
  shiftVariances() {
    return this.svc.shiftVariances();
  }

  @Get('movements')
  movements(
    @Query('cashbox_id') cashbox_id?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('direction') direction?: 'in' | 'out',
    @Query('category') category?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.svc.movements({
      cashbox_id,
      from,
      to,
      direction,
      category,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  /**
   * PR-FIN-PAYACCT-4D-UX-FIX-4 — unified per-cashbox movements feed.
   *
   * Read-only union of:
   *   A) cashbox_transactions for this cashbox (direct cash flows)
   *   B) invoice_payments     where PA.cashbox_id = :id (linked)
   *   C) customer_payments    where PA.cashbox_id = :id (linked)
   *   D) supplier_payments    where PA.cashbox_id = :id (linked)
   *
   * Branches B/C/D dedupe against A by `(reference_type, reference_id)`
   * so the same logical operation is never counted twice. Filters
   * strictly by `payment_account_id → payment_accounts.cashbox_id`;
   * never by `gl_account_code` alone.
   *
   * Query params: from / to (ISO date), type
   * ('cashbox_txn' | 'invoice_payment' | 'customer_payment' | 'supplier_payment'),
   * q (free-text over reference_no + counterparty_name), limit / offset.
   */
  @Get('cashboxes/:id/movements-unified')
  cashboxMovementsUnified(
    @Param('id') id: string,
    @Query('from')   from?: string,
    @Query('to')     to?: string,
    @Query('type')   type?: string,
    @Query('q')      q?: string,
    @Query('limit')  limit?: string,
    @Query('offset') offset?: string,
  ) {
    const lim = limit  ? Number.parseInt(limit,  10) : undefined;
    const off = offset ? Number.parseInt(offset, 10) : undefined;
    return this.svc.cashboxMovementsUnified(id, {
      from, to, type, q,
      limit:  Number.isFinite(lim) ? (lim as number) : undefined,
      offset: Number.isFinite(off) ? (off as number) : undefined,
    });
  }

  // ── Customer receipts ────────────────────────────────────────────────
  @Post('customer-payments')
  @Roles('admin', 'manager', 'cashier', 'accountant')
  receive(
    @Body() dto: CreateCustomerPaymentDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.receiveFromCustomer(dto, user.userId);
  }

  @Get('customer-payments')
  listCustomer(@Query('customer_id') customerId?: string) {
    return this.svc.listCustomerPayments(customerId);
  }

  @Post('customer-payments/:id/void')
  @Roles('admin', 'manager')
  voidCustomer(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidPaymentDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.voidCustomerPayment(id, user.userId, dto.reason);
  }

  @Post('supplier-payments/:id/void')
  @Roles('admin', 'manager', 'accountant')
  voidSupplier(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidPaymentDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.voidSupplierPayment(id, user.userId, dto.reason);
  }

  // ── Supplier payments ───────────────────────────────────────────────
  @Post('supplier-payments')
  @Roles('admin', 'manager', 'accountant')
  pay(
    @Body() dto: CreateSupplierPaymentDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.payToSupplier(dto, user.userId);
  }

  @Get('supplier-payments')
  listSupplier(@Query('supplier_id') supplierId?: string) {
    return this.svc.listSupplierPayments(supplierId);
  }

  // ── Manual cashbox deposits / withdrawals (opening balance, top-ups) ──
  @Post('deposit')
  @Roles('admin', 'manager', 'accountant')
  deposit(@Body() dto: CashDepositDto, @CurrentUser() user: JwtUser) {
    return this.svc.deposit(dto, user.userId);
  }
}
