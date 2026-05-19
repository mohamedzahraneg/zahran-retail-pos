/**
 * inventory-reports.service.ts — PR-INVENTORY-REPORTS
 *
 * Strictly read-only inventory analytics. Every method is a pure
 * SELECT — no INSERT / UPDATE / DELETE anywhere. The four supported
 * reports:
 *
 *   1. valuation      — per-variant on-hand × cost / price, with
 *                       rollups for total qty / cost / sale / margin.
 *   2. low-stock      — variants with on_hand <= reorder_point > 0
 *                       OR on_hand <= 0.
 *   3. dead-stock     — variants with no sale in the last N days
 *                       (30 / 60 / 90 / 180) but still holding
 *                       on-hand stock.
 *   4. profitability  — sold_qty / returned_qty / net_qty / sales /
 *                       cogs / gross profit / margin% rolled up by
 *                       product or variant.
 *
 * Branch + group filters always go through `EXISTS` sub-queries so
 * a variant in multiple groups (or a warehouse linked to multiple
 * branches) never multiplies report rows.
 *
 * Tenant-readiness: every query will need a `tenant_id` filter once
 * the column lands; the helper queries are otherwise unaware of
 * tenancy today.
 */
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface ValuationFilters {
  branch_id?: string;
  warehouse_id?: string;
  group_id?: string;
  category_id?: string;
  brand_id?: string;
  search?: string;
  /**
   * PR-USER-BRANCH-WAREHOUSE-ACCESS — allow-list filled by the
   * controller from AccessScopeService.getUserWarehouseIds().
   * `undefined` = no restriction (bypass / fallback). Empty array
   * yields zero rows.
   */
  warehouse_ids?: string[];
}

export interface LowStockFilters {
  branch_id?: string;
  warehouse_id?: string;
  group_id?: string;
  category_id?: string;
  brand_id?: string;
  warehouse_ids?: string[];
}

export interface DeadStockFilters {
  branch_id?: string;
  warehouse_id?: string;
  group_id?: string;
  days?: number;
  warehouse_ids?: string[];
}

export interface ProfitabilityFilters {
  branch_id?: string;
  warehouse_id?: string;
  group_id?: string;
  date_from?: string;
  date_to?: string;
  warehouse_ids?: string[];
}

@Injectable()
export class InventoryReportsService {
  constructor(private readonly ds: DataSource) {}

  // ─── Helpers ─────────────────────────────────────────────────────
  /**
   * EXISTS sub-query against `warehouse_branches`. Returns the SQL
   * fragment to be inserted into a WHERE clause; the caller is
   * expected to have already pushed `branch_id` into the params
   * array at the slot matching `paramIdx`.
   */
  private branchWarehouseExists(
    warehouseCol: string,
    paramIdx: number,
  ): string {
    return `EXISTS (
      SELECT 1 FROM warehouse_branches wb
       WHERE wb.warehouse_id = ${warehouseCol}
         AND wb.branch_id    = $${paramIdx}::uuid
    )`;
  }

  private groupVariantExists(
    variantCol: string,
    paramIdx: number,
  ): string {
    return `EXISTS (
      SELECT 1 FROM product_group_variants pgv
       WHERE pgv.variant_id = ${variantCol}
         AND pgv.group_id   = $${paramIdx}::uuid
    )`;
  }

  /**
   * PR-USER-BRANCH-WAREHOUSE-ACCESS — push the user's allow-list of
   * warehouse_ids into `params` and append the matching `=ANY($N)`
   * clause to `conds`. Empty allow-list short-circuits the query
   * with `FALSE` (intersection-no-match).
   */
  private addAllowedWarehousesClause(
    warehouseCol: string,
    allowed: string[] | undefined,
    params: any[],
    conds: string[],
  ): void {
    if (allowed === undefined) return;
    if (allowed.length === 0) {
      conds.push('FALSE');
      return;
    }
    params.push(allowed);
    conds.push(`${warehouseCol} = ANY($${params.length}::uuid[])`);
  }

