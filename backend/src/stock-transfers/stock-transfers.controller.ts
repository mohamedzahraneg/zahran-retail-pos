/**
 * stock-transfers.controller.ts — PR-STOCK-TRANSFERS-WORKFLOW
 *   + PR-USER-BRANCH-WAREHOUSE-ACCESS
 *
 * Branch-aware list filters + the new `approve` + PATCH endpoints,
 * with per-user warehouse-access enforcement layered on top:
 *
 *   · `list`  intersects the result with the user's allowed warehouse
 *     set (either side — from / to — counts as a match).
 *   · `findOne` returns 403 when the user has access rows but neither
 *     side of the transfer is on the list.
 *   · `create` returns 403 when either warehouse is outside the user's
 *     allow-list (only when the user has explicit rows; fallback-allow-
 *     all users are unaffected).
 *
 * Fallback-allow-all: a user with zero rows in `user_warehouse_access`
 * is treated as "no restriction" so the rollout doesn't break
 * existing operators.
 */
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { StockTransfersService } from './stock-transfers.service';
import {
  CreateTransferDto,
  ReceiveTransferDto,
  UpdateTransferDto,
} from './dto/stock-transfer.dto';
import { Roles, Permissions } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  JwtUser,
} from '../common/decorators/current-user.decorator';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import { AccessScopeService } from '../access-control/access-scope.service';

@ApiBearerAuth()
@ApiTags('stock-transfers')
@Permissions('inventory.view')
@Controller('stock-transfers')
export class StockTransfersController {
  constructor(
    private readonly svc: StockTransfersService,
    private readonly scope: AccessScopeService,
  ) {}

  private async assertCanAccessWarehouses(
    user: JwtUser,
    warehouseIds: string[],
  ) {
    const allowed = await this.scope.getUserWarehouseIds(user.userId, {
      role: user.role,
      minLevel: 'operate',
    });
    if (allowed === null) return; // fallback-allow-all
    for (const id of warehouseIds) {
      if (!allowed.includes(id)) {
        throw new ForbiddenException(
          'ليس لديك صلاحية الوصول لهذا المخزن',
        );
      }
    }
  }

  // ─── Lifecycle writes ────────────────────────────────────────────
  @Post()
  @Roles('admin', 'manager', 'stock_keeper')
  @ApiOperation({ summary: 'إنشاء تحويل مخزني (مسودة) — لا يحرك مخزون' })
  @UseInterceptors(IdempotencyInterceptor)
  async create(
    @Body() dto: CreateTransferDto,
    @CurrentUser() user: JwtUser,
  ) {
    await this.assertCanAccessWarehouses(user, [
      dto.from_warehouse_id,
      dto.to_warehouse_id,
    ]);
    return this.svc.create(dto, user.userId);
  }

  @Patch(':id')
  @Roles('admin', 'manager', 'stock_keeper')
  @ApiOperation({
    summary:
      'تعديل تحويل (مسموح فقط للحالات draft|pending) — لا يحرك مخزون',
  })
  @UseInterceptors(IdempotencyInterceptor)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTransferDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.update(id, dto, user.userId);
  }

  @Post(':id/approve')
  @Roles('admin', 'manager', 'stock_keeper')
  @ApiOperation({
    summary: 'اعتماد التحويل (draft|pending → approved) — لا يحرك مخزون',
  })
  @UseInterceptors(IdempotencyInterceptor)
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.approve(id, user.userId);
  }

  @Post(':id/ship')
  @Roles('admin', 'manager', 'stock_keeper')
  @ApiOperation({
    summary:
      'شحن التحويل (draft|pending|approved → in_transit) + خصم من المصدر',
  })
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
    summary:
      'استلام التحويل (in_transit|partially_received → received|partially_received) — يضيف delta فقط',
  })
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
  @ApiOperation({
    summary:
      'إلغاء تحويل قبل الشحن فقط (draft|pending|approved) — لا يحرك مخزون',
  })
  @UseInterceptors(IdempotencyInterceptor)
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.cancel(id, user.userId);
  }

  // ─── Reads ───────────────────────────────────────────────────────
  @Get()
  @ApiOperation({ summary: 'قائمة التحويلات' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'warehouse_id', required: false })
  @ApiQuery({ name: 'from_warehouse_id', required: false })
  @ApiQuery({ name: 'to_warehouse_id', required: false })
  @ApiQuery({ name: 'from_branch_id', required: false })
  @ApiQuery({ name: 'to_branch_id', required: false })
  @ApiQuery({ name: 'date_from', required: false })
  @ApiQuery({ name: 'date_to', required: false })
  @ApiQuery({ name: 'search', required: false })
  async list(
    @CurrentUser() user: JwtUser,
    @Query('status') status?: string,
    @Query('warehouse_id', new ParseUUIDPipe({ optional: true }))
    warehouseId?: string,
    @Query('from_warehouse_id', new ParseUUIDPipe({ optional: true }))
    from_warehouse_id?: string,
    @Query('to_warehouse_id', new ParseUUIDPipe({ optional: true }))
    to_warehouse_id?: string,
    @Query('from_branch_id', new ParseUUIDPipe({ optional: true }))
    from_branch_id?: string,
    @Query('to_branch_id', new ParseUUIDPipe({ optional: true }))
    to_branch_id?: string,
    @Query('date_from') date_from?: string,
    @Query('date_to') date_to?: string,
    @Query('search') search?: string,
  ) {
    const allowed = await this.scope.getUserWarehouseIds(user.userId, {
      role: user.role,
    });
    return this.svc.list({
      status,
      warehouse_id: warehouseId,
      from_warehouse_id,
      to_warehouse_id,
      from_branch_id,
      to_branch_id,
      date_from,
      date_to,
      search,
      allowed_warehouse_ids: allowed ?? undefined,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'تفاصيل تحويل (مع الفروع وحركات المخزون)' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtUser,
  ) {
    const transfer = await this.svc.findOne(id);
    const allowed = await this.scope.getUserWarehouseIds(user.userId, {
      role: user.role,
    });
    if (allowed !== null) {
      const ok =
        allowed.includes(transfer.from_warehouse_id) ||
        allowed.includes(transfer.to_warehouse_id);
      if (!ok) {
        throw new ForbiddenException(
          'ليس لديك صلاحية مشاهدة هذا التحويل',
        );
      }
    }
    return transfer;
  }
}
