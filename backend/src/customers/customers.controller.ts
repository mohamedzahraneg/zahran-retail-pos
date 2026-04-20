import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  IsNumber,
  IsIn,
  IsUUID,
} from 'class-validator';
import { CustomersService } from './customers.service';
import { Roles } from '../common/decorators/roles.decorator';

class CreateCustomerDto {
  @IsString() code: string;
  @IsString() full_name: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsIn(['bronze', 'silver', 'gold', 'platinum'])
  loyalty_tier?: string;
  @IsOptional() @IsNumber() credit_limit?: number;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsUUID() group_id?: string;
}

@ApiBearerAuth()
@ApiTags('customers')
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  list(
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.customers.list(
      q,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 50,
    );
  }

  @Get('outstanding')
  outstanding() {
    return this.customers.outstanding();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.customers.findOne(id);
  }

  @Get(':id/ledger')
  ledger(@Param('id', ParseUUIDPipe) id: string) {
    return this.customers.ledger(id);
  }

  @Get(':id/unpaid-invoices')
  unpaidInvoices(@Param('id', ParseUUIDPipe) id: string) {
    return this.customers.unpaidInvoices(id);
  }

  @Post()
  @Roles('admin', 'manager', 'cashier')
  create(@Body() dto: CreateCustomerDto) {
    return this.customers.create(dto as any);
  }

  @Patch(':id')
  @Roles('admin', 'manager')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: Partial<CreateCustomerDto>,
  ) {
    return this.customers.update(id, dto as any);
  }
}
