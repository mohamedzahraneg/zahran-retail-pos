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
import { CreatePurchaseReturnDto } from './dto/purchase-return.dto';
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
  // PR-P2.4A upgraded these in place. Single official namespace:
  //   GET    /purchases/returns                 (filters: q, supplier_id,
  //                                               status, from, to)
  //   GET    /purchases/returns/:id             (enriched detail)
  //   POST   /purchases/returns                 (4 settlement modes)
  //   PATCH  /purchases/returns/:id/cancel      (atomic reversal)
  //   GET    /purchases/:id/returnable-items    (per-item remaining qty)
  @Get('returns')
  @Permissions('purchases.view')
  listReturns(
    @Query('q') q?: string,
    @Query('supplier_id') supplierId?: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.purchases.listReturns({
      q,
      supplier_id: supplierId,
      status,
      from,
      to,
    });
  }

  @Get('returns/:id')
  @Permissions('purchases.view')
  getReturn(@Param('id', ParseUUIDPipe) id: string) {
    return this.purchases.getReturn(id);
  }

  @Post('returns')
  @Permissions('purchases.return')
  @UseInterceptors(IdempotencyInterceptor)
  createReturn(
    @Body() dto: CreatePurchaseReturnDto,
    @Req() req: any,
  ) {
    return this.purchases.createReturn(dto, req.user?.id ?? req.user?.userId);
  }

  @Patch('returns/:id/cancel')
  @Permissions('purchases.return')
  // PR-FIX-IDEMPOTENCY-VOID-CANCEL-REFUND-FAMILY (Sprint 4 / PR-11E) —
  // P0 in this PR. Multi-stage reversal: rebuilds stock + INSERTs
  // reversing stock_movements + UPDATE purchase_returns is_void +
  // engine reverseByReference for JE. Stock writes have no engine
  // guard — duplicate POST during retry could double-reverse.
  // Without an Idempotency-Key header, behavior is exactly unchanged.
  @UseInterceptors(IdempotencyInterceptor)
  cancelReturn(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.purchases.cancelReturn(id, req.user?.id ?? req.user?.userId);
  }

  // GET /purchases/:id/returnable-items — used by the
  // "create purchase return" modal to show per-item remaining qty
  // (received − sum(posted returns)).
  @Get(':id/returnable-items')
  @Permissions('purchases.view')
  returnableItems(@Param('id', ParseUUIDPipe) id: string) {
    return this.purchases.getReturnableItems(id);
  }

  // ── Purchases P1 (PR-PURCHASES-P1) — read-only helpers used by the
  //    Purchase Invoice screen.  Declared BEFORE ':id' so the two
  //    static path segments win route priority over the UUID matcher.
  @Get('suppliers/:supplierId/context')
  supplierContext(
    @Param('supplierId', ParseUUIDPipe) supplierId: string,
  ) {
    return this.purchases.supplierContext(supplierId);
  }

  @Get('products/search')
  productSearch(
    @Query('q') q?: string,
    @Query('warehouse_id') warehouseId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.purchases.productSearch({
      q: q ?? '',
      warehouse_id: warehouseId,
      limit: limit ? Number(limit) : undefined,
    });
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
  // PR-FIX-IDEMPOTENCY-APPROVE-FAMILY (Sprint 4 / PR-11F) — INSERTs
  // a `supplier_payment` row + posts JE + CT (cash/bank). Multi-
  // stage write — duplicate POST creates 2 payment rows + 2 JEs +
  // 2 CTs + double-decrements the cashbox.
  @UseInterceptors(IdempotencyInterceptor)
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
