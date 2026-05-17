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
import {
  AnyPermissions,
  Permissions,
} from '../common/decorators/roles.decorator';

// ── P3.4C — Arabic row mappers for pricing-reports export ─────────────
// Each MAP_* function takes one raw row from the existing read-side
// service method and returns a flat Arabic-keyed object. The keys
// become the xlsx column headers (toXlsx in reports.service.ts uses
// Object.keys(rows[0]) verbatim). Formulas are unchanged from the
// underlying SELECT — these helpers only relabel + project; no
// computation. Pure functions, zero side-effects.
const fmtBool = (v: any) => (v ? 'نعم' : 'لا');
const fmtNumber = (v: any) =>
  v === null || v === undefined ? '' : Number(v);

function MAP_PRICING_HEALTH(r: any) {
  return {
    'المنتج': r.product_name ?? '',
    'SKU': r.sku ?? '',
    'الباركود': r.barcode ?? '',
    'سعر البيع': fmtNumber(r.selling_price),
    'التكلفة': fmtNumber(r.cost_price),
    'الربح المتوقع': fmtNumber(r.profit),
    'هامش الربح %': fmtNumber(r.margin_pct),
    'الزيادة على التكلفة %': fmtNumber(r.markup_pct),
    'الحد الأدنى للهامش %': fmtNumber(r.min_margin_pct),
    'الحالة': r.status ?? '',
    'المخزون': fmtNumber(r.stock_qty),
  };
}

function MAP_PRICING_LOSSES(r: any) {
  return {
    'المنتج': r.product_name ?? '',
    'SKU': r.sku ?? '',
    'سعر البيع': fmtNumber(r.selling_price),
    'التكلفة': fmtNumber(r.cost_price),
    'الحالة': r.status ?? '',
    'الخسارة المحتملة': fmtNumber(r.loss_exposure),
    'فجوة الهامش %': fmtNumber(r.margin_gap_pct),
    'المخزون': fmtNumber(r.stock_qty),
  };
}

function MAP_PRICING_HISTORY(r: any) {
  return {
    'المنتج': r.product_name ?? '',
    'SKU': r.sku ?? '',
    'السعر القديم': fmtNumber(r.old_selling_price),
    'السعر الجديد': fmtNumber(r.new_selling_price),
    'الفرق': fmtNumber(r.delta_amount),
    'نسبة التغيير %': fmtNumber(r.delta_pct),
    'مصدر التغيير / فاتورة الشراء': r.source_purchase_no ?? '',
    'السبب': r.reason ?? '',
    'المستخدم': r.changed_by_name ?? '',
    'تاريخ التغيير': r.changed_at ?? '',
  };
}

function MAP_PRICING_LANDED(r: any) {
  const last = r.last_purchase ?? {};
  return {
    'المنتج': r.product_name ?? '',
    'SKU': r.sku ?? '',
    'المورد': last.supplier_name ?? '',
    'آخر فاتورة شراء': last.purchase_no ?? '',
    'تكلفة الشراء الأساسية': fmtNumber(r.base_unit_cost),
    'المصاريف المحملة': fmtNumber(r.allocated_cost_per_unit),
    'التكلفة النهائية': fmtNumber(r.landed_unit_cost),
    'سعر البيع الحالي': fmtNumber(r.current_selling_price),
    'هامش الربح %': fmtNumber(r.margin_pct),
    'الزيادة على التكلفة %': fmtNumber(r.markup_pct),
    'يحتاج مراجعة؟': fmtBool(r.needs_review),
    'سبب المراجعة': r.needs_review_reason ?? '',
  };
}

function MAP_SOLD_PROFIT_SUMMARY(r: any) {
  return {
    'من': r.from ?? '',
    'إلى': r.to ?? '',
    'إجمالي المبيعات': fmtNumber(r.total_revenue),
    'تكلفة البضاعة المباعة': fmtNumber(r.total_cogs),
    'مجمل الربح': fmtNumber(r.gross_profit),
    'هامش الربح %': fmtNumber(r.gross_margin_pct),
    'عدد الفواتير': fmtNumber(r.invoice_count),
    'عدد القطع المباعة': fmtNumber(r.total_qty_sold),
    // Net-of-returns is deferred — keep the disclaimer in the export.
    'ملاحظة': 'هذه الأرقام هي إجمالي المبيعات Gross — فواتير المرتجعات مستبعدة لكنها لا تُخصم تلقائيًا.',
  };
}