  // ─── 1. Valuation ────────────────────────────────────────────────
  async valuation(filters: ValuationFilters = {}) {
    const conds: string[] = [
      `p.is_active = TRUE`,
      `p.deleted_at IS NULL`,
      `pv.is_active = TRUE`,
      `pv.deleted_at IS NULL`,
    ];
    const params: any[] = [];

    if (filters.warehouse_id) {
      params.push(filters.warehouse_id);
      conds.push(`s.warehouse_id = $${params.length}::uuid`);
    }
    if (filters.branch_id) {
      params.push(filters.branch_id);
      conds.push(this.branchWarehouseExists('s.warehouse_id', params.length));
    }
    this.addAllowedWarehousesClause(
      's.warehouse_id',
      filters.warehouse_ids,
      params,
      conds,
    );
    if (filters.category_id) {
      params.push(filters.category_id);
      conds.push(`p.category_id = $${params.length}::uuid`);
    }
    if (filters.brand_id) {
      params.push(filters.brand_id);
      conds.push(`p.brand_id = $${params.length}::uuid`);
    }
    if (filters.group_id) {
      params.push(filters.group_id);
      conds.push(this.groupVariantExists('pv.id', params.length));
    }
    if (filters.search && filters.search.trim()) {
      const term = `%${filters.search.trim()}%`;
      params.push(term);
      const idx = params.length;
      conds.push(
        `(p.name_ar ILIKE $${idx} OR p.name_en ILIKE $${idx} OR pv.sku ILIKE $${idx} OR pv.barcode::text ILIKE $${idx})`,
      );
    }

    const where = `WHERE ${conds.join(' AND ')}`;

    // Totals roll-up — single SELECT so the FE doesn't need to sum
    // table rows itself.
    const [totalsRow] = await this.ds.query(
      `SELECT
         COALESCE(SUM(s.quantity_on_hand), 0)::int  AS total_qty,
         COALESCE(SUM(s.quantity_on_hand - s.quantity_reserved), 0)::int  AS total_available,
         COALESCE(SUM(s.quantity_on_hand
                       * COALESCE(NULLIF(s.avg_cost, 0), pv.cost_price, 0))::numeric(18,2), 0) AS total_cost_value,
         COALESCE(SUM(s.quantity_on_hand * pv.selling_price)::numeric(18,2), 0) AS total_sale_value
         FROM stock s
         JOIN product_variants pv ON pv.id = s.variant_id
         JOIN products p          ON p.id  = pv.product_id
        ${where}`,
      params,
    );

    const items = await this.ds.query(
      `SELECT p.id              AS product_id,
              p.name_ar         AS product_name,
              p.sku_prefix,
              pv.id             AS variant_id,
              pv.sku,
              pv.color,
              pv.size,
              w.id              AS warehouse_id,
              w.name_ar         AS warehouse_name,
              s.quantity_on_hand,
              s.quantity_reserved,
              (s.quantity_on_hand - s.quantity_reserved)::int AS available_quantity,
              pv.cost_price,
              pv.selling_price,
              s.avg_cost,
              (s.quantity_on_hand
                * COALESCE(NULLIF(s.avg_cost, 0), pv.cost_price, 0))::numeric(18,2) AS stock_cost_value,
              (s.quantity_on_hand * pv.selling_price)::numeric(18,2)               AS stock_sale_value,
              (s.quantity_on_hand
                * (pv.selling_price
                   - COALESCE(NULLIF(s.avg_cost, 0), pv.cost_price, 0))
              )::numeric(18,2) AS potential_margin,
              COALESCE(g.group_ids,      '{}'::text[]) AS group_ids,
              COALESCE(g.group_names_ar, '{}'::text[]) AS group_names_ar,
              COALESCE(g.group_colors,   '{}'::text[]) AS group_colors
         FROM stock s
         JOIN product_variants pv ON pv.id = s.variant_id
         JOIN products p          ON p.id  = pv.product_id
         JOIN warehouses w        ON w.id  = s.warehouse_id
         LEFT JOIN LATERAL (
           SELECT array_agg(pg.id::text ORDER BY pg.name_ar) AS group_ids,
                  array_agg(pg.name_ar  ORDER BY pg.name_ar) AS group_names_ar,
                  array_agg(pg.color    ORDER BY pg.name_ar) AS group_colors
             FROM product_group_variants pgv
             JOIN product_groups pg ON pg.id = pgv.group_id
            WHERE pgv.variant_id = pv.id
              AND pg.is_active   = TRUE
         ) g ON TRUE
        ${where}
        ORDER BY stock_cost_value DESC NULLS LAST, p.name_ar ASC
        LIMIT 1000`,
      params,
    );

    const totals = {
      total_qty: Number(totalsRow?.total_qty ?? 0),
      total_available: Number(totalsRow?.total_available ?? 0),
      total_cost_value: Number(totalsRow?.total_cost_value ?? 0),
      total_sale_value: Number(totalsRow?.total_sale_value ?? 0),
      potential_margin:
        Number(totalsRow?.total_sale_value ?? 0)
        - Number(totalsRow?.total_cost_value ?? 0),
    };

    return { totals, items };
  }

