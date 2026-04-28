/**
 * statements.controller.ts — PR-FIN-3
 * ────────────────────────────────────────────────────────────────────
 *
 * Five read-only endpoints under /finance/statements/* covering the
 * seven UI tabs (cash / bank / wallet all share the cashbox handler;
 * the frontend filters the entity selector by `cashboxes.kind`).
 *
 * Permission: `finance.statements.view` — distinct from the dashboard
 * permission per PR-FIN-3 §4 of the approved plan. Admin gets it via
 * the wildcard, other roles need explicit grant.
 *
 * Read-only invariants enforced by the service tests:
 *   · NO writes on any financial table
 *   · NO FinancialEngine calls
 *   · Sequential per-request DB queries (concurrency cap = 1)
 */

import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Permissions } from '../common/decorators/roles.decorator';
import { StatementsService } from './statements.service';
import { StatementFilters, StatementResponse } from './statements.types';

@ApiBearerAuth()
@ApiTags('finance')
@Controller('finance/statements')
@Permissions('finance.statements.view')
export class StatementsController {
  constructor(private readonly svc: StatementsService) {}

  @Get('gl-account/:id')
  @ApiOperation({ summary: 'كشف حساب عام (GL) — read-only' })
  @ApiQuery({ name: 'from', required: false, type: String })
  @ApiQuery({ name: 'to', required: false, type: String })
  @ApiQuery({ name: 'include_voided', required: false, type: Boolean })
  glAccount(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('include_voided') include_voided?: string,
  ): Promise<StatementResponse> {
    return this.svc.glAccountStatement(id, {
      from,
      to,
      include_voided: include_voided === 'true',
    });
  }

  @Get('cashbox/:id')
  @ApiOperation({
    summary: 'كشف خزنة / بنك / محفظة — same handler, frontend tab decides',
  })
  @ApiQuery({ name: 'from', required: false, type: String })
  @ApiQuery({ name: 'to', required: false, type: String })
  @ApiQuery({ name: 'direction', required: false, enum: ['in', 'out'] })
  cashbox(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('direction') direction?: string,
  ): Promise<StatementResponse> {
    const dir: StatementFilters['direction'] =
      direction === 'in' || direction === 'out' ? direction : undefined;
    return this.svc.cashboxStatement(id, { from, to, direction: dir });
  }

  @Get('employee/:id')
  @ApiOperation({ summary: 'كشف موظف — read-only' })
  employee(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<StatementResponse> {
    return this.svc.employeeStatement(id, { from, to });
  }

  @Get('customer/:id')
  @ApiOperation({ summary: 'كشف عميل — read-only' })
  customer(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<StatementResponse> {
    return this.svc.customerStatement(id, { from, to });
  }

  @Get('supplier/:id')
  @ApiOperation({ summary: 'كشف مورد — read-only' })
  supplier(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<StatementResponse> {
    return this.svc.supplierStatement(id, { from, to });
  }
}
