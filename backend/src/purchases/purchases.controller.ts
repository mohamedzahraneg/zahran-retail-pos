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
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PurchasesService } from './purchases.service';
import {
  AddPurchasePaymentDto,
  CreatePurchaseDto,
  ListPurchasesDto,
} from './dto/purchase.dto';
import { Permissions, Roles } from '../common/decorators/roles.decorator';

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