  // ─── 2. Low / out of stock ───────────────────────────────────────
  async lowStock(filters: LowStockFilters = {}) {
    const conds: string[] = [
      `p.is_active = TRUE`,
      `p.deleted_at IS NULL`,
      `pv.is_active = TRUE`,
      `pv.deleted_at IS NULL`,
      // The actual "low or out" predicate:
      `(
        (s.reorder_point > 0 AND s.quantity_on_hand <= s.reorder_point)
        OR s.quantity_on_hand <= 0
      )`,
    ];
    const params: any[] = [];

    if (filters.warehouse_id) {
      params.push(filters.warehouse_id);
      conds.push(`s.warehouse_id = $${params.length}::uuid`);
    }
    if (filters.branch_id) {
      params.push(filters.branch_id);
      conds.push(this.branchWarehouseExists('s.warehouse_id', params.length));
    }
    this.addAllowedWarehousesClause(
      's.warehouse_id',
      filters.warehouse_ids,
      params,
      conds,
    );
    if (filters.category_id) {
      params.push(filters.category_id);
      conds.push(`p.category_id = $${params.length}::uuid`);
    }
    if (filters.brand_id) {
      params.push(filters.brand_id);
      conds.push(`p.brand_id = $${params.length}::uuid`);
    }
    if (filters.group_id) {
      params.push(filters.group_id);
      conds.push(this.groupVariantExists('pv.id', params.length));
    }

    const where = `WHERE ${conds.join(' AND ')}`;

    const items = await this.ds.query(
      `SELECT p.id                    AS product_id,
              p.name_ar               AS product_name,
              p.sku_prefix,
              pv.id                   AS variant_id,
              pv.sku,
              pv.color,
              pv.size,
              w.id                    AS warehouse_id,
              w.name_ar               AS warehouse_name,
              s.quantity_on_hand,
              s.reorder_point,
              (s.quantity_on_hand - s.quantity_reserved)::int AS available_quantity,
              CASE
                WHEN s.quantity_on_hand <= 0 THEN 'out'
                ELSE 'low'
              END                     AS shortage_kind,
              GREATEST(0, s.reorder_point - s.quantity_on_hand)::int AS units_short
         FROM stock s
         JOIN product_variants pv ON pv.id = s.variant_id
         JOIN products p          ON p.id  = pv.product_id
         JOIN warehouses w        ON w.id  = s.warehouse_id
        ${where}
        ORDER BY shortage_kind DESC, units_short DESC, p.name_ar ASC
        LIMIT 1000`,
      params,
    );

    const totals = {
      low_count: items.filter((r: any) => r.shortage_kind === 'low').length,
      out_count: items.filter((r: any) => r.shortage_kind === 'out').length,
      total_units_short: items.reduce(
        (acc: number, r: any) => acc + Number(r.units_short ?? 0),
        0,
      ),
    };

    return { totals, items };
  }

