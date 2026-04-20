import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsEmail, IsOptional, IsString, MinLength } from 'class-validator';
import { UsersService } from './users.service';
import { Permissions, Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, JwtUser } from '../common/decorators/current-user.decorator';

class CreateUserDto {
  @IsString() @MinLength(3) username: string;
  @IsString() @MinLength(6) password: string;
  @IsOptional() @IsString() full_name?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() role_id?: string;
  @IsOptional() @IsString() branch_id?: string;
}

class UpdateUserDto {
  @IsOptional() @IsString() full_name?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() role_id?: string;
  @IsOptional() @IsString() branch_id?: string;
}

class ChangePasswordDto {
  @IsString() @MinLength(6) new_password: string;
}

class PermissionOverridesDto {
  @IsArray() extra_permissions: string[];
  @IsArray() denied_permissions: string[];
}

@ApiBearerAuth()
@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @Permissions('users.view')
  list() {
    return this.users.findAll();
  }

  @Get('me')
  me(@CurrentUser() user: JwtUser) {
    return this.users.findById(user.userId);
  }

  @Get(':id')
  @Permissions('users.view')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.findById(id);
  }

  @Post()
  @Permissions('users.manage')
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto);
  }

  @Patch(':id/password')
  @Permissions('users.manage')
  changePassword(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.users.changePassword(id, dto.new_password).then(() => ({
      message: 'Password updated successfully',
    }));
  }

  @Patch(':id/deactivate')
  @Permissions('users.manage')
  deactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.deactivate(id).then(() => ({ deactivated: true }));
  }

  @Patch(':id/activate')
  @Permissions('users.manage')
  activate(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.activate(id).then(() => ({ activated: true }));
  }

  @Patch(':id')
  @Permissions('users.manage')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.users.update(id, dto);
  }

  @Get('meta/roles')
  @Permissions('users.view')
  listRoles() {
    return this.users.listRoles();
  }

  @Patch(':id/permissions')
  @Permissions('users.manage')
  setPermissions(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PermissionOverridesDto,
  ) {
    return this.users.setPermissionOverrides(
      id,
      dto.extra_permissions || [],
      dto.denied_permissions || [],
    );
  }
}