function MAP_SOLD_PROFIT_PRODUCT(r: any) {
  return {
    'المنتج': r.product_name ?? '',
    'SKU': r.sku ?? '',
    'الكمية المباعة': fmtNumber(r.qty_sold),
    'عدد الفواتير': fmtNumber(r.invoice_count),
    'إجمالي المبيعات': fmtNumber(r.revenue),
    'تكلفة البضاعة المباعة': fmtNumber(r.cogs),
    'مجمل الربح': fmtNumber(r.gross_profit),
    'هامش الربح %': fmtNumber(r.gross_margin_pct),
    'الزيادة على التكلفة %': fmtNumber(r.markup_pct),
    'متوسط سعر البيع': fmtNumber(r.avg_selling_price),
    'متوسط التكلفة': fmtNumber(r.avg_unit_cost),
    'الحالة': r.status ?? '',
    'آخر بيع': r.last_sold_at ?? '',
  };
}

function MAP_SOLD_PROFIT_INVOICE(r: any) {
  return {
    'رقم الفاتورة': r.invoice_no ?? '',
    'العميل': r.customer_name ?? '',
    'التاريخ': r.sold_at ?? '',
    'عدد الأصناف': fmtNumber(r.item_count),
    'عدد القطع': fmtNumber(r.qty_sold),
    'إجمالي المبيعات': fmtNumber(r.revenue),
    'تكلفة البضاعة المباعة': fmtNumber(r.cogs),
    'مجمل الربح': fmtNumber(r.gross_profit),
    'هامش الربح %': fmtNumber(r.gross_margin_pct),
    'الحالة': r.status ?? '',
  };
}

// ── P3.4D — Net-of-returns mappers ─────────────────────────────────
function MAP_NET_SUMMARY(r: any) {
  return {
    'من': r.from ?? '',
    'إلى': r.to ?? '',
    'إجمالي المبيعات': fmtNumber(r.gross_revenue),
    'إجمالي المرتجعات': fmtNumber(r.returns_revenue),
    'صافي المبيعات': fmtNumber(r.net_revenue),
    'تكلفة المبيعات': fmtNumber(r.gross_cogs),
    'تكلفة المرتجعات': fmtNumber(r.returns_cogs),
    'صافي تكلفة البضاعة': fmtNumber(r.net_cogs),
    'صافي الربح': fmtNumber(r.net_profit),
    'هامش صافي الربح %': fmtNumber(r.net_margin_pct),
    'الزيادة على التكلفة %': fmtNumber(r.net_markup_pct),
    'عدد الفواتير': fmtNumber(r.invoice_count),
    'عدد المرتجعات': fmtNumber(r.return_count),
    'كمية مباعة': fmtNumber(r.qty_sold),
    'كمية مرتجعة': fmtNumber(r.qty_returned),
    'ملاحظة':
      'يتم نسب المرتجعات إلى تاريخ ردّ المبلغ (refunded_at) وليس تاريخ البيع الأصلي.',
  };
}

function MAP_NET_PRODUCT(r: any) {
  return {
    'المنتج': r.product_name ?? '',
    'SKU': r.sku ?? '',
    'كمية مباعة': fmtNumber(r.qty_sold),
    'كمية مرتجعة': fmtNumber(r.qty_returned),
    'صافي الكمية': fmtNumber(r.qty_net),
    'مبيعات': fmtNumber(r.sales_revenue),
    'مرتجعات': fmtNumber(r.returns_revenue),
    'صافي المبيعات': fmtNumber(r.net_revenue),
    'تكلفة مبيعات': fmtNumber(r.sales_cogs),
    'تكلفة مرتجعات': fmtNumber(r.returns_cogs),
    'صافي التكلفة': fmtNumber(r.net_cogs),
    'صافي الربح': fmtNumber(r.net_profit),
    'هامش صافي الربح %': fmtNumber(r.net_margin_pct),
    'الزيادة على التكلفة %': fmtNumber(r.net_markup_pct),
    'الحالة': r.status ?? '',
  };
}

@ApiBearerAuth()
@ApiTags('reports')
// Gated on reports.view — grantable per-user via extra_permissions.
@Permissions('reports.view')
@Controller('reports')
export class ReportsController {
  constructor(private readonly svc: ReportsService) {}