  // ─── 3. Dead stock ───────────────────────────────────────────────
  async deadStock(filters: DeadStockFilters = {}) {
    const days = Math.max(1, Math.min(365, Number(filters.days ?? 90)));
    const conds: string[] = [
      `p.is_active = TRUE`,
      `p.deleted_at IS NULL`,
      `pv.is_active = TRUE`,
      `pv.deleted_at IS NULL`,
      `s.quantity_on_hand > 0`,
      // No sale in the last N days. Voided invoices + returns are
      // ignored in the inner aggregate.
      `NOT EXISTS (
         SELECT 1
           FROM invoice_items ii
           JOIN invoices inv ON inv.id = ii.invoice_id
          WHERE ii.variant_id = pv.id
            AND inv.warehouse_id = s.warehouse_id
            AND inv.voided_at IS NULL
            AND inv.is_return = FALSE
            AND inv.created_at >= NOW() - ($1::int * INTERVAL '1 day')
       )`,
    ];
    const params: any[] = [days];

    if (filters.warehouse_id) {
      params.push(filters.warehouse_id);
      conds.push(`s.warehouse_id = $${params.length}::uuid`);
    }
    if (filters.branch_id) {
      params.push(filters.branch_id);
      conds.push(this.branchWarehouseExists('s.warehouse_id', params.length));
    }
    this.addAllowedWarehousesClause(
      's.warehouse_id',
      filters.warehouse_ids,
      params,
      conds,
    );
    if (filters.group_id) {
      params.push(filters.group_id);
      conds.push(this.groupVariantExists('pv.id', params.length));
    }

    const where = `WHERE ${conds.join(' AND ')}`;

    const items = await this.ds.query(
      `SELECT p.id                  AS product_id,
              p.name_ar             AS product_name,
              p.sku_prefix,
              pv.id                 AS variant_id,
              pv.sku,
              pv.color,
              pv.size,
              w.id                  AS warehouse_id,
              w.name_ar             AS warehouse_name,
              s.quantity_on_hand,
              s.quantity_reserved,
              pv.cost_price,
              (s.quantity_on_hand
                * COALESCE(NULLIF(s.avg_cost, 0), pv.cost_price, 0))::numeric(18,2) AS stuck_cost_value,
              (SELECT MAX(ii.created_at)
                 FROM invoice_items ii
                 JOIN invoices inv ON inv.id = ii.invoice_id
                WHERE ii.variant_id = pv.id
                  AND inv.warehouse_id = s.warehouse_id
                  AND inv.voided_at IS NULL
                  AND inv.is_return = FALSE) AS last_sale_at
         FROM stock s
         JOIN product_variants pv ON pv.id = s.variant_id
         JOIN products p          ON p.id  = pv.product_id
         JOIN warehouses w        ON w.id  = s.warehouse_id
        ${where}
        ORDER BY stuck_cost_value DESC NULLS LAST, p.name_ar ASC
        LIMIT 1000`,
      params,
    );

    const totals = {
      items_count: items.length,
      total_units: items.reduce(
        (acc: number, r: any) => acc + Number(r.quantity_on_hand ?? 0),
        0,
      ),
      total_cost_value: items.reduce(
        (acc: number, r: any) => acc + Number(r.stuck_cost_value ?? 0),
        0,
      ),
      days_window: days,
    };

    return { totals, items };
  }

