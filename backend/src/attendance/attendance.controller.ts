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

  // ── Admin-on-behalf + wage accrual (employee.attendance.manage) ──────

  @Post('admin/clock-in')
  @Permissions('employee.attendance.manage')
  adminClockIn(
    @CurrentUser() user: JwtUser,
    @Body() body: { user_id: string; note?: string },
  ) {
    return this.svc.adminClockIn(body.user_id, user.userId, body?.note);
  }

  @Post('admin/clock-out')
  @Permissions('employee.attendance.manage')
  adminClockOut(
    @CurrentUser() user: JwtUser,
    @Body() body: { user_id: string; note?: string },
  ) {
    return this.svc.adminClockOut(body.user_id, user.userId, body?.note);
  }

  @Post('admin/mark-payable-day')
  @Permissions('employee.attendance.manage')
  adminMarkPayableDay(
    @CurrentUser() user: JwtUser,
    @Body() body: { user_id: string; work_date: string; reason: string },
  ) {
    return this.svc.adminMarkPayableDay(
      body.user_id,
      body.work_date,
      body.reason,
      user.userId,
    );
  }

  @Post('admin/approve-wage/:attendance_id')
  @Permissions('employee.attendance.manage')
  adminApproveWage(
    @Param('attendance_id', ParseUUIDPipe) attendanceId: string,
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.adminApproveWageFromAttendance(attendanceId, user.userId);
  }

  @Post('admin/void-accrual/:payable_day_id')
  @Permissions('employee.attendance.manage')
  adminVoidAccrual(
    @Param('payable_day_id', ParseUUIDPipe) payableDayId: string,
    @CurrentUser() user: JwtUser,
    @Body() body: { reason: string },
  ) {
    return this.svc.adminVoidWageAccrual(payableDayId, body.reason, user.userId);
  }

  /**
   * PR-3: Approve a wage override for (user_id, work_date). Voids any
   * existing live accrual and posts a new one with the chosen
   * override_type + approved_amount + approval_reason. No cashbox
   * movement.
   */
  @Post('admin/approve-wage-override')
  @Permissions('employee.attendance.manage')
  adminApproveWageOverride(
    @CurrentUser() user: JwtUser,
    @Body()
    body: {
      user_id: string;
      work_date: string;
      override_type: 'calculated' | 'full_day' | 'custom_amount';
      approved_amount?: number;
      approval_reason?: string;
      reason?: string;
    },
  ) {
    return this.svc.adminApproveWageOverride(
      body.user_id,
      body.work_date,
      body,
      user.userId,
    );
  }

  @Post('admin/pay-wage')
  @Permissions('employee.ledger.view')
  payWage(
    @CurrentUser() user: JwtUser,
    @Body()
    body: {
      user_id: string;
      amount: number;
      cashbox_id: string;
      excess_handling?: 'advance' | 'bonus';
      notes?: string;
      /** PR-15 — explicit shift linkage from the source selector. */
      shift_id?: string;
    },
  ) {
    return this.svc.payWage(body.user_id, body, user.userId, user.permissions);
  }

  @Get('payable-days')
  @Permissions('employee.attendance.manage')
  payableDays(
    @Query('user_id', ParseUUIDPipe) userId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.svc.listPayableDays({ user_id: userId, from, to });
  }
}
