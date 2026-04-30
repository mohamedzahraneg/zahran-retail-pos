import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import {
  BackfillUnattachedDto,
  CreatePaymentAccountDto,
  UpdatePaymentAccountDto,
} from './dto/payment-account.dto';
import { PaymentsService } from './payments.service';

/**
 * PR-FIN-PAYACCT-4D-UX-FIX-9-HOTFIX-1 — route ordering invariant
 * ──────────────────────────────────────────────────────────────────
 *
 * NestJS / Express resolves routes in DECLARATION ORDER and the
 * `:id` placeholder matches any single-segment path. So if a static
 * route like `payment-accounts/unattached-summary` is declared AFTER
 * `payment-accounts/:id`, the dynamic one wins and `getById()` runs
 * with `id="unattached-summary"` — Postgres then throws
 * `invalid input syntax for type uuid: "unattached-summary"` because
 * `payment_accounts.id` is a uuid.
 *
 * Invariant: every static path under `payment-accounts/...` MUST be
 * declared above `@Get('payment-accounts/:id')`. Routes below that
 * line use the `:id` placeholder.
 *
 * Defense in depth: every `:id` parameter is bound through
 * `ParseUUIDPipe` so a slug that somehow slips past route matching
 * (e.g. a typo'd path on the FE) returns a clean 400 BadRequest
 * instead of a Postgres uuid-coercion 500.
 *
 * The accompanying spec file `payments.controller.spec.ts` reflects
 * on the controller's route metadata at test time and asserts every
 * static route appears before its dynamic sibling — anyone reordering
 * methods will hit a clear test failure.
 */