  // ─── 4. Profitability ────────────────────────────────────────────
  async profitability(filters: ProfitabilityFilters = {}) {
    const conds: string[] = [
      `inv.voided_at IS NULL`,
    ];
    const params: any[] = [];

    if (filters.date_from) {
      params.push(filters.date_from);
      conds.push(`inv.created_at >= $${params.length}::timestamptz`);
    }
    if (filters.date_to) {
      params.push(filters.date_to);
      conds.push(
        `inv.created_at < ($${params.length}::date + INTERVAL '1 day')`,
      );
    }
    if (filters.warehouse_id) {
      params.push(filters.warehouse_id);
      conds.push(`inv.warehouse_id = $${params.length}::uuid`);
    }
    if (filters.branch_id) {
      params.push(filters.branch_id);
      conds.push(
        this.branchWarehouseExists('inv.warehouse_id', params.length),
      );
    }
    this.addAllowedWarehousesClause(
      'inv.warehouse_id',
      filters.warehouse_ids,
      params,
      conds,
    );
    if (filters.group_id) {
      params.push(filters.group_id);
      conds.push(this.groupVariantExists('ii.variant_id', params.length));
    }

    const where = `WHERE ${conds.join(' AND ')}`;

    // Per-product aggregate. We split sales (is_return=FALSE) and
    // returns (is_return=TRUE) into separate SUMs via FILTER so a
    // return doesn't double-dip the COGS.
    const items = await this.ds.query(
      `SELECT p.id                    AS product_id,
              p.name_ar               AS product_name,
              p.sku_prefix,
              COALESCE(SUM(ii.quantity) FILTER (WHERE inv.is_return = FALSE), 0)::int  AS sold_qty,
              COALESCE(SUM(ii.quantity) FILTER (WHERE inv.is_return = TRUE),  0)::int  AS returned_qty,
              COALESCE(SUM(CASE WHEN inv.is_return = FALSE THEN ii.quantity
                                ELSE -ii.quantity END), 0)::int                       AS net_qty,
              COALESCE(SUM(ii.line_total) FILTER (WHERE inv.is_return = FALSE),
                       0)::numeric(18,2)                                              AS sales_total,
              COALESCE(SUM(ii.unit_cost * ii.quantity) FILTER (WHERE inv.is_return = FALSE),
                       0)::numeric(18,2)                                              AS cogs_total,
              (
                COALESCE(SUM(ii.line_total) FILTER (WHERE inv.is_return = FALSE), 0)
                - COALESCE(SUM(ii.unit_cost * ii.quantity) FILTER (WHERE inv.is_return = FALSE), 0)
              )::numeric(18,2)                                                        AS gross_profit
         FROM invoice_items ii
         JOIN invoices inv     ON inv.id = ii.invoice_id
         JOIN product_variants pv ON pv.id = ii.variant_id
         JOIN products p          ON p.id  = pv.product_id
        ${where}
        GROUP BY p.id, p.name_ar, p.sku_prefix
        ORDER BY gross_profit DESC NULLS LAST, sales_total DESC NULLS LAST
        LIMIT 1000`,
      params,
    );

    const enriched = items.map((r: any) => {
      const sales = Number(r.sales_total ?? 0);
      const gross = Number(r.gross_profit ?? 0);
      return {
        ...r,
        sold_qty: Number(r.sold_qty ?? 0),
        returned_qty: Number(r.returned_qty ?? 0),
        net_qty: Number(r.net_qty ?? 0),
        sales_total: sales,
        cogs_total: Number(r.cogs_total ?? 0),
        gross_profit: gross,
        margin_pct: sales > 0
          ? Number(((gross / sales) * 100).toFixed(2))
          : 0,
      };
    });

    const totals = enriched.reduce(
      (acc: any, r: any) => {
        acc.sold_qty += r.sold_qty;
        acc.returned_qty += r.returned_qty;
        acc.net_qty += r.net_qty;
        acc.sales_total += r.sales_total;
        acc.cogs_total += r.cogs_total;
        acc.gross_profit += r.gross_profit;
        return acc;
      },
      {
        sold_qty: 0,
        returned_qty: 0,
        net_qty: 0,
        sales_total: 0,
        cogs_total: 0,
        gross_profit: 0,
      },
    );
    const overallMargin =
      totals.sales_total > 0
        ? Number(((totals.gross_profit / totals.sales_total) * 100).toFixed(2))
        : 0;

    return {
      totals: { ...totals, margin_pct: overallMargin },
      items: enriched,
    };
  }
}
