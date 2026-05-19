/**
 * InventoryService — PR-FIX-INVENTORY-API-FOUNDATION
 *
 * Read-only inventory queries powering the future inventory section.
 * Every method here is a pure SELECT: no INSERTs, no UPDATEs, no
 * trigger writes, no `fn_adjust_stock*` calls. The Safety + Hygiene
 * PRs already shipped the canonical write path (INSERT INTO
 * stock_movements → trg_apply_stock_movement); this service stays
 * strictly on the read side.
 *
 * Data sources (all read-only):
 *   · products, product_variants, colors, sizes, categories, brands
 *   · warehouses
 *   · stock (snapshot table) — read via `v_stock_unified` view
 *     introduced in migration 143b
 *   · stock_movements (immutable ledger)
 *   · variant_price_history, variant_cost_history
 *   · invoices, invoice_items (for sales velocity in /products/:id/360)
 *   · purchases, purchase_items (recent purchases in /products/:id/360)
 *   · returns, return_items (return velocity in /products/:id/360)
 *
 * Tenant-readiness:
 *   `tenant_id` does not yet exist on any inventory table (audited).
 *   The query helpers in this service therefore do NOT filter by
 *   tenant today. When `tenant_id` lands, every query in this file
 *   will need a `WHERE tenant_id = :tenant` clause — search for
 *   `TODO(tenant)` markers below.
 */
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface InventoryDashboardResponse {
  totals: {
    total_products: number;
    total_variants: number;
    total_stock_qty: number;
    total_available_qty: number;
    total_stock_cost_value: number;
    total_stock_sale_value: number;
    low_stock_count: number;
    out_of_stock_count: number;
    warehouses_count: number;
    movements_today_count: number;
    /**
     * PR-FIX-INVENTORY-API-PRODUCT-GROUPS — number of ACTIVE
     * product_groups that contain at least one variant currently in
     * low-stock (quantity_on_hand > 0 and ≤ reorder_point).
     */
    low_stock_groups_count: number;
  };
  top_low_stock: Array<{
    variant_id: string;
    product_id: string;
    product_name: string;
    sku: string;
    color_name: string | null;
    size_label: string | null;
    warehouse_id: string;
    warehouse_name: string;
    quantity_on_hand: number;
    reorder_point: number;
  }>;
  recent_movements: Array<{
    id: string;
    created_at: string;
    movement_type: string;
    direction: 'in' | 'out';
    quantity: number;
    variant_id: string;
    product_name: string;
    sku: string;
    warehouse_name: string;
    source_module: string | null;
    source_action: string | null;
  }>;
  /**
   * PR-FIX-INVENTORY-API-PRODUCT-GROUPS — top-5 ACTIVE product
   * groups by current stock value (qty_on_hand × cost). Cost falls
   * back from stock.avg_cost → variant.cost_price → 0.
   */
  top_groups_by_stock_value: Array<{
    group_id: string;
    name_ar: string;
    name_en: string | null;
    color: string | null;
    stock_qty: number;
    stock_value: number;
  }>;
  /**
   * PR-FIX-INVENTORY-API-PRODUCT-GROUPS — top-5 ACTIVE product
   * groups by sales revenue in the last 30 days. Skips voided
   * invoices and return-style invoices (is_return=TRUE).
   */
  top_groups_by_sales_30d: Array<{
    group_id: string;
    name_ar: string;
    color: string | null;
    revenue_30d: number;
    qty_30d: number;
  }>;
}

