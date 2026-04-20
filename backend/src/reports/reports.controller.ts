import {
  Controller,
  Get,
  Query,
  Res,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ReportsService } from './reports.service';
import { SalesReportDto, DateRangeDto, ExportFormatDto } from './dto/reports.dto';
import { Roles } from '../common/decorators/roles.decorator';

@ApiBearerAuth()
@ApiTags('reports')
// Reports are readable by anyone authenticated; sensitive actions stay admin-only.
@Roles('admin', 'manager', 'accountant', 'cashier', 'inventory', 'salesperson')
@Controller('reports')
export class ReportsController {
  constructor(private readonly svc: ReportsService) {}

  // ── Sales ──────────────────────────────────────────────────────────────
  @Get('sales')
  @ApiOperation({ summary: 'تقرير المبيعات حسب الفترة' })
  async sales(
    @Query() q: SalesReportDto & ExportFormatDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rows = await this.svc.salesByPeriod(q.from, q.to, q.group_by ?? 'day');
    return this.respond(res, rows, q.format, 'sales', 'تقرير المبيعات', {
      from: q.from,
      to: q.to,
    });
  }

  @Get('sales-per-user')
  @ApiOperation({ summary: 'مبيعات كل كاشير' })
  async salesPerUser(
    @Query() q: DateRangeDto & ExportFormatDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rows = await this.svc.salesPerUser(q.from, q.to);
    return this.respond(
      res,
      rows,
      q.format,
      'sales-per-user',
      'مبيعات الكاشير',
      { from: q.from, to: q.to },
    );
  }

  // ── Profit ────────────────────────────────────────────────────────────
  @Get('profit')
  @ApiOperation({ summary: 'تقرير الأرباح' })
  async profit(
    @Query() q: DateRangeDto & ExportFormatDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rows = await this.svc.profitByPeriod(q.from, q.to);
    return this.respond(res, rows, q.format, 'profit', 'تقرير الأرباح', {
      from: q.from,
      to: q.to,
    });
  }

  @Get('top-products')
  @ApiOperation({ summary: 'أفضل المنتجات مبيعاً' })
  async topProducts(
    @Query() q: DateRangeDto & ExportFormatDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rows = await this.svc.topProducts(q.from, q.to);
    return this.respond(
      res,
      rows,
      q.format,
      'top-products',
      'أفضل المنتجات',
      { from: q.from, to: q.to },
    );
  }

  // ── Inventory ─────────────────────────────────────────────────────────
  @Get('stock-valuation')
  @ApiOperation({ summary: 'تقييم المخزون' })
  async stockValuation(
    @Query() q: ExportFormatDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rows = await this.svc.stockValuation();
    return this.respond(
      res,
      rows,
      q.format,
      'stock-valuation',
      'تقييم المخزون',
    );
  }

  @Get('low-stock')
  @ApiOperation({ summary: 'المنتجات منخفضة المخزون' })
  async lowStock(
    @Query() q: ExportFormatDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rows = await this.svc.lowStock();
    return this.respond(res, rows, q.format, 'low-stock', 'مخزون منخفض');
  }

  // ── Returns ───────────────────────────────────────────────────────────
  @Get('returns')
  @ApiOperation({ summary: 'تقرير المرتجعات' })
  async returns(
    @Query() q: DateRangeDto & ExportFormatDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rows = await this.svc.returnsReport(q.from, q.to);
    return this.respond(res, rows, q.format, 'returns', 'المرتجعات', {
      from: q.from,
      to: q.to,
    });
  }

  // ── Advanced reports ──────────────────────────────────────────────────
  @Get('profit-margin')
  @ApiOperation({ summary: 'هامش الربح حسب المنتج' })
  async profitMargin(
    @Query() q: ExportFormatDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rows = await this.svc.profitMargin(200);
    return this.respond(res, rows, q.format, 'profit-margin', 'هامش الربح');
  }

  @Get('dead-stock')
  @ApiOperation({ summary: 'مخزون راكد (بدون مبيعات آخر 90 يوم)' })
  async deadStock(
    @Query() q: ExportFormatDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rows = await this.svc.deadStock(500);
    return this.respond(res, rows, q.format, 'dead-stock', 'مخزون راكد');
  }

  @Get('compare-periods')
  @ApiOperation({ summary: 'مقارنة فترتين (A vs B)' })
  comparePeriods(
    @Query('from_a') fromA: string,
    @Query('to_a') toA: string,
    @Query('from_b') fromB: string,
    @Query('to_b') toB: string,
  ) {
    if (!fromA || !toA || !fromB || !toB) {
      throw new HttpException(
        'from_a, to_a, from_b, to_b are all required',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.svc.comparePeriods(fromA, toA, fromB, toB);
  }

  @Get('sales-daily')
  @ApiOperation({ summary: 'مبيعات يومية (للشارت)' })
  salesDaily(@Query('from') from: string, @Query('to') to: string) {
    if (!from || !to) {
      throw new HttpException(
        'from & to are required (YYYY-MM-DD)',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.svc.salesDaily(from, to);
  }

  // ── Outstanding ───────────────────────────────────────────────────────
  @Get('customers-outstanding')
  @ApiOperation({ summary: 'أرصدة العملاء المدينة' })
  async customersOutstanding(
    @Query() q: ExportFormatDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rows = await this.svc.customersOutstanding();
    return this.respond(
      res,
      rows,
      q.format,
      'customers-outstanding',
      'أرصدة العملاء',
    );
  }

  @Get('suppliers-outstanding')
  @ApiOperation({ summary: 'أرصدة الموردين المدينة' })
  async suppliersOutstanding(
    @Query() q: ExportFormatDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rows = await this.svc.suppliersOutstanding();
    return this.respond(
      res,
      rows,
      q.format,
      'suppliers-outstanding',
      'أرصدة الموردين',
    );
  }

  // ── Helper ───────────────────────────────────────────────────────────
  private async respond(
    res: Response,
    rows: any[],
    format: 'json' | 'xlsx' | 'pdf' | undefined,
    slug: string,
    titleAr: string,
    meta?: Record<string, any>,
  ) {
    const f = format || 'json';
    if (f === 'json') {
      return rows;
    }
    try {
      if (f === 'xlsx') {
        const buf = await this.svc.toXlsx(rows, slug);
        res.setHeader(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        );
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${slug}-${Date.now()}.xlsx"`,
        );
        return res.send(buf);
      }
      if (f === 'pdf') {
        const buf = await this.svc.toPdf(titleAr, rows, meta);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${slug}-${Date.now()}.pdf"`,
        );
        return res.send(buf);
      }
    } catch (e: any) {
      throw new HttpException(
        `Export failed: ${e.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
