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
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { SuppliersService } from './suppliers.service';
import { Roles, Permissions } from '../common/decorators/roles.decorator';
import { Req } from '@nestjs/common';
import { CreateSupplierDto, UpdateSupplierDto } from './dto/supplier.dto';
// PR-FIX-IDEMPOTENCY-APPROVE-FAMILY (Sprint 4 / PR-11F) — opt-in
// Idempotency-Key support on POST /suppliers/:id/pay (general supplier
// payment, not invoice-tied). Without the header, behavior is exactly
// unchanged from today.
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';

class PaySupplierDto {
  @IsNumber() @Min(0.01) amount: number;
  @IsEnum(['cash', 'card', 'instapay', 'bank_transfer'])
  payment_method: 'cash' | 'card' | 'instapay' | 'bank_transfer';
  @IsOptional() @IsString() reference_number?: string;
  @IsOptional() @IsString() notes?: string;
}

@ApiBearerAuth()
@ApiTags('suppliers')
@Permissions('suppliers.view')
@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

  @Get()
  list(@Query('q') q?: string) {
    return this.suppliers.list(q);
  }

  @Get('outstanding')
  outstanding() {
    return this.suppliers.outstanding();
  }

  @Get('analytics')
  analytics() {
    return this.suppliers.analytics();
  }

  @Get('upcoming-payments')
  upcomingPayments(@Query('days') days?: string) {
    return this.suppliers.upcomingPayments(days ? Number(days) : 7);
  }

  @Get(':id')
  find(@Param('id', ParseUUIDPipe) id: string) {
    return this.suppliers.findOne(id);
  }

  @Get(':id/ledger')
  ledger(@Param('id', ParseUUIDPipe) id: string) {
    return this.suppliers.ledger(id);
  }

  @Get(':id/summary')
  summary(@Param('id', ParseUUIDPipe) id: string) {
    return this.suppliers.summary(id);
  }

  @Post()
  @Roles('admin', 'manager')
  create(@Body() dto: CreateSupplierDto) {
    return this.suppliers.create(dto as any);
  }

  @Patch(':id')
  @Roles('admin', 'manager')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSupplierDto,
  ) {
    return this.suppliers.update(id, dto as any);
  }

  @Delete(':id')
  @Roles('admin', 'manager')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.suppliers.remove(id);
  }

  @Get(':id/payments')
  payments(@Param('id', ParseUUIDPipe) id: string) {
    return this.suppliers.supplierPayments(id);
  }

  @Post(':id/pay')
  @Roles('admin', 'manager', 'accountant')
  // PR-FIX-IDEMPOTENCY-APPROVE-FAMILY (Sprint 4 / PR-11F) — general
  // supplier payment (not tied to a specific invoice). INSERTs a
  // `supplier_payments` row + posts JE + CT (cash/bank). Multi-stage
  // write — duplicate POST creates 2 payment rows + 2 JEs + 2 CTs.
  // Same risk profile as `POST /purchases/:id/pay` and
  // `POST /cash-desk/supplier-payments` (the latter already
  // protected since PR #283).
  @UseInterceptors(IdempotencyInterceptor)
  pay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PaySupplierDto,
    @Req() req: any,
  ) {
    return this.suppliers.payGeneral(id, dto, req.user?.id);
  }
}
