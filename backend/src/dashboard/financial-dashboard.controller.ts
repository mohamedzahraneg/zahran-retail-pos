import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { FinancialHealthService } from './financial-health.service';
import { Permissions } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  JwtUser,
} from '../common/decorators/current-user.decorator';

/**
 * Read-only Financial Control Tower endpoints. Everything here is a
 * SELECT-only roll-up over the observability tables created in
 * migration 064. The anomaly scan + resolve routes are the only
 * write paths and they only touch the new `financial_anomalies`
 * table — never journal_entries, journal_lines, cashbox_transactions,
 * or any other financial table.
 */
@ApiBearerAuth()
@ApiTags('dashboard-financial')
@Controller('dashboard/financial')
@Permissions('dashboard.financial.view')
export class FinancialDashboardController {
  constructor(private readonly svc: FinancialHealthService) {}

  @Get('health')
  @ApiOperation({ summary: 'نتيجة الصحة المالية الإجمالية + التصنيف' })
  health() {
    return this.svc.health();
  }

  @Get('live-stream')
  @ApiOperation({ summary: 'آخر N حدث مالي (event stream)' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  liveStream(@Query('limit') limit?: string) {
    return this.svc.liveStream(limit ? parseInt(limit, 10) : 100);
  }

  @Get('anomalies')
  @ApiOperation({ summary: 'الشذوذات النشطة مجمَّعة حسب الخطورة' })
  anomalies() {
    return this.svc.anomalies();
  }

  @Get('migration-status')
  @ApiOperation({ summary: 'حالة الهجرة لـ FinancialEngine لكل reference_type' })
  migrationStatus() {
    return this.svc.migrationStatus();
  }

  /**
   * Run the anomaly detector. Idempotent on
   * (type, affected_entity, reference_id, resolved=FALSE).
   * Safe to call on a cron or on-demand from the dashboard.
   */
  @Post('anomalies/scan')
  @ApiOperation({ summary: 'مسح الشذوذات — يكتشف ويُدرج صفوف جديدة فقط' })
  @ApiQuery({ name: 'hours', required: false, type: Number })
  scan(@Query('hours') hours?: string) {
    return this.svc.scan(hours ? parseInt(hours, 10) : 24);
  }

  @Patch('anomalies/:id/resolve')
  @ApiOperation({ summary: 'تأشير شذوذ كمحلول' })
  resolve(
    @Param('id') id: string,
    @Body() body: { note?: string },
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.resolve(parseInt(id, 10), user.userId, body?.note);
  }

  // ─── Financial lockdown (migration 068, admin only) ──────────────────
  @Get('lockdown')
  @ApiOperation({ summary: 'حالة القفل المالي' })
  lockdownStatus() {
    return this.svc.lockdownStatus();
  }

  @Patch('lockdown')
  @Permissions('system.lockdown.manage')
  @ApiOperation({ summary: 'تفعيل/إيقاف القفل المالي للنظام' })
  toggleLockdown(
    @Body() body: { on: boolean; reason?: string },
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.toggleLockdown(!!body?.on, user.userId, body?.reason);
  }

  // ─── Employee risk flags (migration 068) ──────────────────────────────
  @Get('risk-flags')
  @ApiOperation({ summary: 'قائمة التنبيهات على الموظفين' })
  riskFlags(
    @Query('resolved') resolved?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.riskFlags({
      resolved:
        resolved === 'true' ? true : resolved === 'false' ? false : undefined,
      limit: limit ? parseInt(limit, 10) : 100,
    });
  }

  @Patch('risk-flags/:id/resolve')
  @ApiOperation({ summary: 'حل تنبيه موظف (قرار الإدارة)' })
  resolveRiskFlag(
    @Param('id') id: string,
    @Body() body: { resolution?: string },
    @CurrentUser() user: JwtUser,
  ) {
    return this.svc.resolveRiskFlag(parseInt(id, 10), user.userId, body?.resolution);
  }
}
