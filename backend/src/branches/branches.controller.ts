/**
 * branches.controller.ts — PR-BRANCHES-WAREHOUSES-FOUNDATION
 *
 * Branch CRUD + warehouse linking. Strictly admin / manager — no
 * cashier / inventory write paths. Endpoints:
 *
 *   GET    /branches
 *   GET    /branches/:id
 *   POST   /branches
 *   PATCH  /branches/:id
 *   GET    /branches/:id/warehouses
 *   POST   /branches/:id/warehouses/:warehouseId
 *   DELETE /branches/:id/warehouses/:warehouseId
 *   PATCH  /branches/:id/warehouses/:warehouseId/primary
 *   GET    /warehouses/with-branches  (read-only roll-up)
 *
 * The "warehouses/with-branches" surface lives here (not in the
 * settings controller) so we don't have to touch any existing
 * warehouse endpoint — the legacy GET /settings/warehouses is left
 * exactly as it was.
 */
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
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import {
  BRANCH_TYPES,
  BranchType,
  BranchesService,
} from './branches.service';
import { Roles, Permissions } from '../common/decorators/roles.decorator';

class CreateBranchBody {
  @IsString() code: string;
  @IsString() name_ar: string;
  @IsOptional() @IsString() name_en?: string;
  @IsOptional() @IsIn(BRANCH_TYPES) type?: BranchType;
  @IsOptional() @IsUUID() parent_branch_id?: string;
  @IsOptional() @IsUUID() manager_id?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsBoolean() is_active?: boolean;
}

class UpdateBranchBody {
  @IsOptional() @IsString() code?: string;
  @IsOptional() @IsString() name_ar?: string;
  @IsOptional() @IsString() name_en?: string;
  @IsOptional() @IsIn(BRANCH_TYPES) type?: BranchType;
  @IsOptional() @IsUUID() parent_branch_id?: string;
  @IsOptional() @IsUUID() manager_id?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsBoolean() is_active?: boolean;
}

class LinkWarehouseBody {
  @IsOptional() @IsBoolean() is_primary?: boolean;
}

@ApiBearerAuth()
@ApiTags('branches')
@Permissions('warehouses.view')
@Controller()
export class BranchesController {
  constructor(private readonly service: BranchesService) {}

  // ─── /branches ────────────────────────────────────────────────────
  @Get('branches')
  list(@Query('include_inactive') includeInactive?: string) {
    return this.service.list(includeInactive === 'true');
  }

  @Get('branches/:id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  @Post('branches')
  @Roles('admin', 'manager')
  @Permissions('warehouses.manage')
  create(@Body() dto: CreateBranchBody) {
    return this.service.create(dto);
  }

  @Patch('branches/:id')
  @Roles('admin', 'manager')
  @Permissions('warehouses.manage')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBranchBody,
  ) {
    return this.service.update(id, dto);
  }

  // ─── /branches/:id/warehouses links ───────────────────────────────
  @Get('branches/:id/warehouses')
  listWarehouses(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.listWarehouses(id);
  }

  @Post('branches/:id/warehouses/:warehouseId')
  @Roles('admin', 'manager')
  @Permissions('warehouses.manage')
  linkWarehouse(
    @Param('id', ParseUUIDPipe) branchId: string,
    @Param('warehouseId', ParseUUIDPipe) warehouseId: string,
    @Body() body: LinkWarehouseBody = {},
  ) {
    return this.service.linkWarehouse(branchId, warehouseId, {
      is_primary: body?.is_primary,
    });
  }

  @Delete('branches/:id/warehouses/:warehouseId')
  @Roles('admin', 'manager')
  @Permissions('warehouses.manage')
  unlinkWarehouse(
    @Param('id', ParseUUIDPipe) branchId: string,
    @Param('warehouseId', ParseUUIDPipe) warehouseId: string,
  ) {
    return this.service.unlinkWarehouse(branchId, warehouseId);
  }

  @Patch('branches/:id/warehouses/:warehouseId/primary')
  @Roles('admin', 'manager')
  @Permissions('warehouses.manage')
  setPrimary(
    @Param('id', ParseUUIDPipe) branchId: string,
    @Param('warehouseId', ParseUUIDPipe) warehouseId: string,
  ) {
    return this.service.setPrimary(branchId, warehouseId);
  }

  // ─── /warehouses/with-branches (read-only) ────────────────────────
  // Lives here so the legacy /settings/warehouses route is untouched.
  // Anyone who can view warehouses (`warehouses.view`) can read this.
  @Get('warehouses/with-branches')
  listWarehousesWithBranches() {
    return this.service.listWarehousesWithBranches();
  }
}
