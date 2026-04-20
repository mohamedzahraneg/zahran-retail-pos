import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SetupService } from './setup.service';
import { Public } from '../common/decorators/roles.decorator';

class AdminInput {
  @IsString() @MinLength(3) username: string;
  @IsString() @MinLength(8) password: string;
  @IsString() @MinLength(2) full_name: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() phone?: string;
}

class ShopInput {
  @IsString() @MinLength(2) name: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() tax_id?: string;
  @IsOptional() @IsString() vat_number?: string;
  @IsOptional() @IsString() footer_note?: string;
}

class WarehouseInput {
  @IsString() @MinLength(1) code: string;
  @IsString() @MinLength(2) name: string;
}

class LoyaltyInput {
  @IsOptional() @IsNumber() @Min(0) points_per_egp?: number;
  @IsOptional() @IsNumber() @Min(0) egp_per_point?: number;
  @IsOptional() @IsNumber() @Min(0) min_redeem?: number;
  @IsOptional() @IsNumber() @Min(0) max_redeem_ratio?: number;
}

class SetupInitDto {
  @ValidateNested() @Type(() => AdminInput) @IsNotEmpty() admin: AdminInput;
  @ValidateNested() @Type(() => ShopInput) @IsNotEmpty() shop: ShopInput;
  @ValidateNested() @Type(() => WarehouseInput) @IsNotEmpty()
  warehouse: WarehouseInput;
  @IsOptional() @ValidateNested() @Type(() => LoyaltyInput) loyalty?: LoyaltyInput;
  @IsOptional() @IsString() currency?: string;
  @IsOptional() @IsNumber() @Min(0) vat_rate?: number;
}

@ApiTags('setup')
@Controller('setup')
export class SetupController {
  constructor(private readonly svc: SetupService) {}

  @Public()
  @Get('status')
  status() {
    return this.svc.status();
  }

  @Public()
  @Post('init')
  init(@Body() dto: SetupInitDto) {
    return this.svc.init(dto);
  }
}