  // ── Payment channels (PR-REPORTS-2) ──────────────────────────────────
  // Read-only roll-up powering the /shift-reports payment-channel
  // report. Mirrors `dashboard/payment-channels` but adds cashbox /
  // cashier / shift-status filters so the report matches the
  // all-shifts report exactly. Method-level @AnyPermissions widens
  // the class-level @Permissions('reports.view') so anyone with
  // `shifts.view` (cashiers / managers running their own shifts) can
  // pull this page's data without needing a separate report grant.
  @Get('payment-channels')
  @AnyPermissions('reports.view', 'shifts.view')
  @ApiOperation({
    summary:
      'تقرير وسائل الدفع/الحسابات مع فلاتر الفترة والخزنة والكاشير وحالة الوردية',
  })
  paymentChannels(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('cashbox_id') cashboxId?: string,
    @Query('user_id') userId?: string,
    @Query('status') status?: string,
  ) {
    return this.svc.paymentChannels({
      from,
      to,
      cashbox_id: cashboxId,
      user_id: userId,
      status,
    });
  }

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

  // ── PR-PURCHASES-P3.4A — Pricing reports (read-only) ─────────────────
  // All four endpoints are strictly SELECT — they never mutate prices,
  // accounting, cashbox, stock, or purchases. The service's static
  // guardrail spec asserts this with regex scans.

  @Get('pricing/health')
  @ApiOperation({ summary: 'Per-variant current pricing health' })
  async pricingHealth(
    @Query('q') q?: string,
    @Query('status') status?: string,
    @Query('only_in_stock') onlyInStock?: string,
    @Query('limit') limit?: string,
    @Query('format') format?: 'json' | 'xlsx' | 'pdf',
    @Res({ passthrough: true }) res?: Response,
  ) {
    const result = await this.svc.pricingHealth({
      q,
      status: status as any,
      only_in_stock: onlyInStock === 'true' || onlyInStock === '1',
      limit: limit ? Number(limit) : undefined,
    });
    if (format && format !== 'json' && res) {
      const rows = (result.items || []).map(MAP_PRICING_HEALTH);
      return this.respond(res, rows, format, 'pricing-health', 'صحة الأسعار');
    }
    return result;
  }

  @Get('pricing/losses')
  @ApiOperation({ summary: 'Below-cost / below-min-margin products' })
  async pricingLosses(
    @Query('only_in_stock') onlyInStock?: string,
    @Query('limit') limit?: string,
    @Query('format') format?: 'json' | 'xlsx' | 'pdf',
    @Res({ passthrough: true }) res?: Response,
  ) {
    const result = await this.svc.pricingLosses({
      only_in_stock: onlyInStock === 'true' || onlyInStock === '1',
      limit: limit ? Number(limit) : undefined,
    });
    if (format && format !== 'json' && res) {
      const rows = (result.items || []).map(MAP_PRICING_LOSSES);
      return this.respond(res, rows, format, 'pricing-losses', 'منتجات تحت الحد');
    }
    return result;
  }

  @Get('pricing/history')
  @ApiOperation({ summary: 'Variant selling-price change history' })
  async pricingHistory(
    @Query('variant_id') variant_id?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('format') format?: 'json' | 'xlsx' | 'pdf',
    @Res({ passthrough: true }) res?: Response,
  ) {
    const result = await this.svc.pricingHistory({
      variant_id,
      from,
      to,
      limit: limit ? Number(limit) : undefined,
    });
    if (format && format !== 'json' && res) {
      const rows = (result.items || []).map(MAP_PRICING_HISTORY);
      return this.respond(
        res,
        rows,
        format,
        'pricing-history',
        'تاريخ تغيير الأسعار',
        { from, to },
      );
    }
    return result;
  }

  @Get('pricing/landed-impact')
  @ApiOperation({ summary: 'Last-purchase landed cost vs current price' })
  async pricingLandedImpact(
    @Query('supplier_id') supplier_id?: string,
    @Query('needs_review_only') needsReviewOnly?: string,
    @Query('limit') limit?: string,
    @Query('format') format?: 'json' | 'xlsx' | 'pdf',
    @Res({ passthrough: true }) res?: Response,
  ) {
    const result = await this.svc.pricingLandedImpact({
      supplier_id,
      needs_review_only:
        needsReviewOnly === 'true' || needsReviewOnly === '1',
      limit: limit ? Number(limit) : undefined,
    });
    if (format && format !== 'json' && res) {
      const rows = (result.items || []).map(MAP_PRICING_LANDED);
      return this.respond(
        res,
        rows,
        format,
        'pricing-landed-impact',
        'أثر آخر مشتريات',
      );
    }
    return result;
  }

