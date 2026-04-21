import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
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

@ApiBearerAuth()
@ApiTags('stock-transfers')
@Permissions('inventory.view')
@Controller('stock-transfers')
export class StockTransfersController {
  constructor(private readonly svc: StockTransfersService) {}

  @Post()
  @Roles('admin', 'manager', 'stock_keeper')
  @ApiOperation({ summary: 'إنشاء تحويل مخزني (مسودة)' })
  create(@Body() dto: CreateTransferDto, @CurrentUser() user: JwtUser) {
    return this.svc.create(dto, user.userId);
  }

  @Post(':id/ship')
  @Roles('admin', 'manager', 'stock_keeper')
  @ApiOperation({ summary: 'شحن التحويل (draft → in_transit) + خصم من المصدر' })
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