@ApiTags('payments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class PaymentsController {
  constructor(private readonly service: PaymentsService) {}

  // ─── Static GETs (must come before any `:id` GET) ──────────────────

  /**
   * Static provider catalog (InstaPay / wallets / cards / banks). Open
   * to any authenticated user — POS reads it to render the rich
   * selector in PR-PAY-3.
   */
  @Get('payment-providers')
  listProviders() {
    return this.service.listProviders();
  }

  /**
   * Active payment accounts (admin-managed channels). Any
   * authenticated user can list — admin-only mutations are below.
   */
  @Get('payment-accounts')
  list(
    @Query('method') method?: string,
    @Query('active') active?: string,
  ) {
    return this.service.list({ method, active });
  }

  /**
   * PR-FIN-PAYACCT-4B — same shape as `list`, plus per-account
   * running-balance columns. Used by the unified treasury page's
   * KPI cards + per-row balance column. Read-only.
   */
  @Get('payment-accounts/balances')
  listBalances(
    @Query('method') method?: string,
    @Query('active') active?: string,
  ) {
    return this.service.listBalances({ method, active });
  }

  /**
   * PR-FIN-PAYACCT-4D-UX-FIX-9 — read-only summary of unattached
   * historical payment rows for the operator-facing reconciliation
   * panel on /cashboxes. One row per (table, payment_method) bucket
   * with `supported` + `status_message` so the FE renders the right
   * action (or explanation).
   *
   * Pure SELECT. Any authenticated user can read.
   *
   * PR-FIN-PAYACCT-4D-UX-FIX-9-HOTFIX-1: this STATIC route MUST
   * appear above `@Get('payment-accounts/:id')` below — otherwise
   * the dynamic placeholder captures `unattached-summary` as an id.
   */
  @Get('payment-accounts/unattached-summary')
  unattachedSummary() {
    return this.service.unattachedSummary();
  }

  /**
   * PR-FIN-PAYACCT-4D — payment-method usage in the trailing 30 days.
   * Wraps `v_dashboard_payment_mix_30d` (already populated; no
   * migration). Used by the unified treasury page's "أكثر الطرق
   * استخدامًا آخر 30 يوم" card. The `days` query param is accepted
   * for forward-compat but currently ignored (view window is fixed
   * at 30).
   */
  @Get('payments/method-mix')
  methodMix(@Query('days') days?: string) {
    const n = days ? Number.parseInt(days, 10) : 30;
    return this.service.methodMix(Number.isFinite(n) && n > 0 ? n : 30);
  }

  // ─── Dynamic GETs (must come AFTER all static GETs above) ──────────

  @Get('payment-accounts/:id')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.getById(id);
  }

  /**
   * PR-FIN-PAYACCT-4D-UX-FIX-2 — read-only feed of operations for the
   * specified payment account. Strictly filtered by payment_account_id
   * (never by gl_account_code), so accounts that share a GL bucket
   * don't see each other's rows. Source is the union of
   * `invoice_payments`, `customer_payments`, and `supplier_payments`
   * tagged with this account, joined to `journal_entries` for the
   * linked posting reference.
   *
   * Query params:
   *   from, to    — ISO dates (inclusive) on `created_at`
   *   type        — 'invoice_payment' | 'customer_payment' | 'supplier_payment'
   *   q           — free-text search over `reference_no` + `counterparty_name`
   *   limit       — page size (default 20, max 200)
   *   offset      — page offset (default 0)
   *
   * Response: `{ rows, total, totals: { in, out, net, count } }`.
   */
  @Get('payment-accounts/:id/movements')
  listMovements(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('from')   from?: string,
    @Query('to')     to?: string,
    @Query('type')   type?: string,
    @Query('q')      q?: string,
    @Query('limit')  limit?: string,
    @Query('offset') offset?: string,
  ) {
    const lim = limit  ? Number.parseInt(limit,  10) : undefined;
    const off = offset ? Number.parseInt(offset, 10) : undefined;
    return this.service.listMovements(id, {
      from,
      to,
      type,
      q,
      limit:  Number.isFinite(lim) ? (lim as number) : undefined,
      offset: Number.isFinite(off) ? (off as number) : undefined,
    });
  }

  // ─── Static POSTs (must come before any `:id` POST) ────────────────

  @Post('payment-accounts')
  @Roles('admin', 'manager')
  create(@Body() dto: CreatePaymentAccountDto, @Req() req: any) {
    return this.service.create(dto, req.user.sub ?? req.user.id);
  }

  /**
   * PR-FIN-PAYACCT-4D-UX-FIX-9 — operator-triggered backfill. By
   * default `dryRun=true` returns counts/total without writing; the
   * FE flips it to `dryRun=false` only after the operator clicks the
   * confirm button. Limited to admin/manager roles. Service layer
   * enforces method whitelist + single-target invariant + idempotency.
   *
   * PR-FIN-PAYACCT-4D-UX-FIX-9-HOTFIX-1: belt + suspenders ordering —
   * this STATIC route declared above the dynamic `:id` POST routes.
   * (Today the dynamic POST routes have a sub-segment so they don't
   * actually collide with this one-segment path, but keeping the
   * static-first invariant prevents future regressions.)
   */
  @Post('payment-accounts/backfill-unattached')
  @Roles('admin', 'manager')
  backfillUnattached(@Body() dto: BackfillUnattachedDto, @Req() req: any) {
    return this.service.backfillUnattachedInvoicePayments({
      method: dto.method,
      // Default to dryRun=true. Operator must explicitly opt in to
      // an actual UPDATE by sending dryRun=false.
      dryRun: dto.dryRun !== false,
      userId: req.user.sub ?? req.user.id,
    });
  }

  // ─── Dynamic POSTs (must come after static POSTs above) ────────────

  /**
   * PR-FIN-PAYACCT-4A — POST alias of the PATCH /set-default route to
   * match the documented admin API surface. The two routes share the
   * same handler and behavior; the PATCH form is preserved for
   * backward compatibility with PR-PAY-1 callers.
   */
  @Post('payment-accounts/:id/set-default')
  @Roles('admin', 'manager')
  setDefaultPost(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.service.setDefault(id, req.user.sub ?? req.user.id);
  }

  /**
   * PR-FIN-PAYACCT-4A — symmetric flip of `active`. Activating leaves
   * `is_default` alone (operator must call set-default to promote);
   * deactivating force-clears `is_default` so the partial unique index
   * (method) WHERE is_default AND active stays consistent.
   */
  @Post('payment-accounts/:id/toggle-active')
  @Roles('admin', 'manager')
  toggleActive(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.service.toggleActive(id, req.user.sub ?? req.user.id);
  }

  // ─── Dynamic PATCHes ───────────────────────────────────────────────

  @Patch('payment-accounts/:id')
  @Roles('admin', 'manager')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePaymentAccountDto,
    @Req() req: any,
  ) {
    return this.service.update(id, dto, req.user.sub ?? req.user.id);
  }

  @Patch('payment-accounts/:id/deactivate')
  @Roles('admin', 'manager')
  deactivate(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.service.deactivate(id, req.user.sub ?? req.user.id);
  }

  @Patch('payment-accounts/:id/set-default')
  @Roles('admin', 'manager')
  setDefault(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.service.setDefault(id, req.user.sub ?? req.user.id);
  }

  // ─── Dynamic DELETE ────────────────────────────────────────────────

  /**
   * PR-FIN-PAYACCT-4A — safe delete:
   *   • If the account has any non-void invoice / customer / supplier
   *     payment referencing it → soft-delete (active=FALSE, default=FALSE)
   *     so historical JEs and snapshots remain readable.
   *   • Otherwise → hard-delete the row.
   * Returns `{ id, mode: 'soft' | 'hard' }` so the FE can render the
   * right Arabic confirmation message.
   */
  @Delete('payment-accounts/:id')
  @Roles('admin', 'manager')
  deletePaymentAccount(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.service.deleteAccount(id, req.user.sub ?? req.user.id);
  }
}
