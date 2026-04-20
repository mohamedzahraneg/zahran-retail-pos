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
import { IsString, MinLength } from 'class-validator';
import { PosService } from './pos.service';
import { CreateInvoiceDto } from './dto/invoice.dto';
import { Roles } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  JwtUser,
} from '../common/decorators/current-user.decorator';

class VoidInvoiceDto {
  @IsString() @MinLength(3) reason: string;
}

@ApiBearerAuth()
@ApiTags('pos')
@Controller('pos')
export class PosController {
  constructor(private readonly pos: PosService) {}

  @Post('invoices')
  @Roles('admin', 'manager', 'cashier')
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
  @Roles('admin', 'manager')
  voidInvoice(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidInvoiceDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.pos.voidInvoice(id, user.userId, dto.reason);
  }
}
