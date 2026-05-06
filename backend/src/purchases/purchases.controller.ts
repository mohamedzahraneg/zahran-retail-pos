import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PurchasesService } from './purchases.service';
import {
  AddPurchasePaymentDto,
  CreatePurchaseDto,
  ListPurchasesDto,
} from './dto/purchase.dto';
import { Permissions, Roles } from '../common/decorators/roles.decorator';
// PR-FIX-IDEMPOTENCY-STOCK-INVENTORY-PATHS (Sprint 4 / PR-11B) —
// opt-in Idempotency-Key support on POST /purchases/:id/receive.
// Without the header, behavior is exactly unchanged from today.
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';

@ApiBearerAuth()
@ApiTags('purchases')
@Controller('purchases')
export class PurchasesController {
  constructor(private readonly purchases: PurchasesService) {}

  @Get()
  list(@Query() query: ListPurchasesDto) {
    return this.purchases.list(query);
  }

  // ---- Returns (declared BEFORE ':id' to win route priority) ----
  @Get('returns')
  listReturns(@Query('supplier_id') supplierId?: string) {
    return this.purchases.listReturns(supplierId);
  }

  @Get('returns/:id')
  getReturn(@Param('id', ParseUUIDPipe) id: string) {
    return this.purchases.getReturn(id);
  }

  @Post('returns')
  @Roles('admin', 'manager', 'stock_keeper', 'accountant')
  createReturn(@Body() dto: any, @Req() req: any) {
    return this.purchases.createReturn(dto, req.user?.id);
  }

  @Patch('returns/:id/cancel')
  @Roles('admin', 'manager')
  // PR-FIX-IDEMPOTENCY-VOID-CANCEL-REFUND-FAMILY (Sprint 4 / PR-11E) —
  // P0 in this PR. Multi-stage reversal: rebuilds stock + INSERTs
  // reversing stock_movements + UPDATE purchase_returns is_void +
  // engine reverseByReference for JE. Stock writes have no engine
  // guard — duplicate POST during retry could double-reverse.
  // Without an Idempotency-Key header, behavior is exactly unchanged.
  @UseInterceptors(IdempotencyInterceptor)
  cancelReturn(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.purchases.cancelReturn(id, req.user?.id);
  }

  @Get(':id')
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.purchases.getOne(id);
  }

  @Post()
  @Roles('admin', 'manager', 'accountant', 'stock_keeper')
  create(@Body() dto: CreatePurchaseDto, @Req() req: any) {
    return this.purchases.create(dto, req.user?.id);
  }

  @Post(':id/receive')
  @Roles('admin', 'manager', 'stock_keeper')
  // PR-FIX-IDEMPOTENCY-STOCK-INVENTORY-PATHS (Sprint 4 / PR-11B) —
  // `receive` writes stock_movements (one per item) + a JE for the
  // inventory side. Engine-level (reference_type='purchase',
  // reference_id) guard exists, but a duplicate POST during a
  // network retry could race the engine guard and create double
  // stock movements. Without an Idempotency-Key header, behavior
  // is exactly unchanged.
  @UseInterceptors(IdempotencyInterceptor)
  receive(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.purchases.receive(id, req.user?.id);
  }

  @Post(':id/pay')
  @Roles('admin', 'manager', 'accountant')
  pay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddPurchasePaymentDto,
    @Req() req: any,
  ) {
    return this.purchases.pay(id, dto, req.user?.id);
  }

  @Patch(':id/cancel')
  @Permissions('purchases.cancel')
  // PR-FIX-IDEMPOTENCY-VOID-CANCEL-REFUND-FAMILY (Sprint 4 / PR-11E) —
  // UPDATE purchases status='cancelled' + reverseByReference(
  // 'purchase_payment', id) for cash payments. Engine guard catches
  // dup JE; HTTP interceptor adds outer race defence.
  @UseInterceptors(IdempotencyInterceptor)
  cancel(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.purchases.cancel(id, req.user?.userId);
  }

  @Post(':id/edit')
  @Permissions('purchases.edit')
  edit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreatePurchaseDto & { edit_reason?: string },
    @Req() req: any,
  ) {
    return this.purchases.edit(
      id,
      dto,
      req.user?.userId,
      dto?.edit_reason || 'تعديل فاتورة مشتريات',
    );
  }
}
