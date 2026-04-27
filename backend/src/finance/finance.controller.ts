/**
 * finance.controller.ts — PR-FIN-2
 * ────────────────────────────────────────────────────────────────────
 *
 * Single read-only endpoint that powers the Financial Dashboard
 * (`/dashboard/finance` on the frontend). Composes everything the
 * dashboard needs into one response so the page makes one network
 * call instead of 18.
 *
 *   GET /finance/dashboard
 *     ?from=YYYY-MM-DD
 *     &to=YYYY-MM-DD
 *     &cashbox_id=<uuid>
 *     &payment_account_id=<uuid>
 *     &user_id=<uuid>
 *     &shift_id=<uuid>
 *
 * Permission gate: `finance.dashboard.view` (new permission introduced
 * by this PR; admin role gets it via the `*` wildcard, other roles
 * need explicit grant).
 *
 * Read-only invariants:
 *   · NO writes to journal_entries / journal_lines / cashbox_transactions
 *   · NO writes to expenses / invoices / settlements / employee_transactions
 *   · NO FinancialEngine calls
 *   · NO migrations
 *   · DailyExpenses page (frontend) is a frozen surface — this endpoint
 *     reads `expenses` for aggregation only, never edits.
 */

import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Permissions } from '../common/decorators/roles.decorator';
import { FinanceDashboardService } from './finance-dashboard.service';
import { FinanceDashboardResponse } from './finance-dashboard.types';

@ApiBearerAuth()
@ApiTags('finance')
@Controller('finance')
@Permissions('finance.dashboard.view')
export class FinanceController {
  constructor(private readonly svc: FinanceDashboardService) {}

  @Get('dashboard')
  @ApiOperation({
    summary:
      'لوحة الحسابات والمالية — نظرة شاملة لحظية (read-only, single shot)',
  })
  @ApiQuery({ name: 'from', required: false, type: String })
  @ApiQuery({ name: 'to', required: false, type: String })
  @ApiQuery({ name: 'cashbox_id', required: false, type: String })
  @ApiQuery({ name: 'payment_account_id', required: false, type: String })
  @ApiQuery({ name: 'user_id', required: false, type: String })
  @ApiQuery({ name: 'shift_id', required: false, type: String })
  dashboard(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('cashbox_id') cashbox_id?: string,
    @Query('payment_account_id') payment_account_id?: string,
    @Query('user_id') user_id?: string,
    @Query('shift_id') shift_id?: string,
  ): Promise<FinanceDashboardResponse> {
    return this.svc.dashboard({
      from,
      to,
      cashbox_id,
      payment_account_id,
      user_id,
      shift_id,
    });
  }
}
