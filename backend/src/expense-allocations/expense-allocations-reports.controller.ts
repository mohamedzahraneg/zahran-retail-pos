import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ExpenseAllocationsService } from './expense-allocations.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles, Permissions } from '../common/decorators/roles.decorator';

/**
 * Reports controller — PR-PHASE2-B1 (read-only foundation).
 *
 * Uses the `reports` base path so the two new reports sit alongside the
 * existing `/reports/profit`, `/reports/sales`, etc.  NestJS allows
 * multiple controllers to share a base path as long as the individual
 * routes do not collide; verified that neither `profit-with-overhead`
 * nor `unallocated-expenses` exist anywhere else.
 *
 *   GET /reports/profit-with-overhead     — product profit + allocated overhead
 *   GET /reports/unallocated-expenses     — approved expenses not yet allocated
 *
 * Both are SELECT-only.  Both return [] cleanly when no allocations
 * exist (the case immediately after migration 132 lands).
 */
@ApiBearerAuth()
@ApiTags('reports')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin', 'manager', 'accountant')
@Permissions('expense_allocation.view')
@Controller('reports')
export class ExpenseAllocationsReportsController {
  constructor(private readonly svc: ExpenseAllocationsService) {}

  @Get('profit-with-overhead')
  @ApiOperation({
    summary: 'الربحية للمنتجات مع توزيع المصاريف التشغيلية',
  })
  profitWithOverhead(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('warehouse_id') warehouse_id?: string,
  ) {
    return this.svc.profitWithOverhead({ from, to, warehouse_id });
  }

  @Get('unallocated-expenses')
  @ApiOperation({
    summary: 'المصاريف المعتمدة بدون توزيع',
  })
  unallocatedExpenses(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('warehouse_id') warehouse_id?: string,
  ) {
    return this.svc.unallocatedExpenses({ from, to, warehouse_id });
  }
}
