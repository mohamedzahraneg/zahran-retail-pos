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
import { IsOptional, IsString, MinLength } from 'class-validator';
import { PosService } from './pos.service';
import { CreateInvoiceDto } from './dto/invoice.dto';
import { Permissions, Roles } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  JwtUser,
} from '../common/decorators/current-user.decorator';

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
}
