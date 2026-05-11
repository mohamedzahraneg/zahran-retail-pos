import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ExpenseAllocationsService } from './expense-allocations.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles, Permissions } from '../common/decorators/roles.decorator';

/**
 * Periods controller — PR-PHASE2-B1 (read-only foundation).
 *
 *   GET /expense-allocations/periods         — list with filters
 *   GET /expense-allocations/periods/:id     — single period + its lines
 *
 * Permission: `expense_allocation.view`.  Wider write permissions
 * (`expense_allocation.manage`) are introduced in PR-PHASE2-B2 along
 * with the mutation endpoints (create / approve / reverse / compute).
 *
 * No FinancialEngine call.  No JE/CT/SM writes.  Pure SELECT-only.
 */
@ApiBearerAuth()
@ApiTags('expense-allocations')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin', 'manager', 'accountant')
@Permissions('expense_allocation.view')
@Controller('expense-allocations')
export class ExpenseAllocationsController {
  constructor(private readonly svc: ExpenseAllocationsService) {}

  @Get('periods')
  @ApiOperation({ summary: 'قائمة فترات توزيع المصاريف' })
  listPeriods(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('status') status?: string,
    @Query('warehouse_id') warehouse_id?: string,
  ) {
    return this.svc.listPeriods({ from, to, status, warehouse_id });
  }

  @Get('periods/:id')
  @ApiOperation({ summary: 'فترة توزيع واحدة مع سطورها' })
  getPeriod(@Param('id') id: string) {
    return this.svc.getPeriod(id);
  }
}
