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
import {
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { NotificationsService } from './notifications.service';
import { Roles, Permissions } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  JwtUser,
} from '../common/decorators/current-user.decorator';

class UpsertTemplateDto {
  @IsString() @MinLength(2) code: string;
  @IsString() @MinLength(2) name_ar: string;
  @IsEnum(['whatsapp', 'sms', 'email'] as any) channel: any;
  @IsOptional() @IsString() subject?: string;
  @IsString() @MinLength(3) body: string;
  @IsOptional() is_active?: boolean;
}

class EnqueueFromTemplateDto {
  @IsString() @IsNotEmpty() code: string;
  @IsOptional() @IsString() recipient?: string;
  @IsOptional() @IsObject() variables?: Record<string, any>;
  @IsOptional() @IsString() reference_type?: string;
  @IsOptional() @IsString() reference_id?: string;
  @IsOptional() @IsObject() metadata?: Record<string, any>;
}

class SendAdHocDto {
  @IsEnum(['whatsapp', 'sms', 'email'] as any) channel: any;
  @IsString() @IsNotEmpty() recipient: string;
  @IsString() @MinLength(1) body: string;
  @IsOptional() @IsString() subject?: string;
}

@ApiBearerAuth()
@ApiTags('notifications')
@Permissions('alerts.view')
@Controller('notifications')
// All authenticated users see their notifications.
@Roles('admin', 'manager', 'accountant', 'cashier', 'inventory', 'salesperson')
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  @Get()
  list(
    @Query('status') status?: any,
    @Query('channel') channel?: any,
    @Query('reference_type') reference_type?: string,
    @Query('reference_id') reference_id?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.list({
      status,
      channel,
      reference_type,
      reference_id,
      limit: limit ? parseInt(limit, 10) : 100,
    });
  }

  @Get('stats')
  stats() {
    return this.svc.stats();
  }

  @Get('templates')
  templates() {
    return this.svc.listTemplates();
  }

  @Post('templates')
  upsertTemplate(@Body() body: UpsertTemplateDto) {
    return this.svc.upsertTemplate(body);
  }

  @Post('send-template')
  sendFromTemplate(
    @Body() body: EnqueueFromTemplateDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.enqueueFromTemplate({ ...body, created_by: user.userId });
  }

  @Post('send')
  async sendAdHoc(@Body() body: SendAdHocDto, @CurrentUser() user: JwtUser) {
    const n = await this.svc.enqueue({
      channel: body.channel,
      recipient: body.recipient,
      subject: body.subject,
      body: body.body,
      created_by: user.userId,
    });
    return this.svc.sendNow(n.id);
  }

  @Post(':id/send')
  sendNow(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.sendNow(id);
  }

  @Post(':id/retry')
  retry(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.retry(id);
  }

  @Post(':id/cancel')
  cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.cancel(id);
  }

  @Post('process-queue')
  processQueue(@Query('limit') limit?: string) {
    return this.svc.processQueue(limit ? parseInt(limit, 10) : 25);
  }
}
