import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AccountingService } from './accounting.service';
import {
  CreateExpenseCategoryDto,
  CreateExpenseDto,
  ListExpensesDto,
  ReportRangeDto,
  UpdateExpenseCategoryDto,
  UpdateExpenseDto,
} from './dto/accounting.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles, Permissions } from '../common/decorators/roles.decorator';

@ApiTags('accounting')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Permissions('accounting.view')
@Controller('accounting')
export class AccountingController {
  constructor(private readonly service: AccountingService) {}

  // ─── Categories ──────────────────────────────────────────────────────
  @Get('categories')
  @ApiOperation({ summary: 'List expense categories' })
  listCategories(@Query('include_inactive') includeInactive?: string) {
    return this.service.listCategories(includeInactive === 'true');
  }

  @Post('categories')
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'Create an expense category' })
  createCategory(@Body() dto: CreateExpenseCategoryDto) {
    return this.service.createCategory(dto);
  }

  @Patch('categories/:id')
  @Roles('admin', 'manager')
  updateCategory(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateExpenseCategoryDto,
  ) {
    return this.service.updateCategory(id, dto);
  }

  @Delete('categories/:id')
  @Roles('admin', 'manager')
  deleteCategory(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.deleteCategory(id);
  }

  // ─── Expenses ────────────────────────────────────────────────────────
  @Get('expenses')
  @ApiOperation({ summary: 'List expenses with filters' })
  listExpenses(@Query() filters: ListExpensesDto) {
    return this.service.listExpenses(filters);
  }

  @Post('expenses')
  @Roles('admin', 'manager', 'accountant')
  @ApiOperation({ summary: 'Create a new expense' })
  createExpense(@Body() dto: CreateExpenseDto, @Req() req: any) {
    return this.service.createExpense(dto, req.user.sub ?? req.user.id);
  }

  @Patch('expenses/:id')
  @Roles('admin', 'manager', 'accountant')
  updateExpense(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateExpenseDto,
  ) {
    return this.service.updateExpense(id, dto);
  }

  @Post('expenses/:id/approve')
  @Roles('admin', 'manager')
  @ApiOperation({ summary: 'Approve an expense (posts to cashbox if cash)' })
  approveExpense(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: any,
  ) {
    return this.service.approveExpense(id, req.user.sub ?? req.user.id);
  }

  @Delete('expenses/:id')
  @Roles('admin', 'manager')
  deleteExpense(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.deleteExpense(id);
  }

  // ─── Reports ─────────────────────────────────────────────────────────
  @Get('reports/profit-and-loss')
  @Roles('admin', 'manager', 'accountant')
  @ApiOperation({ summary: 'Profit & Loss for a date range' })
  profitAndLoss(@Query() dto: ReportRangeDto) {
    return this.service.profitAndLoss(dto);
  }

  @Get('reports/profit-and-loss/analysis')
  @Roles('admin', 'manager', 'accountant')
  @ApiOperation({ summary: 'Smart P&L analysis — verdict + reasons (Arabic)' })
  profitAndLossAnalysis(@Query() dto: ReportRangeDto) {
    return this.service.profitAndLossAnalysis(dto);
  }

  @Get('reports/cashflow')
  @Roles('admin', 'manager', 'accountant')
  @ApiOperation({ summary: 'Cashflow summary by category' })
  cashflow(@Query() dto: ReportRangeDto) {
    return this.service.cashflow(dto);
  }

  @Get('reports/trial-balance')
  @Roles('admin', 'manager', 'accountant')
  @ApiOperation({ summary: 'Trial balance per cashbox' })
  trialBalance(@Query() dto: ReportRangeDto) {
    return this.service.trialBalance(dto);
  }

  @Get('reports/general-ledger')
  @Roles('admin', 'manager', 'accountant')
  @ApiOperation({ summary: 'General ledger — paginated transactions' })
  generalLedger(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('cashbox_id') cashbox_id?: string,
    @Query('category') category?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.service.generalLedger({
      from,
      to,
      cashbox_id,
      category,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  @Get('kpis')
  @Roles('admin', 'manager', 'accountant')
  @ApiOperation({ summary: 'Accounting KPIs for dashboard' })
  kpis(
    @Query('date') date?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    // Either a single `date` or an inclusive `from`/`to` range (Cairo
    // calendar, YYYY-MM-DD). Omit everything to default to today.
    return this.service.kpis({ date, from, to });
  }
}