export interface InventoryBalancesFilters {
  page?: number;
  limit?: number;
  search?: string;
  warehouse_id?: string;
  category_id?: string;
  brand_id?: string;
  color_id?: string;
  size_id?: string;
  /**
   * Filter to balances whose variant belongs to the given group.
   * Uses an EXISTS sub-query against `product_group_variants` so a
   * variant that belongs to N groups still produces ONE balance row.
   */
  group_id?: string;
  /**
   * PR-BRANCHES-INVENTORY-FILTERS — restrict to warehouses linked to
   * the given branch via `warehouse_branches`. EXISTS sub-query — no
   * row multiplication if a warehouse is linked to multiple branches.
   * When combined with `warehouse_id`, both apply (intersection):
   * "this specific warehouse, and it must belong to this branch".
   */
  branch_id?: string;
  /**
   * PR-USER-BRANCH-WAREHOUSE-ACCESS — allow-list of warehouse_ids
   * the calling user is permitted to see. The controller fills this
   * from AccessScopeService.getUserWarehouseIds(); `undefined` means
   * "no scope restriction" (admin / fallback-allow-all). An empty
   * array deliberately yields zero rows.
   */
  warehouse_ids?: string[];
  low_stock?: boolean;
  out_of_stock?: boolean;
}

export interface InventoryMovementsFilters {
  page?: number;
  limit?: number;
  variant_id?: string;
  product_id?: string;
  warehouse_id?: string;
  movement_type?: string;
  direction?: 'in' | 'out';
  reference_type?: string;
  date_from?: string;
  date_to?: string;
  search?: string;
  /**
   * Filter to movements whose variant belongs to the given group.
   * EXISTS sub-query — no row duplication.
   */
  group_id?: string;
  /**
   * PR-BRANCHES-INVENTORY-FILTERS — restrict to movements on
   * warehouses linked to the given branch.
   */
  branch_id?: string;
  /** PR-USER-BRANCH-WAREHOUSE-ACCESS — see InventoryBalancesFilters. */
  warehouse_ids?: string[];
}

/**
 * PR-BRANCHES-INVENTORY-FILTERS — dashboard scope filters. Today
 * just `branch_id`; tenant_id will land here later.
 */
export interface InventoryDashboardFilters {
  branch_id?: string;
  /** PR-USER-BRANCH-WAREHOUSE-ACCESS — see InventoryBalancesFilters. */
  warehouse_ids?: string[];
}

@Injectable()
export class InventoryService {
  constructor(private readonly ds: DataSource) {}

