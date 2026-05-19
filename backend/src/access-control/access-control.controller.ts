/**
 * access-control.controller.ts — PR-USER-BRANCH-WAREHOUSE-ACCESS
 *
 * Per-user branch/warehouse access management. Endpoints:
 *   GET   /users/:id/access     (admin / manager / `users.manage`)
 *   PATCH /users/:id/access     (admin / manager / `users.manage`)
 *   GET   /me/access            (any authenticated user)
 */
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsOptional,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Permissions, Roles } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  JwtUser,
} from '../common/decorators/current-user.decorator';
import {
  AccessControlService,
  UpdateUserAccessPayload,
} from './access-control.service';
import { ACCESS_LEVELS, AccessScopeService } from './access-scope.service';

class BranchAccessBody {
  @IsUUID() branch_id!: string;
  @IsIn(ACCESS_LEVELS) access_level!: any;
}
class WarehouseAccessBody {
  @IsUUID() warehouse_id!: string;
  @IsIn(ACCESS_LEVELS) access_level!: any;
}
class UpdateUserAccessBody {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BranchAccessBody)
  branch_access?: BranchAccessBody[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WarehouseAccessBody)
  warehouse_access?: WarehouseAccessBody[];

  @IsOptional()
  @IsUUID()
  default_branch_id?: string | null;

  @IsOptional()
  @IsUUID()
  default_warehouse_id?: string | null;
}

@ApiBearerAuth()
@ApiTags('access-control')
@Controller()
export class AccessControlController {
  constructor(
    private readonly svc: AccessControlService,
    private readonly scope: AccessScopeService,
  ) {}

  // ─── current-user access (no admin gate) ─────────────────────────
  @Get('me/access')
  @ApiOperation({
    summary:
      'يرجع صلاحيات الفروع والمخازن للمستخدم الحالي + الافتراضي',
  })
  myAccess(@CurrentUser() user: JwtUser) {
    return this.scope.getUserAccessSummary(user.userId);
  }

  // ─── per-user access (admin) ─────────────────────────────────────
  @Get('users/:id/access')
  @Roles('admin', 'manager')
  @Permissions('users.view')
  @ApiOperation({
    summary: 'يرجع صلاحيات الفروع/المخازن لمستخدم محدد',
  })
  getUserAccess(@Param('id', ParseUUIDPipe) id: string) {
    return this.scope.getUserAccessSummary(id);
  }

  @Patch('users/:id/access')
  @Roles('admin', 'manager')
  @Permissions('users.manage')
  @ApiOperation({
    summary:
      'يحدّث قائمة الفروع/المخازن المسموحة للمستخدم + الافتراضي',
  })
  updateUserAccess(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateUserAccessBody,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.updateUserAccess(
      id,
      body as UpdateUserAccessPayload,
      user.userId,
    );
  }
}
