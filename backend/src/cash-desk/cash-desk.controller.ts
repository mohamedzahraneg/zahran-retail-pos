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

class CashboxUpdateDto extends CashboxCreateDto {
  declare name_ar: string;
  declare kind: 'cash' | 'bank' | 'ewallet' | 'check';
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
  createCashbox(@Body() dto: CashboxCreateDto) {
    return this.svc.createCashbox(dto);
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

  @Get('cashflow/today')
  cashflowToday() {
    return this.svc.cashflowToday();
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

  // ── Manual cashbox deposits / withdrawals (opening balance, top-ups) ──
  @Post('deposit')
  @Roles('admin', 'manager', 'accountant')
  deposit(@Body() dto: CashDepositDto, @CurrentUser() user: JwtUser) {
    return this.svc.deposit(dto, user.userId);
  }
}