  // ── PR-PURCHASES-P3.4B — Actual sold profit reports (read-only) ──────
  // Gross sold-profit from posted invoice_items joined with invoices,
  // returns excluded. Pure SELECT; static guardrail spec enforces.

  @Get('pricing/sold-profit/summary')
  @ApiOperation({ summary: 'Aggregate sold-profit over a date range' })
  async soldProfitSummary(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('format') format?: 'json' | 'xlsx' | 'pdf',
    @Res({ passthrough: true }) res?: Response,
  ) {
    const result = await this.svc.soldProfitSummary({ from, to });
    if (format && format !== 'json' && res) {
      // Summary is a single object — wrap in [row] so toXlsx/toPdf
      // get a one-row sheet with Arabic headers.
      const rows = [MAP_SOLD_PROFIT_SUMMARY(result)];
      return this.respond(
        res,
        rows,
        format,
        'sold-profit-summary',
        'الربح الفعلي — ملخص',
        { from, to },
      );
    }
    return result;
  }

  @Get('pricing/sold-profit/products')
  @ApiOperation({ summary: 'Per-variant sold-profit over a date range' })
  async soldProfitProducts(
    @Query('q') q?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('sort') sort?: string,
    @Query('format') format?: 'json' | 'xlsx' | 'pdf',
    @Res({ passthrough: true }) res?: Response,
  ) {
    const result = await this.svc.soldProfitProducts({
      q,
      from,
      to,
      status: status as any,
      limit: limit ? Number(limit) : undefined,
      sort: sort as any,
    });
    if (format && format !== 'json' && res) {
      const rows = (result.items || []).map(MAP_SOLD_PROFIT_PRODUCT);
      return this.respond(
        res,
        rows,
        format,
        'sold-profit-products',
        'الربح الفعلي حسب المنتج',
        { from, to },
      );
    }
    return result;
  }

  @Get('pricing/sold-profit/invoices')
  @ApiOperation({ summary: 'Per-invoice sold-profit over a date range' })
  async soldProfitInvoices(
    @Query('q') q?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('format') format?: 'json' | 'xlsx' | 'pdf',
    @Res({ passthrough: true }) res?: Response,
  ) {
    const result = await this.svc.soldProfitInvoices({
      q,
      from,
      to,
      status: status as any,
      limit: limit ? Number(limit) : undefined,
    });
    if (format && format !== 'json' && res) {
      const rows = (result.items || []).map(MAP_SOLD_PROFIT_INVOICE);
      return this.respond(
        res,
        rows,
        format,
        'sold-profit-invoices',
        'الربح الفعلي حسب الفاتورة',
        { from, to },
      );
    }
    return result;
  }

  // ── P3.4D — Net-of-returns reports (READ-ONLY) ─────────────────────
  // Returns are attributed to `returns.refunded_at`, not the original
  // sale date. A November sale + December return shows up in
  // December's net profit. The gross endpoints above stay unchanged.

  @Get('pricing/sold-profit/net-summary')
  @ApiOperation({
    summary: 'Net-of-returns sold-profit aggregate over a date range',
  })
  async soldProfitNetSummary(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('format') format?: 'json' | 'xlsx' | 'pdf',
    @Res({ passthrough: true }) res?: Response,
  ) {
    const result = await this.svc.soldProfitNetSummary({ from, to });
    if (format && format !== 'json' && res) {
      const rows = [MAP_NET_SUMMARY(result)];
      return this.respond(
        res,
        rows,
        format,
        'sold-profit-net-summary',
        'الربح الفعلي بعد المرتجعات — ملخص',
        { from, to },
      );
    }
    return result;
  }

  @Get('pricing/sold-profit/net-products')
  @ApiOperation({
    summary: 'Per-variant net-of-returns sold-profit over a date range',
  })
  async soldProfitNetProducts(
    @Query('q') q?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('format') format?: 'json' | 'xlsx' | 'pdf',
    @Res({ passthrough: true }) res?: Response,
  ) {
    const result = await this.svc.soldProfitNetProducts({
      q,
      from,
      to,
      status: status as any,
      limit: limit ? Number(limit) : undefined,
    });
    if (format && format !== 'json' && res) {
      const rows = (result.items || []).map(MAP_NET_PRODUCT);
      return this.respond(
        res,
        rows,
        format,
        'sold-profit-net-products',
        'الربح الفعلي بعد المرتجعات حسب المنتج',
        { from, to },
      );
    }
    return result;
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
