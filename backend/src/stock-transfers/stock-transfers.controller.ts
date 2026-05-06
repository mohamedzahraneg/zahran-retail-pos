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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { StockTransfersService } from './stock-transfers.service';
import {
  CreateTransferDto,
  ReceiveTransferDto,
} from './dto/stock-transfer.dto';
import { Roles, Permissions } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  JwtUser,
} from '../common/decorators/current-user.decorator';
// PR-FIX-IDEMPOTENCY-STOCK-INVENTORY-PATHS (Sprint 4 / PR-11B) —
// opt-in Idempotency-Key support on the 3 stock-transfer lifecycle
// routes (create / ship / receive). Without the header, behavior is
// exactly unchanged from today.
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';

@ApiBearerAuth()
@ApiTags('stock-transfers')
@Permissions('inventory.view')
@Controller('stock-transfers')
export class StockTransfersController {
  constructor(private readonly svc: StockTransfersService) {}

  @Post()
  @Roles('admin', 'manager', 'stock_keeper')
  @ApiOperation({ summary: 'إنشاء تحويل مخزني (مسودة)' })
  // PR-FIX-IDEMPOTENCY-STOCK-INVENTORY-PATHS (Sprint 4 / PR-11B) —
  // `create` writes a draft `stock_transfers` row + per-item
  // `stock_transfer_items` rows. The items have `ON CONFLICT DO
  // UPDATE` against (transfer_id, variant_id), but a duplicate
  // POST creates a brand-new transfer row with a fresh UUID, so
  // duplicate draft transfers are possible without this guard.
  // No stock_movements at this stage — those are written by ship
  // and receive below. Without an Idempotency-Key header, behavior
  // is exactly unchanged.
  @UseInterceptors(IdempotencyInterceptor)
  create(@Body() dto: CreateTransferDto, @CurrentUser() user: JwtUser) {
    return this.svc.create(dto, user.userId);
  }

  @Post(':id/ship')
  @Roles('admin', 'manager', 'stock_keeper')
  @ApiOperation({ summary: 'شحن التحويل (draft → in_transit) + خصم من المصدر' })
  // PR-FIX-IDEMPOTENCY-STOCK-INVENTORY-PATHS (Sprint 4 / PR-11B) —
  // `ship` is the FIRST stock_movements writer in the transfer
  // lifecycle: deducts inventory from the source warehouse via
  // `fn_adjust_stock`. State guard `status='draft'` exists, but a
  // duplicate POST during a network retry could race the state
  // check and double-deduct on edge timing. Without an
  // Idempotency-Key header, behavior is exactly unchanged.
  @UseInterceptors(IdempotencyInterceptor)
  ship(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.ship(id, user.userId);
  }

  @Post(':id/receive')
  @Roles('admin', 'manager', 'stock_keeper')
  @ApiOperation({
    summary: 'استلام التحويل (in_transit → received) + إضافة للوجهة',
  })
  // PR-FIX-IDEMPOTENCY-STOCK-INVENTORY-PATHS (Sprint 4 / PR-11B) —
  // `receive` is the SECOND stock_movements writer: adds inventory
  // to the destination warehouse (closing the in_transit -> received
  // transition). Same race-with-state-guard concern as `ship`.
  // Without an Idempotency-Key header, behavior is exactly unchanged.
  @UseInterceptors(IdempotencyInterceptor)
  receive(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReceiveTransferDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.receive(id, dto, user.userId);
  }

  @Post(':id/cancel')
  @Roles('admin', 'manager', 'stock_keeper')
  @ApiOperation({ summary: 'إلغاء التحويل (rollback إن كان in_transit)' })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.cancel(id, user.userId);
  }

  @Get()
  @ApiOperation({ summary: 'قائمة التحويلات' })
  list(
    @Query('status') status?: string,
    @Query('warehouse_id') warehouseId?: string,
  ) {
    return this.svc.list({ status, warehouse_id: warehouseId });
  }

  @Get(':id')
  @ApiOperation({ summary: 'تفاصيل تحويل' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.findOne(id);
  }
}