  /**
   * PR-BRANCHES-INVENTORY-FILTERS — build the EXISTS clause that
   * scopes a `*.warehouse_id` column to warehouses linked to a
   * given branch through `warehouse_branches`. Returns an empty
   * string when no branch is given, so callers can interpolate
   * unconditionally:
   *
   *   const branchClause = this.branchWarehouseClause('sm.warehouse_id', filters.branch_id, params);
   *   conds.push(...branchClause ? [branchClause] : []);
   *
   * The caller is responsible for pushing the branch_id onto
   * `params` BEFORE calling this helper (done inline below).
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

  // ============================================================================
  // GET /inventory/dashboard
  // ============================================================================
  /**
   * Aggregate counts + top-N lists for the inventory landing screen.
   * One round-trip per logical group (totals / top_low_stock /
   * recent_movements) so a slow row count doesn't block the list
   * queries.
   *
   * PR-BRANCHES-INVENTORY-FILTERS — when `filters.branch_id` is set,
   * every KPI / list is scoped to warehouses linked to that branch
   * through `warehouse_branches`. Variant / product / group counts
   * that are inherently warehouse-less (`total_products`,
   * `total_variants`) stay global — only stock/movements counts and
   * value totals get scoped.
   *
   * TODO(tenant): every sub-query below needs a tenant_id filter
   * once the column lands.
   */
  async getDashboard(
    filters: InventoryDashboardFilters = {},
  ): Promise<InventoryDashboardResponse> {
    // ── Build the per-query scope. The two scope dimensions are:
    //    · branch_id          → $1 when present (PR-BRANCHES-INVENTORY-FILTERS)
    //    · warehouse_ids[]    → $1 or $2 depending on branch presence
    //                           (PR-USER-BRANCH-WAREHOUSE-ACCESS)
    //
    //    Both dimensions are AND-combined in every sub-query that
    //    touches a warehouse-scoped table. The shared `dashParams`
    //    array is bound positionally to each sub-query call.
    const branchId = filters.branch_id || null;
    const allowed = filters.warehouse_ids;
    const allowedEmpty = Array.isArray(allowed) && allowed.length === 0;

    const dashParams: any[] = [];
    if (branchId) dashParams.push(branchId);
    if (allowed && allowed.length > 0) dashParams.push(allowed);

    const branchIdx = branchId ? dashParams.indexOf(branchId) + 1 : 0;
    const allowedIdx =
      allowed && allowed.length > 0
        ? dashParams.indexOf(allowed) + 1
        : 0;

    /**
     * Build the additional AND clause for a sub-query that filters by
     * a warehouse column. Empty when no scope; otherwise a chain of
     * `AND <branch EXISTS> AND <warehouse_id = ANY(...)>`. An empty
     * allow-list short-circuits to `AND FALSE` so the user sees zero
     * rows.
     */
    const scopeClause = (warehouseCol: string): string => {
      if (allowedEmpty) return 'AND FALSE';
      const parts: string[] = [];
      if (branchIdx > 0) {
        parts.push(`AND ${this.branchWarehouseExists(warehouseCol, branchIdx)}`);
      }
      if (allowedIdx > 0) {
        parts.push(`AND ${warehouseCol} = ANY($${allowedIdx}::uuid[])`);
      }
      return parts.join(' ');
    };

    const stockBranchClause = scopeClause('warehouse_id');
    const stockTableBranchClause = scopeClause('s.warehouse_id');
    const movementsBranchClause = scopeClause('sm.warehouse_id');
    const warehousesBranchClause = scopeClause('id');

    // ── Totals (one big SELECT with sub-queries) ───────────────────
    const [totalsRow] = await this.ds.query(
      `SELECT
         (SELECT COUNT(*) FROM products
           WHERE is_active = TRUE AND deleted_at IS NULL)              AS total_products,
         (SELECT COUNT(*) FROM product_variants
           WHERE is_active = TRUE AND deleted_at IS NULL)              AS total_variants,
         (SELECT COALESCE(SUM(quantity_on_hand), 0)
            FROM v_stock_unified
           WHERE 1=1 ${stockBranchClause})                              AS total_stock_qty,
         (SELECT COALESCE(SUM(available_quantity), 0)
            FROM v_stock_unified
           WHERE 1=1 ${stockBranchClause})                              AS total_available_qty,
         (SELECT COALESCE(SUM(s.quantity_on_hand
                              * COALESCE(NULLIF(s.avg_cost,0),
                                         pv.cost_price, 0))::numeric(18,2), 0)
            FROM stock s
            JOIN product_variants pv ON pv.id = s.variant_id
           WHERE 1=1 ${stockTableBranchClause})                          AS total_stock_cost_value,
         (SELECT COALESCE(SUM(s.quantity_on_hand
                              * pv.selling_price)::numeric(18,2), 0)
            FROM stock s
            JOIN product_variants pv ON pv.id = s.variant_id
           WHERE 1=1 ${stockTableBranchClause})                          AS total_stock_sale_value,
         (SELECT COUNT(*) FROM v_stock_unified
           WHERE quantity_on_hand > 0
             AND reorder_point > 0
             AND quantity_on_hand <= reorder_point ${stockBranchClause})  AS low_stock_count,
         (SELECT COUNT(*) FROM v_stock_unified
           WHERE quantity_on_hand <= 0 ${stockBranchClause})              AS out_of_stock_count,
         (SELECT COUNT(*) FROM warehouses
           WHERE is_active = TRUE ${warehousesBranchClause})              AS warehouses_count,
         (SELECT COUNT(*) FROM stock_movements sm
           WHERE sm.created_at::date = CURRENT_DATE ${movementsBranchClause}) AS movements_today_count,
         (SELECT COUNT(DISTINCT g.id)
            FROM product_groups g
            JOIN product_group_variants pgv ON pgv.group_id   = g.id
            JOIN stock s                    ON s.variant_id   = pgv.variant_id
           WHERE g.is_active        = TRUE
             AND s.reorder_point   > 0
             AND s.quantity_on_hand > 0
             AND s.quantity_on_hand <= s.reorder_point ${stockTableBranchClause}) AS low_stock_groups_count`,
      dashParams,
    );

    // ── Top 10 low-stock items ─────────────────────────────────────
    const topLowStockBranchClause = scopeClause('s.warehouse_id');
    const topLowStock = await this.ds.query(
      `SELECT pv.id          AS variant_id,
              p.id           AS product_id,
              p.name_ar      AS product_name,
              pv.sku,
              c.name_ar      AS color_name,
              sz.size_label,
              w.id           AS warehouse_id,
              w.name_ar      AS warehouse_name,
              s.quantity_on_hand,
              s.reorder_point
         FROM stock s
         JOIN product_variants pv ON pv.id = s.variant_id
         JOIN products p          ON p.id  = pv.product_id
         JOIN warehouses w        ON w.id  = s.warehouse_id
         LEFT JOIN colors c       ON c.id  = pv.color_id
         LEFT JOIN sizes sz       ON sz.id = pv.size_id
        WHERE p.is_active = TRUE AND p.deleted_at IS NULL
          AND pv.is_active = TRUE AND pv.deleted_at IS NULL
          AND s.reorder_point > 0
          AND s.quantity_on_hand > 0
          AND s.quantity_on_hand <= s.reorder_point
          ${topLowStockBranchClause}
        ORDER BY (s.reorder_point - s.quantity_on_hand) DESC NULLS LAST,
                 s.quantity_on_hand ASC
        LIMIT 10`,
      dashParams,
    );

    // ── PR-FIX-INVENTORY-API-PRODUCT-GROUPS ────────────────────────
    // Top 5 active groups by current stock value. The JOIN through
    // `product_group_variants` would multiply rows if grouped at the
    // wrong level — GROUP BY g.id ensures one row per group.
    // When a branch is selected we restrict the stock join itself to
    // that branch's warehouses — variants only in other branches drop
    // out, and the SUM(quantity_on_hand) reflects only the chosen
    // branch's stock.
    const stockJoinBranchClause = scopeClause('s.warehouse_id');
    const topGroupsByStockValue = await this.ds.query(
      `SELECT g.id::text         AS group_id,
              g.name_ar, g.name_en, g.color,
              COALESCE(SUM(s.quantity_on_hand), 0)::int AS stock_qty,
              COALESCE(SUM(s.quantity_on_hand
                           * COALESCE(NULLIF(s.avg_cost, 0), pv.cost_price, 0)
                          )::numeric(18,2), 0) AS stock_value
         FROM product_groups g
         JOIN product_group_variants pgv ON pgv.group_id   = g.id
         JOIN product_variants pv        ON pv.id          = pgv.variant_id
         LEFT JOIN stock s               ON s.variant_id   = pv.id
                                        ${stockJoinBranchClause}
        WHERE g.is_active = TRUE
        GROUP BY g.id, g.name_ar, g.name_en, g.color
       HAVING COALESCE(SUM(s.quantity_on_hand), 0) > 0
        ORDER BY stock_value DESC NULLS LAST,
                 stock_qty DESC NULLS LAST,
                 g.name_ar ASC
        LIMIT 5`,
      dashParams,
    );

    // PR-FIX-INVENTORY-API-PRODUCT-GROUPS — top 5 active groups by
    // 30-day sales revenue. Voided invoices and return-style
    // invoices (is_return=TRUE) are excluded so the metric matches
    // the existing dashboard sales numbers.
    // Sales-by-branch: scope by invoices.warehouse_id → branch
    // mapping. The `inv.warehouse_id` column already exists on the
    // invoices table (index `idx_invoices_warehouse`).
    const invoicesBranchClause = scopeClause('inv.warehouse_id');
    const topGroupsBySales30d = await this.ds.query(
      `SELECT g.id::text         AS group_id,
              g.name_ar, g.color,
              COALESCE(SUM(ii.line_total), 0)::numeric(18,2) AS revenue_30d,
              COALESCE(SUM(ii.quantity), 0)::int             AS qty_30d
         FROM product_groups g
         JOIN product_group_variants pgv ON pgv.group_id   = g.id
         JOIN invoice_items ii           ON ii.variant_id  = pgv.variant_id
         JOIN invoices inv               ON inv.id         = ii.invoice_id
        WHERE g.is_active        = TRUE
          AND inv.voided_at      IS NULL
          AND inv.is_return      = FALSE
          AND inv.created_at    >= NOW() - INTERVAL '30 days'
          ${invoicesBranchClause}
        GROUP BY g.id, g.name_ar, g.color
        ORDER BY revenue_30d DESC NULLS LAST,
                 qty_30d DESC NULLS LAST,
                 g.name_ar ASC
        LIMIT 5`,
      dashParams,
    );

    // ── 10 most recent movements (any direction, any type) ─────────
    const recentMovementsScope = scopeClause('sm.warehouse_id');
    const recentMovementsWhere = recentMovementsScope
      ? `WHERE ${recentMovementsScope.replace(/^AND\s+/, '')}`
      : '';
    const recentMovements = await this.ds.query(
      `SELECT sm.id::text   AS id,
              sm.created_at,
              sm.movement_type::text AS movement_type,
              sm.direction::text     AS direction,
              sm.quantity,
              pv.id          AS variant_id,
              p.name_ar      AS product_name,
              pv.sku,
              w.name_ar      AS warehouse_name,
              sm.source_module,
              sm.source_action
         FROM stock_movements sm
         JOIN product_variants pv ON pv.id = sm.variant_id
         JOIN products p          ON p.id  = pv.product_id
         JOIN warehouses w        ON w.id  = sm.warehouse_id
        ${recentMovementsWhere}
        ORDER BY sm.created_at DESC, sm.id DESC
        LIMIT 10`,
      dashParams,
    );

    return {
      totals: {
        total_products: Number(totalsRow?.total_products ?? 0),
        total_variants: Number(totalsRow?.total_variants ?? 0),
        total_stock_qty: Number(totalsRow?.total_stock_qty ?? 0),
        total_available_qty: Number(totalsRow?.total_available_qty ?? 0),
        total_stock_cost_value: Number(totalsRow?.total_stock_cost_value ?? 0),
        total_stock_sale_value: Number(totalsRow?.total_stock_sale_value ?? 0),
        low_stock_count: Number(totalsRow?.low_stock_count ?? 0),
        out_of_stock_count: Number(totalsRow?.out_of_stock_count ?? 0),
        warehouses_count: Number(totalsRow?.warehouses_count ?? 0),
        movements_today_count: Number(totalsRow?.movements_today_count ?? 0),
        low_stock_groups_count: Number(totalsRow?.low_stock_groups_count ?? 0),
      },
      top_low_stock: topLowStock.map((r: any) => ({
        ...r,
        quantity_on_hand: Number(r.quantity_on_hand),
        reorder_point: Number(r.reorder_point),
      })),
      recent_movements: recentMovements.map((r: any) => ({
        ...r,
        quantity: Number(r.quantity),
      })),
      top_groups_by_stock_value: topGroupsByStockValue.map((r: any) => ({
        group_id: r.group_id,
        name_ar: r.name_ar,
        name_en: r.name_en ?? null,
        color: r.color ?? null,
        stock_qty: Number(r.stock_qty ?? 0),
        stock_value: Number(r.stock_value ?? 0),
      })),
      top_groups_by_sales_30d: topGroupsBySales30d.map((r: any) => ({
        group_id: r.group_id,
        name_ar: r.name_ar,
        color: r.color ?? null,
        revenue_30d: Number(r.revenue_30d ?? 0),
        qty_30d: Number(r.qty_30d ?? 0),
      })),
    };
  }

