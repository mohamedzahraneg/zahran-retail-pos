import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, IsInt, IsBoolean } from 'class-validator';
import { CategoriesService } from './categories.service';
import { Roles } from '../common/decorators/roles.decorator';

class CreateCategoryBody {
  @IsString() name_ar: string;
  @IsOptional() @IsString() name_en?: string;
  @IsOptional() @IsUUID() parent_id?: string;
  @IsOptional() @IsString() slug?: string;
  @IsOptional() @IsString() icon?: string;
  @IsOptional() @IsInt() sort_order?: number;
}

class UpdateCategoryBody {
  @IsOptional() @IsString() name_ar?: string;
  @IsOptional() @IsString() name_en?: string;
  @IsOptional() @IsUUID() parent_id?: string;
  @IsOptional() @IsString() slug?: string;
  @IsOptional() @IsString() icon?: string;
  @IsOptional() @IsInt() sort_order?: number;
  @IsOptional() @IsBoolean() is_active?: boolean;
}

@ApiBearerAuth()
@ApiTags('categories')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly service: CategoriesService) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @Roles('admin', 'manager')
  create(@Body() dto: CreateCategoryBody) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @Roles('admin', 'manager')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCategoryBody,
  ) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @Roles('admin', 'manager')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(id);
  }
}
