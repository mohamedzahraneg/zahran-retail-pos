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
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';
import { PosService } from './pos.service';
import { CreateInvoiceDto } from './dto/invoice.dto';
import { Permissions, Roles } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  JwtUser,
} from '../common/decorators/current-user.decorator';
// PR-AUDIT-IDEMPOTENCY-INTERCEPTOR-POS-INVOICE — opt-in idempotency
// support on POST /pos/invoices. Without an Idempotency-Key header,
// behavior is exactly unchanged.
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';

class VoidInvoiceDto {
  @IsString() @MinLength(3) reason: string;
}

class EditInvoiceDto extends CreateInvoiceDto {
  @IsOptional() @IsString() edit_reason?: string;
}

@ApiBearerAuth()
@ApiTags('pos')
@Controller('pos')
export class PosController {
  constructor(private readonly pos: PosService) {}

  @Post('invoices')
  @Roles('admin', 'manager', 'cashier')
  @Permissions('pos.sell')
  // PR-AUDIT-IDEMPOTENCY-INTERCEPTOR-POS-INVOICE — pilot endpoint.
  // Optional Idempotency-Key header. Without it, today's behavior
  // (cashier double-click → 2 invoices). With it, replays the cached
  // 2xx response for 24h or 425/409 for concurrent / payload-mismatch.
  @UseInterceptors(IdempotencyInterceptor)
  create(@Body() dto: CreateInvoiceDto, @CurrentUser() user: JwtUser) {
    return this.pos.createInvoice(dto, user.userId);
  }

  @Get('invoices')
  list(
    @Query('limit') limit?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('cashier_id') cashier_id?: string,
  ) {
    return this.pos.listRecent(
      limit ? parseInt(limit, 10) : 200,
      { from, to, status, q, cashier_id },
    );
  }

  @Get('invoices/:id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.pos.findOne(id);
  }

  @Get('invoices/:id/receipt')
  receipt(@Param('id', ParseUUIDPipe) id: string) {
    return this.pos.getReceipt(id);
  }

  @Post('invoices/:id/void')
  @Permissions('invoices.void')
  voidInvoice(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidInvoiceDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.pos.voidInvoice(id, user.userId, dto.reason);
  }

  @Post('invoices/:id/edit')
  @Permissions('invoices.edit')
  // PR-FIX-IDEMPOTENCY-EXCHANGES-INVOICE-EDITS (Sprint 4 / PR-11C) —
  // multi-stage write: replaces invoice_payments, INSERTs new
  // stock_movements, refreshes the JE/CT via the engine, and (since
  // PR #295) refreshes the closed-shift snapshot when the parent
  // shift is closed. A duplicate POST during a network retry could
  // partially apply some stages before the engine guard catches the
  // JE leg, producing a tangled in-flight state. The Redis-backed
  // interceptor's 60s lock + 24h replay is the cleaner outer
  // defence. Without an Idempotency-Key header, behavior is exactly
  // unchanged from today.
  @UseInterceptors(IdempotencyInterceptor)
  editInvoice(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EditInvoiceDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.pos.editInvoice(
      id,
      dto,
      user.userId,
      dto.edit_reason || 'تعديل فاتورة',
    );
  }

  @Get('invoices/:id/edit-history')
  editHistory(@Param('id', ParseUUIDPipe) id: string) {
    return this.pos.editHistory(id);
  }

  // ── Edit-approval workflow ───────────────────────────────────────────
  @Post('invoices/:id/edit-request')
  @Permissions('invoices.edit_request')
  submitEditRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EditInvoiceDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.pos.submitEditRequest(
      id,
      dto,
      user.userId,
      dto.edit_reason || 'طلب تعديل فاتورة',
    );
  }

  @Get('invoices/:id/edit-requests')
  editRequests(@Param('id', ParseUUIDPipe) id: string) {
    return this.pos.listEditRequests(id);
  }

  @Get('edit-requests/pending')
  @Permissions('invoices.edit_approve')
  pendingEditRequests() {
    return this.pos.listPendingEditRequests();
  }

  @Post('edit-requests/:id/approve')
  @Permissions('invoices.edit_approve')
  approveEditRequest(
    @Param('id') id: string,
    @Body() dto: { note?: string },
    @CurrentUser() user: JwtUser,
  ) {
    return this.pos.approveEditRequest(id, user.userId, dto?.note);
  }

  @Post('edit-requests/:id/reject')
  @Permissions('invoices.edit_approve')
  rejectEditRequest(
    @Param('id') id: string,
    @Body() dto: VoidInvoiceDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.pos.rejectEditRequest(id, user.userId, dto.reason);
  }
}