  // ============================================================================
  // GET /inventory/balances
  // ============================================================================
  /**
   * Paginated per-(variant × warehouse) balances. Joins enough
   * catalog metadata for the UI to render a product/color/size cell
   * without a second round-trip per row.
   *
   * TODO(tenant): add `AND p.tenant_id = :tenant` when the column
   * lands on `products`.
   */
  async getBalances(filters: InventoryBalancesFilters) {
    const page = Math.max(1, Number(filters.page ?? 1));
    const limit = Math.min(200, Math.max(1, Number(filters.limit ?? 50)));
    const offset = (page - 1) * limit;

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
    // PR-BRANCHES-INVENTORY-FILTERS — EXISTS sub-query against
    // warehouse_branches scopes stock rows to warehouses linked to
    // the given branch. Combined with `warehouse_id` (above), both
    // apply — i.e. "this warehouse AND it must belong to the branch".
    if (filters.branch_id) {
      params.push(filters.branch_id);
      conds.push(this.branchWarehouseExists('s.warehouse_id', params.length));
    }
    // PR-USER-BRANCH-WAREHOUSE-ACCESS — intersect with the user's
    // allowed warehouse set. `undefined` = no restriction. An empty
    // array yields zero rows (intentional: user has explicit rows
    // but none match).
    if (filters.warehouse_ids !== undefined) {
      if (filters.warehouse_ids.length === 0) {
        conds.push(`FALSE`);
      } else {
        params.push(filters.warehouse_ids);
        conds.push(`s.warehouse_id = ANY($${params.length}::uuid[])`);
      }
    }
    if (filters.category_id) {
      params.push(filters.category_id);
      conds.push(`p.category_id = $${params.length}::uuid`);
    }
    if (filters.brand_id) {
      params.push(filters.brand_id);
      conds.push(`p.brand_id = $${params.length}::uuid`);
    }
    if (filters.color_id) {
      params.push(filters.color_id);
      conds.push(`pv.color_id = $${params.length}::uuid`);
    }
    if (filters.size_id) {
      params.push(filters.size_id);
      conds.push(`pv.size_id = $${params.length}::uuid`);
    }
    // PR-FIX-INVENTORY-API-PRODUCT-GROUPS — group_id filter uses
    // EXISTS so a variant in multiple groups still produces ONE
    // balance row per warehouse (no row multiplication).
    if (filters.group_id) {
      params.push(filters.group_id);
      conds.push(
        `EXISTS (
           SELECT 1 FROM product_group_variants pgv
            WHERE pgv.variant_id = pv.id
              AND pgv.group_id   = $${params.length}::uuid
         )`,
      );
    }
    if (filters.low_stock) {
      conds.push(
        `s.reorder_point > 0 AND s.quantity_on_hand > 0 AND s.quantity_on_hand <= s.reorder_point`,
      );
    }
    if (filters.out_of_stock) {
      conds.push(`s.quantity_on_hand <= 0`);
    }
    if (filters.search && filters.search.trim()) {
      const term = `%${filters.search.trim()}%`;
      params.push(term);
      conds.push(
        `(p.name_ar ILIKE $${params.length} OR p.name_en ILIKE $${params.length} OR pv.sku ILIKE $${params.length} OR pv.barcode::text ILIKE $${params.length})`,
      );
    }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    // ── Total row count for pagination ─────────────────────────────
    const [{ total }] = await this.ds.query(
      `SELECT COUNT(*)::int AS total
         FROM stock s
         JOIN product_variants pv ON pv.id = s.variant_id
         JOIN products p          ON p.id  = pv.product_id
        ${where}`,
      params,
    );

    params.push(limit);
    params.push(offset);
    const limitIdx = params.length - 1;
    const offsetIdx = params.length;

    // PR-FIX-INVENTORY-API-PRODUCT-GROUPS — LATERAL aggregation
    // returns ONE row per variant×warehouse with the variant's
    // groups packed into parallel arrays. Using LATERAL instead of
    // a plain LEFT JOIN avoids row multiplication when a variant
    // belongs to multiple groups. The arrays default to `'{}'` (an
    // empty PG array) so the response shape stays stable when the
    // variant isn't in any group.
    const items = await this.ds.query(
      `SELECT p.id              AS product_id,
              p.name_ar         AS product_name,
              p.sku_prefix,
              pv.id             AS variant_id,
              pv.sku,
              pv.barcode::text  AS barcode,
              pv.cost_price,
              pv.selling_price,
              pv.color_id,
              c.name_ar         AS color_name,
              pv.size_id,
              sz.size_label,
              w.id              AS warehouse_id,
              w.name_ar         AS warehouse_name,
              s.quantity_on_hand,
              s.quantity_reserved,
              (s.quantity_on_hand - s.quantity_reserved)::int AS available_quantity,
              s.reorder_point,
              s.avg_cost,
              (s.quantity_on_hand
               * COALESCE(NULLIF(s.avg_cost, 0), pv.cost_price, 0))::numeric(18,2) AS stock_cost_value,
              (s.quantity_on_hand * pv.selling_price)::numeric(18,2) AS stock_sale_value,
              (SELECT MAX(sm.created_at)
                 FROM stock_movements sm
                WHERE sm.variant_id = pv.id
                  AND sm.warehouse_id = s.warehouse_id) AS last_movement_at,
              COALESCE(g.group_ids,       '{}'::text[]) AS group_ids,
              COALESCE(g.group_names_ar,  '{}'::text[]) AS group_names_ar,
              COALESCE(g.group_names_en,  '{}'::text[]) AS group_names_en,
              COALESCE(g.group_colors,    '{}'::text[]) AS group_colors
         FROM stock s
         JOIN product_variants pv ON pv.id = s.variant_id
         JOIN products p          ON p.id  = pv.product_id
         JOIN warehouses w        ON w.id  = s.warehouse_id
         LEFT JOIN colors c       ON c.id  = pv.color_id
         LEFT JOIN sizes sz       ON sz.id = pv.size_id
         LEFT JOIN LATERAL (
           SELECT array_agg(pg.id::text ORDER BY pg.name_ar) AS group_ids,
                  array_agg(pg.name_ar  ORDER BY pg.name_ar) AS group_names_ar,
                  array_agg(pg.name_en  ORDER BY pg.name_ar) AS group_names_en,
                  array_agg(pg.color    ORDER BY pg.name_ar) AS group_colors
             FROM product_group_variants pgv
             JOIN product_groups pg ON pg.id = pgv.group_id
            WHERE pgv.variant_id = pv.id
              AND pg.is_active   = TRUE
         ) g ON TRUE
        ${where}
        ORDER BY p.name_ar ASC, sz.sort_order ASC NULLS LAST, sz.size_label ASC NULLS LAST
        LIMIT $${limitIdx}::int OFFSET $${offsetIdx}::int`,
      params,
    );

    return {
      items,
      total: Number(total),
      page,
      limit,
    };
  }

