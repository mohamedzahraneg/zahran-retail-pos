import {
  Body,
  Controller,
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
}
