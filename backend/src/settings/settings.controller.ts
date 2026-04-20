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
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SettingsService } from './settings.service';
import {
  UpdateCompanyProfileDto,
  UpsertCashboxDto,
  UpsertSettingDto,
  UpsertWarehouseDto,
} from './dto/settings.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('settings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('settings')
export class SettingsController {
  constructor(private readonly service: SettingsService) {}

  // ─── Generic key/value settings ─────────────────────────────────────
  @Get()
  list(@Query('group') group?: string) {
    return this.service.list(group);
  }

  @Get('by-key/:key')
  get(@Param('key') key: string) {
    return this.service.get(key);
  }

  @Post()
  @Roles('admin')
  upsert(@Body() dto: UpsertSettingDto, @Req() req: any) {
    return this.service.upsert(dto, req.user.sub ?? req.user.id);
  }

  @Delete('by-key/:key')
  @Roles('admin')
  delete(@Param('key') key: string) {
    return this.service.delete(key);
  }

  // ─── Company profile ────────────────────────────────────────────────
  @Get('company')
  @ApiOperation({ summary: 'Get company profile (singleton)' })
  getCompany() {
    return this.service.getCompany();
  }

  @Patch('company')
  @Roles('admin')
  @ApiOperation({ summary: 'Update company profile' })
  updateCompany(@Body() dto: UpdateCompanyProfileDto) {
    return this.service.updateCompany(dto);
  }

  // ─── Warehouses ─────────────────────────────────────────────────────
  @Get('warehouses')
  listWarehouses(@Query('include_inactive') inc?: string) {
    return this.service.listWarehouses(inc === 'true');
  }

  @Post('warehouses')
  @Roles('admin', 'manager')
  createWarehouse(@Body() dto: UpsertWarehouseDto) {
    return this.service.createWarehouse(dto);
  }

  @Patch('warehouses/:id')
  @Roles('admin', 'manager')
  updateWarehouse(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpsertWarehouseDto,
  ) {
    return this.service.updateWarehouse(id, dto);
  }

  // ─── Cashboxes ──────────────────────────────────────────────────────
  @Get('cashboxes')
  listCashboxes(@Query('warehouse_id') warehouseId?: string) {
    return this.service.listCashboxes(warehouseId);
  }

  @Post('cashboxes')
  @Roles('admin', 'manager')
  createCashbox(@Body() dto: UpsertCashboxDto) {
    return this.service.createCashbox(dto);
  }

  @Patch('cashboxes/:id')
  @Roles('admin', 'manager')
  updateCashbox(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpsertCashboxDto,
  ) {
    return this.service.updateCashbox(id, dto);
  }

  // ─── Roles + Payment methods ────────────────────────────────────────
  @Get('roles')
  listRoles() {
    return this.service.listRoles();
  }

  @Get('permissions')
  listPermissions() {
    return this.service.listPermissions();
  }

  @Post('roles')
  @Roles('admin')
  createRole(@Body() body: any) {
    return this.service.createRole(body);
  }

  @Patch('roles/:id')
  @Roles('admin')
  updateRole(@Param('id') id: string, @Body() body: any) {
    return this.service.updateRole(id, body);
  }

  @Delete('roles/:id')
  @Roles('admin')
  deleteRole(@Param('id') id: string) {
    return this.service.deleteRole(id);
  }

  @Get('payment-methods')
  listPaymentMethods() {
    return this.service.listPaymentMethods();
  }

  @Patch('payment-methods/:code')
  @Roles('admin', 'manager')
  togglePayment(
    @Param('code') code: string,
    @Body('is_active') is_active: boolean,
  ) {
    return this.service.togglePaymentMethod(code, is_active);
  }
}
