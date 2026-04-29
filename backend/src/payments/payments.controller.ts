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
