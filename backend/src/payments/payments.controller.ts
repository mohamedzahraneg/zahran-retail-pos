import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
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
  CreatePaymentAccountDto,
  UpdatePaymentAccountDto,
} from './dto/payment-account.dto';
import { PaymentsService } from './payments.service';

@ApiTags('payments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class PaymentsController {
  constructor(private readonly service: PaymentsService) {}

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
   * running-balance columns from `v_payment_account_balance` (the
   * view added in mig 121 of PR-4A). Used by the dedicated admin
   * page at `/payment-accounts` for the KPI cards + per-row balance
   * column + bottom summary chart. Read-only — any authenticated
   * user can call (the route at the FE is gated on
   * `payment-accounts.read`).
   */
  @Get('payment-accounts/balances')
  listBalances(
    @Query('method') method?: string,
    @Query('active') active?: string,
  ) {
    return this.service.listBalances({ method, active });
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

  @Get('payment-accounts/:id')
  getById(@Param('id') id: string) {
    return this.service.getById(id);
  }

  @Post('payment-accounts')
  @Roles('admin', 'manager')
  create(@Body() dto: CreatePaymentAccountDto, @Req() req: any) {
    return this.service.create(dto, req.user.sub ?? req.user.id);
  }

  @Patch('payment-accounts/:id')
  @Roles('admin', 'manager')
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePaymentAccountDto,
    @Req() req: any,
  ) {
    return this.service.update(id, dto, req.user.sub ?? req.user.id);
  }

  @Patch('payment-accounts/:id/deactivate')
  @Roles('admin', 'manager')
  deactivate(@Param('id') id: string, @Req() req: any) {
    return this.service.deactivate(id, req.user.sub ?? req.user.id);
  }

  @Patch('payment-accounts/:id/set-default')
  @Roles('admin', 'manager')
  setDefault(@Param('id') id: string, @Req() req: any) {
    return this.service.setDefault(id, req.user.sub ?? req.user.id);
  }

  /**
   * PR-FIN-PAYACCT-4A — POST alias of the PATCH /set-default route to
   * match the documented admin API surface. The two routes share the
   * same handler and behavior; the PATCH form is preserved for
   * backward compatibility with PR-PAY-1 callers.
   */
  @Post('payment-accounts/:id/set-default')
  @Roles('admin', 'manager')
  setDefaultPost(@Param('id') id: string, @Req() req: any) {
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
  toggleActive(@Param('id') id: string, @Req() req: any) {
    return this.service.toggleActive(id, req.user.sub ?? req.user.id);
  }

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
  deletePaymentAccount(@Param('id') id: string, @Req() req: any) {
    return this.service.deleteAccount(id, req.user.sub ?? req.user.id);
  }
}
