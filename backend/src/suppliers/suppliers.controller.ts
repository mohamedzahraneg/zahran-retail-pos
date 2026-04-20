import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { SuppliersService } from './suppliers.service';
import { Roles } from '../common/decorators/roles.decorator';
import { Req } from '@nestjs/common';

class CreateSupplierDto {
  @IsString() code: string;
  @IsString() name: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() address?: string;
}

class UpdateSupplierDto {
  @IsOptional() @IsString() code?: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() address?: string;
}

class PaySupplierDto {
  @IsNumber() @Min(0.01) amount: number;
  @IsEnum(['cash', 'card', 'instapay', 'bank_transfer'])
  payment_method: 'cash' | 'card' | 'instapay' | 'bank_transfer';
  @IsOptional() @IsString() reference_number?: string;
  @IsOptional() @IsString() notes?: string;
}

@ApiBearerAuth()
@ApiTags('suppliers')
@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

  @Get()
  list(@Query('q') q?: string) {
    return this.suppliers.list(q);
  }

  @Get('outstanding')
  outstanding() {
    return this.suppliers.outstanding();
  }

  @Get(':id')
  find(@Param('id', ParseUUIDPipe) id: string) {
    return this.suppliers.findOne(id);
  }

  @Get(':id/ledger')
  ledger(@Param('id', ParseUUIDPipe) id: string) {
    return this.suppliers.ledger(id);
  }

  @Post()
  @Roles('admin', 'manager')
  create(@Body() dto: CreateSupplierDto) {
    return this.suppliers.create(dto as any);
  }

  @Patch(':id')
  @Roles('admin', 'manager')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSupplierDto,
  ) {
    return this.suppliers.update(id, dto as any);
  }

  @Delete(':id')
  @Roles('admin', 'manager')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.suppliers.remove(id);
  }

  @Get(':id/payments')
  payments(@Param('id', ParseUUIDPipe) id: string) {
    return this.suppliers.supplierPayments(id);
  }

  @Post(':id/pay')
  @Roles('admin', 'manager', 'accountant')
  pay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PaySupplierDto,
    @Req() req: any,
  ) {
    return this.suppliers.payGeneral(id, dto, req.user?.id);
  }
}
