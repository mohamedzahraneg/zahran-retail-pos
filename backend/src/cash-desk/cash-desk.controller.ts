import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';
import { CashDeskService } from './cash-desk.service';
import {
  CreateCustomerPaymentDto,
  CreateSupplierPaymentDto,
} from './dto/payment.dto';
import { Roles } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  JwtUser,
} from '../common/decorators/current-user.decorator';

class VoidPaymentDto {
  @IsString() @MinLength(3) reason: string;
}

@ApiBearerAuth()
@ApiTags('cash-desk')
@Controller('cash-desk')
export class CashDeskController {
  constructor(private readonly svc: CashDeskService) {}

  @Get('cashboxes')
  cashboxes() {
    return this.svc.listCashboxes();
  }

  @Get('cashflow/today')
  cashflowToday() {
    return this.svc.cashflowToday();
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
}
