import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AttendanceService, ClockCtx } from './attendance.service';
import { CurrentUser, JwtUser } from '../common/decorators/current-user.decorator';
import { Permissions, Roles } from '../common/decorators/roles.decorator';

function ctxFrom(req: Request): ClockCtx {
  const xff = (req.headers['x-forwarded-for'] as string | undefined)?.split(
    ',',
  )[0]?.trim();
  const raw = xff || req.ip || (req.socket as any)?.remoteAddress || '';
  const ip = raw.replace(/^::ffff:/, '');
  return {
    ip: ip || null,
    userAgent: (req.headers['user-agent'] as string | undefined) || null,
  };
}

@ApiBearerAuth()
@ApiTags('attendance')
@Controller('attendance')
export class AttendanceController {
  constructor(private readonly svc: AttendanceService) {}

  @Post('clock-in')
  clockIn(
    @CurrentUser() user: JwtUser,
    @Req() req: Request,
    @Body() body: { note?: string },
  ) {
    return this.svc.clockIn(user.userId, ctxFrom(req), body?.note);
  }

  @Post('clock-out')
  clockOut(
    @CurrentUser() user: JwtUser,
    @Req() req: Request,
    @Body() body: { note?: string },
  ) {
    return this.svc.clockOut(user.userId, ctxFrom(req), body?.note);
  }

  @Get('me/today')
  myToday(@CurrentUser() user: JwtUser) {
    return this.svc.myToday(user.userId);
  }

  @Get()
  @Permissions('attendance.view_team')
  list(
    @Query('user_id') user_id?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.list({
      user_id,
      from,
      to,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('summary')
  @Permissions('attendance.view_team')
  summary(@Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.summary({ from, to });
  }

  @Patch(':id')
  @Permissions('attendance.adjust')
  adjust(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { clock_in?: string; clock_out?: string; note?: string },
  ) {
    return this.svc.adjust(id, body);
  }
}
