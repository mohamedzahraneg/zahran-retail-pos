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
import { ReturnsService } from './returns.service';
import {
  ApproveReturnDto,
  CreateExchangeDto,
  CreateReturnDto,
  ListReturnsQueryDto,
  RefundReturnDto,
  RejectReturnDto,
} from './dto/return.dto';
import { Roles, Permissions } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  JwtUser,
} from '../common/decorators/current-user.decorator';

@ApiBearerAuth()
@ApiTags('returns')
@Permissions('returns.view')
@Controller()
export class ReturnsController {
  constructor(private readonly svc: ReturnsService) {}

  // -------- Lookup invoice for return --------------------------------------
  @Get('returns/lookup/:invoice_no')
  @ApiOperation({
    summary: 'البحث عن فاتورة باستخدام رقمها لتحديد الأصناف المتاحة للإرجاع',
  })
  lookupInvoice(@Param('invoice_no') invoiceNo: string) {
    return this.svc.lookupInvoice(invoiceNo);
  }

  // -------- Returns ---------------------------------------------------------
  @Post('returns')
  @Roles('admin', 'manager', 'cashier')
  @ApiOperation({ summary: 'إنشاء مرتجع جديد (pending)' })
  create(@Body() dto: CreateReturnDto, @CurrentUser() user: JwtUser) {
    return this.svc.createReturn(dto, user.userId);
  }

  @Get('returns')
  @ApiOperation({ summary: 'قائمة المرتجعات مع فلاتر' })
  list(@Query() q: ListReturnsQueryDto) {
    return this.svc.list(q);
  }

  @Get('returns/:id')
  @ApiOperation({ summary: 'تفاصيل مرتجع' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.findOne(id);
  }

  @Post('returns/:id/approve')
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'اعتماد المرتجع (يُعيد المخزون)' })
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveReturnDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.approve(id, dto, user.userId);
  }

  @Post('returns/:id/refund')
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'صرف قيمة المرتجع للعميل' })
  refund(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RefundReturnDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.refund(id, dto, user.userId, user.permissions ?? []);
  }

  @Post('returns/:id/reject')
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'رفض المرتجع' })
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectReturnDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.reject(id, dto, user.userId);
  }

  // -------- Exchanges -------------------------------------------------------
  @Post('exchanges')
  @Roles('admin', 'manager', 'cashier')
  @ApiOperation({
    summary:
      'إرجاع منتج واستبداله بآخر في خطوة واحدة (مع حساب فرق السعر)',
  })
  exchange(@Body() dto: CreateExchangeDto, @CurrentUser() user: JwtUser) {
    return this.svc.createExchange(dto, user.userId, user.permissions ?? []);
  }

  @Get('exchanges')
  @ApiOperation({ summary: 'قائمة عمليات الاستبدال' })
  listExchanges(@Query() q: ListReturnsQueryDto) {
    return this.svc.listExchanges(q);
  }

  @Get('exchanges/:id')
  @ApiOperation({ summary: 'تفاصيل عملية استبدال' })
  getExchange(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.getExchange(id);
  }
}