  // ============================================================================
  // GET /inventory/movements
  // ============================================================================
  /**
   * Paginated ledger of stock movements with full product / variant /
   * warehouse / user context. Read-only — `stock_movements` is
   * append-only by design.
   *
   * TODO(tenant): join through products → tenant_id filter once
   * the column lands.
   */
  async getMovements(filters: InventoryMovementsFilters) {
    const page = Math.max(1, Number(filters.page ?? 1));
    const limit = Math.min(500, Math.max(1, Number(filters.limit ?? 50)));
    const offset = (page - 1) * limit;

    const conds: string[] = [];
    const params: any[] = [];

    if (filters.variant_id) {
      params.push(filters.variant_id);
      conds.push(`sm.variant_id = $${params.length}::uuid`);
    }
    if (filters.product_id) {
      params.push(filters.product_id);
      conds.push(`pv.product_id = $${params.length}::uuid`);
    }
    if (filters.warehouse_id) {
      params.push(filters.warehouse_id);
      conds.push(`sm.warehouse_id = $${params.length}::uuid`);
    }
    // PR-BRANCHES-INVENTORY-FILTERS — scope movements to warehouses
    // linked to the given branch.
    if (filters.branch_id) {
      params.push(filters.branch_id);
      conds.push(
        this.branchWarehouseExists('sm.warehouse_id', params.length),
      );
    }
    // PR-USER-BRANCH-WAREHOUSE-ACCESS — intersect with the user's
    // allowed warehouse set (see InventoryBalancesFilters above).
    if (filters.warehouse_ids !== undefined) {
      if (filters.warehouse_ids.length === 0) {
        conds.push(`FALSE`);
      } else {
        params.push(filters.warehouse_ids);
        conds.push(`sm.warehouse_id = ANY($${params.length}::uuid[])`);
      }
    }
    if (filters.movement_type) {
      params.push(filters.movement_type);
      conds.push(`sm.movement_type::text = $${params.length}`);
    }
    if (filters.direction) {
      params.push(filters.direction);
      conds.push(`sm.direction::text = $${params.length}`);
    }
    if (filters.reference_type) {
      params.push(filters.reference_type);
      conds.push(`sm.reference_type::text = $${params.length}`);
    }
    // PR-FIX-INVENTORY-API-PRODUCT-GROUPS — EXISTS sub-query (no
    // row multiplication when the variant belongs to multiple
    // groups).
    if (filters.group_id) {
      params.push(filters.group_id);
      conds.push(
        `EXISTS (
           SELECT 1 FROM product_group_variants pgv
            WHERE pgv.variant_id = sm.variant_id
              AND pgv.group_id   = $${params.length}::uuid
         )`,
      );
    }
    if (filters.date_from) {
      params.push(filters.date_from);
      conds.push(`sm.created_at >= $${params.length}::timestamptz`);
    }
    if (filters.date_to) {
      params.push(filters.date_to);
      conds.push(`sm.created_at < ($${params.length}::date + INTERVAL '1 day')`);
    }
    if (filters.search && filters.search.trim()) {
      const term = `%${filters.search.trim()}%`;
      params.push(term);
      conds.push(
        `(p.name_ar ILIKE $${params.length} OR pv.sku ILIKE $${params.length} OR pv.barcode::text ILIKE $${params.length} OR COALESCE(sm.notes, '') ILIKE $${params.length})`,
      );
    }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const [{ total }] = await this.ds.query(
      `SELECT COUNT(*)::int AS total
         FROM stock_movements sm
         JOIN product_variants pv ON pv.id = sm.variant_id
         JOIN products p          ON p.id  = pv.product_id
        ${where}`,
      params,
    );

    params.push(limit);
    params.push(offset);
    const limitIdx = params.length - 1;
    const offsetIdx = params.length;

    const items = await this.ds.query(
      `SELECT sm.id::text          AS id,
              sm.created_at,
              sm.movement_type::text AS movement_type,
              sm.direction::text     AS direction,
              sm.quantity,
              sm.unit_cost,
              sm.reference_type::text AS reference_type,
              sm.reference_id::text   AS reference_id,
              sm.source_module,
              sm.source_action,
              sm.balance_after_qty,
              sm.notes,
              pv.id                  AS variant_id,
              pv.sku,
              pv.barcode::text       AS barcode,
              p.id                   AS product_id,
              p.name_ar              AS product_name,
              p.sku_prefix,
              w.id                   AS warehouse_id,
              w.name_ar              AS warehouse_name,
              sm.user_id,
              u.full_name            AS user_name,
              u.username             AS user_username
         FROM stock_movements sm
         JOIN product_variants pv ON pv.id = sm.variant_id
         JOIN products p          ON p.id  = pv.product_id
         JOIN warehouses w        ON w.id  = sm.warehouse_id
         LEFT JOIN users u        ON u.id  = sm.user_id
        ${where}
        ORDER BY sm.created_at DESC, sm.id DESC
        LIMIT $${limitIdx}::int OFFSET $${offsetIdx}::int`,
      params,
    );

    return {
      items,
      total: Number(total),
      page,
      limit,
    };
  }
}
