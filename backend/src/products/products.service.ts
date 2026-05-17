import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, ILike, Repository } from 'typeorm';
import { ProductEntity } from './entities/product.entity';
import { VariantEntity } from './entities/variant.entity';
import {
  ApplyVariantPricesDto,
  CreateProductDto,
  UpdateProductDto,
  CreateVariantDto,
  UpdateVariantDto,
  ManualAdjustmentDto,
  SmartPricingApplyDto,
  SmartPricingPreviewDto,
  SmartPricingScopeDto,
  SmartPricingStrategy,
} from './dto/product.dto';

// ── PR-PURCHASES-P3.5A — Smart Bulk Pricing Assistant ──
export type SmartPricingRecommendation =
  | 'increase'
  | 'decrease'
  | 'keep'
  | 'review';
export type SmartPricingWarning =
  | 'below_cost_at_current'
  | 'below_cost_after_change'
  | 'below_min_margin_after_change'
  | 'large_increase'
  | 'large_decrease'
  | 'missing_cost'
  | 'no_stock'
  | 'no_stock_alt'
  | 'slow_moving'
  | 'high_stock';

export interface SmartPricingThresholds {
  competitive_markup_pct: number;
  recommended_margin_pct: number;
  high_margin_pct: number;
  wholesale_markup_pct: number;
  min_margin_pct_default: number;
  rounding_step: 1 | 5 | 10 | 25 | 50;
  rounding_mode: 'nearest' | 'floor' | 'ceil';
}

export interface SmartPricingItem {
  variant_id: string;
  product_id: string;
  product_name: string;
  sku: string;
  barcode: string | null;
  color: string | null;
  size: string | null;
  current_cost: number;
  current_price: number;
  stock_qty: number;
  qty_sold: number;
  invoice_count: number;
  last_sold_at: string | null;
  current_margin_pct: number | null;
  current_markup_pct: number | null;
  min_margin_pct: number;
  recommendation: SmartPricingRecommendation;
  suggested_selling_price: number | null;
  expected_profit_delta_per_unit: number | null;
  final_margin_pct?: number | null;
  final_markup_pct?: number | null;
  reason_ar: string;
  warnings: SmartPricingWarning[];
  skipped_reason: string | null;
}

const round2 = (n: number) =>
  Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;

function applyRounding(
  price: number,
  step: number,
  mode: 'nearest' | 'floor' | 'ceil',
): number {
  if (!(step > 0)) return round2(price);
  const r = price / step;
  const snapped =
    mode === 'floor'
      ? Math.floor(r) * step
      : mode === 'ceil'
        ? Math.ceil(r) * step
        : Math.round(r) * step;
  return round2(snapped);
}

export interface ProductFilters {
  type?: 'shoe' | 'bag' | 'accessory';
  q?: string;
  active?: boolean;
  page?: number;
  limit?: number;
  warehouse_id?: string;
  category_id?: string;
}

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(ProductEntity)
    private readonly repo: Repository<ProductEntity>,
    @InjectRepository(VariantEntity)
    private readonly variants: Repository<VariantEntity>,
    private readonly ds: DataSource,
  ) {}

  async findAll(filters: ProductFilters = {}) {
    const page = Math.max(1, filters.page || 1);
    // Catalog can easily exceed 200 rows; keep a generous ceiling
    // so the admin Products page can render everything at once.
    const limit = Math.min(5000, filters.limit || 200);
    const where: any = {};
    if (filters.type) where.type = filters.type;
    if (filters.active !== undefined) where.is_active = filters.active;
    const q = filters.q?.trim();
    let queryBuilder = this.repo
      .createQueryBuilder('p')
      .orderBy('p.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);
    if (filters.type) queryBuilder = queryBuilder.andWhere('p.type = :type', { type: filters.type });
    if (filters.active !== undefined)
      queryBuilder = queryBuilder.andWhere('p.is_active = :active', { active: filters.active });
    if (filters.category_id)
      queryBuilder = queryBuilder.andWhere('p.category_id = :cid', { cid: filters.category_id });
    if (q) {
      queryBuilder = queryBuilder.andWhere(
        `(p.name_ar ILIKE :q OR p.sku_root ILIKE :q OR EXISTS (
           SELECT 1 FROM product_variants pv
            WHERE pv.product_id = p.id
              AND (pv.sku ILIKE :q OR pv.barcode ILIKE :q)
         ))`,
        { q: `%${q}%` },
      );
    }
    const [data, total] = await queryBuilder.getManyAndCount();

    // Attach aggregated stock qty + stock value to each product.
    let enriched: any[] = data;
    if (data.length > 0) {
      const ids = data.map((p) => p.id);
      const params: any[] = [ids];
      let sql = `
        SELECT v.product_id,
               SUM(COALESCE(s.quantity_on_hand, s.quantity, 0))::int AS total_stock,
               SUM(
                 COALESCE(s.quantity_on_hand, s.quantity, 0)
                 * COALESCE(
                     NULLIF(s.avg_cost, 0),
                     NULLIF(v.cost_price, 0),
                     NULLIF(v.selling_price, 0),
                     0
                   )
               )::numeric(14,2) AS stock_value,
               COUNT(DISTINCT v.id) FILTER (WHERE v.is_active) AS variants_count
          FROM product_variants v
          LEFT JOIN stock s ON s.variant_id = v.id`;
      if (filters.warehouse_id) {
        sql += ` AND s.warehouse_id = $2`;
        params.push(filters.warehouse_id);
      }
      sql += ` WHERE v.product_id = ANY($1) GROUP BY v.product_id`;
      const stockRows = await this.ds.query(sql, params);
      const stockMap = new Map<
        string,
        { total_stock: number; stock_value: number; variants_count: number }
      >();
      for (const r of stockRows) {
        stockMap.set(r.product_id, {
          total_stock: Number(r.total_stock || 0),
          stock_value: Number(r.stock_value || 0),
          variants_count: Number(r.variants_count || 0),
        });
      }
      // Short variants summary so the UI can search by color / size
      // and highlight which variant a number matched. Limit to 20
      // entries per product — more than enough for the list view.
      const variantsRows = await this.ds.query(
        `SELECT v.product_id, v.sku, v.color, v.size
           FROM product_variants v
          WHERE v.product_id = ANY($1) AND v.is_active = TRUE
          ORDER BY v.product_id, v.id
          LIMIT 5000`,
        [ids],
      );
      const variantsByProduct = new Map<string, any[]>();
      for (const v of variantsRows) {
        const arr = variantsByProduct.get(v.product_id) || [];
        if (arr.length < 20) {
          arr.push({ sku: v.sku, color: v.color, size: v.size });
          variantsByProduct.set(v.product_id, arr);
        }
      }

      enriched = data.map((p) => {
        const s = stockMap.get(p.id);
        return {
          ...p,
          total_stock: s?.total_stock ?? 0,
          stock_value: s?.stock_value ?? 0,
          variants_count: s?.variants_count ?? 0,
          variants_summary: variantsByProduct.get(p.id) || [],
        };
      });
    }

    return {
      data: enriched,
      meta: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string) {
    const product = await this.repo.findOne({ where: { id } });
    if (!product) throw new NotFoundException(`Product ${id} not found`);
    const variants = await this.variants.find({ where: { product_id: id } });
    return { ...product, variants };
  }

  /**
   * Find a single product/variant by any of:
   *   • an exact variant.barcode match
   *   • an exact variant.sku match
   *   • an exact product.sku_root match (pick any active variant)
   * Used by the POS scan-and-enter flow so typing a product code and
   * hitting Enter adds the product immediately without a search list.
   */
  async findByBarcode(code: string, warehouse_id?: string) {
    // 1) Try variant barcode
    let variant = await this.variants.findOne({ where: { barcode: code } });
    // 2) Try variant SKU
    if (!variant) {
      variant = await this.variants.findOne({ where: { sku: code } });
    }
    // 3) Try product sku_root — pick the first active variant.
    if (!variant) {
      const product = await this.repo.findOne({
        where: { sku_root: code },
      });
      if (product) {
        variant = await this.variants.findOne({
          where: { product_id: product.id, is_active: true },
        });
        if (!variant) {
          throw new NotFoundException(
            `لا يوجد متغير نشط للمنتج بالكود ${code}`,
          );
        }
        return this.attachAvailableStock({ product, variant }, warehouse_id);
      }
    }
    if (!variant) {
      throw new NotFoundException(`الكود ${code} غير موجود`);
    }
    const product = await this.repo.findOne({
      where: { id: variant.product_id },
    });
    return this.attachAvailableStock({ product, variant }, warehouse_id);
  }

  /**
   * PR-POS-STOCK-1 — when `warehouse_id` is supplied, look up the
   * `stock` row for (variant, warehouse) and stamp `available_stock`
   * on the response. Missing stock row → `available_stock = 0` (treat
   * as out-of-stock; safer than `undefined`). When no warehouse is
   * provided the method is a no-op so legacy callers see exactly the
   * same shape they did before.
   */
  private async attachAvailableStock(
    payload: { product: any; variant: any },
    warehouse_id?: string,
  ): Promise<{ product: any; variant: any; available_stock?: number }> {
    if (!warehouse_id) return payload;
    const [row] = await this.ds.query(
      `SELECT quantity_on_hand
         FROM stock
        WHERE variant_id = $1
          AND warehouse_id = $2
        LIMIT 1`,
      [payload.variant.id, warehouse_id],
    );
    return {
      ...payload,
      available_stock: Number(row?.quantity_on_hand ?? 0),
    };
  }

  create(dto: CreateProductDto) {
    const product = this.repo.create(dto);
    return this.repo.save(product);
  }

  async update(id: string, dto: UpdateProductDto) {
    await this.repo.update(id, dto);
    return this.findOne(id);
  }

  async remove(id: string) {
    // Refuse to archive a product that has ever been sold or
    // stock-adjusted — keeping historical references intact matters
    // more than tidying the catalog.
    const [sale] = await this.ds.query(
      `SELECT COUNT(*)::int AS n
         FROM invoice_items ii
         JOIN product_variants v ON v.id = ii.variant_id
        WHERE v.product_id = $1`,
      [id],
    );
    if (Number(sale?.n || 0) > 0) {
      throw new BadRequestException(
        'لا يمكن حذف منتج سبق بيعه — أرشفته ستخفيه، بس تاريخه لا يُمحى.',
      );
    }
    const [movements] = await this.ds.query(
      `SELECT COUNT(*)::int AS n
         FROM stock_movements m
         JOIN product_variants v ON v.id = m.variant_id
        WHERE v.product_id = $1
          AND m.movement_type IN ('sale','return','adjustment','count','transfer')`,
      [id],
    );
    if (Number(movements?.n || 0) > 0) {
      throw new BadRequestException(
        'لا يمكن حذف منتج له حركات مخزون (بيع/مرتجع/تسوية/جرد/تحويل).',
      );
    }
    await this.repo.update(id, { is_active: false });
    return { archived: true };
  }

  addVariant(dto: CreateVariantDto) {
    const v = this.variants.create(dto);
    return this.variants.save(v);
  }

  async updateVariant(id: string, dto: UpdateVariantDto) {
    const v = await this.variants.findOne({ where: { id } });
    if (!v) throw new NotFoundException(`Variant ${id} not found`);
    await this.variants.update(id, dto);
    return this.variants.findOne({ where: { id } });
  }

  async removeVariant(id: string) {
    await this.variants.update(id, { is_active: false });
    return { archived: true };
  }

  // ─── PR-PURCHASES-P3.2 — manual apply suggested sale price ──────────
  /**
   * Apply operator-confirmed selling prices to a batch of variants.
   *
   * STRICTLY pricing-only:
   *   · Updates ONLY `product_variants.selling_price`.
   *   · Inserts ONE `variant_price_history` row per changed variant.
   *   · No journal_entries / journal_lines / cashbox_transactions /
   *     stock_movements writes. No call into posting.service /
   *     financial-engine / purchases.service. Stock and accounting
   *     are intentionally untouched — pricing is not a financial
   *     event in this system.
   *
   * Skips (without inserting a history row) when the new price equals
   * the current price within 0.01 EGP. Throws NotFoundException when a
   * variant is missing, which rolls back the whole transaction so the
   * caller sees an all-or-nothing result.
   */
  async applyVariantPrices(dto: ApplyVariantPricesDto, userId?: string) {
    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException('يجب تحديد صنف واحد على الأقل لتطبيق السعر');
    }
    for (const it of dto.items) {
      if (!(Number(it.new_selling_price) > 0)) {
        throw new BadRequestException(
          `سعر البيع يجب أن يكون أكبر من صفر للصنف ${it.variant_id}`,
        );
      }
    }

    // sourcePurchaseNo is captured at apply-time so the history row
    // stays meaningful even if the purchase is later renumbered. The
    // read is OUTSIDE the transaction — purely informational.
    let sourcePurchaseNo: string | null = null;
    if (dto.source_purchase_id) {
      const [row] = await this.ds.query(
        `SELECT purchase_no FROM purchases WHERE id = $1`,
        [dto.source_purchase_id],
      );
      if (row?.purchase_no) sourcePurchaseNo = row.purchase_no;
    }

    return this.ds.transaction(async (em) => {
      const out: Array<{
        variant_id: string;
        old_selling_price: number;
        new_selling_price: number;
        history_id: string | null;
        skipped: boolean;
      }> = [];
      let updated = 0;
      let skipped = 0;
      for (const it of dto.items) {
        const [variant] = await em.query(
          `SELECT id, selling_price FROM product_variants WHERE id = $1`,
          [it.variant_id],
        );
        if (!variant) {
          throw new NotFoundException(`الصنف غير موجود: ${it.variant_id}`);
        }
        const oldPrice = Number(variant.selling_price ?? 0);
        const newPrice = Number(it.new_selling_price);
        if (Math.abs(newPrice - oldPrice) < 0.01) {
          out.push({
            variant_id: it.variant_id,
            old_selling_price: oldPrice,
            new_selling_price: newPrice,
            history_id: null,
            skipped: true,
          });
          skipped += 1;
          continue;
        }
        await em.query(
          `UPDATE product_variants
              SET selling_price = $2,
                  updated_at    = NOW()
            WHERE id = $1`,
          [it.variant_id, newPrice],
        );
        const [hist] = await em.query(
          `INSERT INTO variant_price_history
             (variant_id, old_selling_price, new_selling_price,
              source_purchase_id, source_purchase_no,
              reason, changed_by, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING id`,
          [
            it.variant_id,
            oldPrice,
            newPrice,
            dto.source_purchase_id ?? null,
            sourcePurchaseNo,
            dto.reason ?? null,
            userId ?? null,
            {},
          ],
        );
        out.push({
          variant_id: it.variant_id,
          old_selling_price: oldPrice,
          new_selling_price: newPrice,
          history_id: hist?.id ?? null,
          skipped: false,
        });
        updated += 1;
      }
      return { updated, skipped, items: out };
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  //  PR-PURCHASES-P3.5A — Smart Bulk Pricing Assistant
  //
  //  PRICING-ONLY by design:
  //    · Reads cost_price for recommendation math but NEVER writes it.
  //    · Writes ONLY product_variants.selling_price + variant_price_history.
  //    · Cost adjustment is deferred to P3.5B (needs variant_cost_history
  //      + a separate permission + inventory revaluation policy).
  //    · Never calls posting/cashbox/stock/purchase paths.
  //
  //  The static guardrail spec asserts the SQL trail emitted by these
  //  methods contains zero writes outside of those two allowed targets.
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Internal helper: resolve `scope + strategy` to a list of recommendation
   * rows. Same code path is used by `smartPricingPreview` (which just
   * returns the list) and `smartPricingApply` (which re-runs this then
   * applies). Apply NEVER trusts numbers the client sent.
   */
  private async _smartPricingComputeRecommendations(
    dto: SmartPricingPreviewDto,
  ): Promise<{
    items: SmartPricingItem[];
    settings: SmartPricingThresholds;
    total_candidates: number;
    effective_limit: number;
  }> {
    // HOTFIX P3.5A.1 timeout — sane default and hard cap. The rich-data
    // query (stock_sum + sales_90d 90-day window + colors/sizes joins)
    // can take ~30s for a thousand variants, which trips the 30s axios
    // client timeout. Bound the work here so the request finishes well
    // under the 60s per-endpoint client timeout the frontend sets for
    // smart-pricing calls.
    const SMART_PREVIEW_DEFAULT = 200;
    const SMART_PREVIEW_MAX = 1000;
    const effective_limit = Math.min(
      Math.max(1, Number(dto.limit) || SMART_PREVIEW_DEFAULT),
      SMART_PREVIEW_MAX,
    );

    // ── Load smart_pricing settings (with fallback defaults). One
    //    SELECT against the settings table — no writes.
    const settings = await this._loadSmartPricingThresholds();

    // ── Resolve the variant set for the scope. Returns the (already
    //    sliced) id list AND the total candidate count for truncation
    //    metadata. For selected/single, total === ids.length. For
    //    filtered/all the resolver runs a cheap COUNT(*) before the
    //    slice.
    const { ids: variantIds, total_candidates } = await this._resolveScope(
      dto.scope,
      effective_limit,
    );
    if (variantIds.length === 0) {
      return { items: [], settings, total_candidates, effective_limit };
    }

    // ── Load the rich data block per variant in one query. Joins:
    //    · products (name, min_margin_pct)
    //    · stock (sum quantity_on_hand across warehouses)
    //    · invoice_items + invoices (sales metrics in the last 90d
    //      excluding returns and non-completed invoices)
    //    · colors / sizes (display metadata)
    //
    // HOTFIX (post-fd30cee): use ANY($1::uuid[]) for the variant-id list
    // and $2::numeric for the min-margin fallback. The previous form
    // reused a `$1..$N` placeholder string in three IN clauses while the
    // params array carried `[...variantIds, ...variantIds, default]` —
    // so the second batch (`$N+1..$2N`) was bound but never referenced
    // in SQL, and PostgreSQL aborted with "could not determine data type
    // of parameter $2" for the smallest dangling slot. Explicit casts
    // also let the planner pick the index path on stock.variant_id and
    // invoice_items.variant_id without an implicit coercion step.
    const rows = await this.ds.query(
      `
      WITH stock_sum AS (
        SELECT variant_id, SUM(quantity_on_hand)::int AS qty
          FROM stock
         WHERE variant_id = ANY($1::uuid[])
         GROUP BY variant_id
      ),
      sales_90d AS (
        SELECT
          ii.variant_id,
          SUM(ii.quantity)::int                       AS qty_sold,
          COUNT(DISTINCT ii.invoice_id)::int          AS invoice_count,
          MAX(COALESCE(i.completed_at, i.created_at)) AS last_sold_at
        FROM invoice_items ii
        JOIN invoices i ON i.id = ii.invoice_id
        WHERE ii.variant_id = ANY($1::uuid[])
          AND i.status IN ('completed','paid','partially_paid')
          AND NOT i.is_return
          AND COALESCE(i.completed_at, i.created_at) >= NOW() - INTERVAL '90 days'
        GROUP BY ii.variant_id
      )
      SELECT
        pv.id                                                      AS variant_id,
        pv.sku,
        pv.barcode,
        p.id                                                       AS product_id,
        p.name_ar                                                  AS product_name,
        c.name_ar                                                  AS color,
        sz.size_label                                              AS size,
        pv.cost_price::numeric                                     AS cost_price,
        COALESCE(NULLIF(pv.selling_price, 0), p.base_price)::numeric AS selling_price,
        COALESCE(p.min_margin_pct, $2::numeric)::numeric           AS min_margin_pct,
        COALESCE(stock_sum.qty, 0)                                 AS stock_qty,
        COALESCE(sales_90d.qty_sold, 0)                            AS qty_sold,
        COALESCE(sales_90d.invoice_count, 0)                       AS invoice_count,
        sales_90d.last_sold_at
      FROM product_variants pv
      JOIN products p   ON p.id = pv.product_id
      LEFT JOIN colors c ON c.id = pv.color_id
      LEFT JOIN sizes  sz ON sz.id = pv.size_id
      LEFT JOIN stock_sum ON stock_sum.variant_id = pv.id
      LEFT JOIN sales_90d  ON sales_90d.variant_id = pv.id
      WHERE pv.id = ANY($1::uuid[])
        AND pv.is_active = TRUE
        AND pv.deleted_at IS NULL
      ORDER BY p.name_ar, pv.sku
      `,
      [variantIds, settings.min_margin_pct_default],
    );

    // P3.5A.1: when mode === 'manual' we bypass the strategy engine and
    // apply the operator-supplied formula to every row. The "smart" path
    // is unchanged.
    const isManual = dto.mode === 'manual';
    if (isManual && !dto.manual_adjustment) {
      throw new BadRequestException(
        'manual_adjustment مطلوب لتعديل يدوي',
      );
    }

    const items: SmartPricingItem[] = rows.map((r: any) =>
      isManual
        ? this._recommendForVariantManual(r, dto.manual_adjustment!, settings)
        : this._recommendForVariant(r, dto.strategy, settings),
    );

    return { items, settings, total_candidates, effective_limit };
  }

  /**
   * Resolves the scope DTO to a concrete `variant_ids[]` slice AND the
   * total candidate count (used for truncation metadata in preview).
   * Read-only.
   *
   * For `selected` / `single`, total === the (pre-slice) caller-supplied
   * list length. For `filtered` / `all`, a cheap COUNT(*) runs alongside
   * the sliced fetch so the UI can warn the operator that some rows
   * weren't included in the preview.
   */
  private async _resolveScope(
    scope: SmartPricingScopeDto,
    limit: number,
  ): Promise<{ ids: string[]; total_candidates: number }> {
    if (scope.type === 'selected' || scope.type === 'single') {
      const ids = (scope.variant_ids ?? []).filter(Boolean);
      if (ids.length === 0) {
        throw new BadRequestException(
          'يجب تحديد صنف واحد على الأقل لهذا النطاق',
        );
      }
      if (scope.type === 'single' && ids.length > 1) {
        throw new BadRequestException(
          'النطاق "صنف واحد" يقبل صنفًا واحدًا فقط',
        );
      }
      return { ids: ids.slice(0, limit), total_candidates: ids.length };
    }

    if (scope.type === 'filtered') {
      const f = scope.filters ?? {};
      const params: any[] = [];
      const conds: string[] = ['pv.is_active = TRUE', 'pv.deleted_at IS NULL'];
      // HOTFIX (post-fd30cee): every optional placeholder carries an
      // explicit type cast so PostgreSQL can resolve the bind type even
      // when neighbouring placeholders dangle or get added in different
      // orders by future filters.
      if (f.q) {
        params.push(`%${f.q.trim()}%`);
        conds.push(
          `(p.name_ar ILIKE $${params.length}::text OR pv.sku ILIKE $${params.length}::text OR pv.barcode ILIKE $${params.length}::text)`,
        );
      }
      const supplierJoin = f.supplier_id ? 'JOIN purchase_items pi_s ON pi_s.variant_id = pv.id JOIN purchases pu_s ON pu_s.id = pi_s.purchase_id' : '';
      if (f.supplier_id) {
        params.push(f.supplier_id);
        conds.push(`pu_s.supplier_id = $${params.length}::uuid`);
      }
      const stockJoin = f.only_in_stock
        ? 'JOIN stock st ON st.variant_id = pv.id'
        : '';
      if (f.only_in_stock) {
        conds.push(`st.quantity_on_hand > 0`);
      }
      const fromClause = `FROM product_variants pv
          JOIN products p ON p.id = pv.product_id
          ${supplierJoin}
          ${stockJoin}
         WHERE ${conds.join(' AND ')}`;
      // HOTFIX timeout — cheap COUNT(*) so the UI can warn when the
      // preview is truncated. Read-only.
      const [countRow] = await this.ds.query(
        `SELECT COUNT(DISTINCT pv.id)::int AS n ${fromClause}`,
        params,
      );
      const total_candidates = Number(countRow?.n ?? 0);
      const rows = await this.ds.query(
        `SELECT DISTINCT pv.id AS variant_id
           ${fromClause}
         ORDER BY pv.id
         LIMIT ${limit}`,
        params,
      );
      const ids = rows.map((r: any) => r.variant_id as string);
      return { ids, total_candidates };
    }

    // scope.type === 'all'
    const [countRow] = await this.ds.query(
      `SELECT COUNT(*)::int AS n
         FROM product_variants pv
        WHERE pv.is_active = TRUE
          AND pv.deleted_at IS NULL`,
    );
    const total_candidates = Number(countRow?.n ?? 0);
    const rows = await this.ds.query(
      `
      SELECT pv.id AS variant_id
        FROM product_variants pv
       WHERE pv.is_active = TRUE
         AND pv.deleted_at IS NULL
       ORDER BY pv.id
       LIMIT ${limit}
      `,
    );
    return {
      ids: rows.map((r: any) => r.variant_id as string),
      total_candidates,
    };
  }

  /** Reads the 9 smart_pricing settings (with built-in fallbacks). */
  private async _loadSmartPricingThresholds(): Promise<SmartPricingThresholds> {
    const fallbacks: SmartPricingThresholds = {
      competitive_markup_pct: 15,
      recommended_margin_pct: 30,
      high_margin_pct: 40,
      wholesale_markup_pct: 10,
      min_margin_pct_default: 15,
      rounding_step: 5,
      rounding_mode: 'nearest',
    };
    const rows = await this.ds.query(
      `SELECT key, value FROM settings WHERE group_name = $1`,
      ['smart_pricing'],
    );
    const out: SmartPricingThresholds = { ...fallbacks };
    for (const row of rows) {
      const tail = String(row.key || '').replace(/^smart_pricing\./, '');
      if (tail in out) {
        (out as any)[tail] = row.value;
      }
    }
    return out;
  }

  /** Per-variant recommendation engine. Pure-ish: no I/O, no writes. */
  private _recommendForVariant(
    row: any,
    strategy: SmartPricingStrategy,
    settings: SmartPricingThresholds,
  ): SmartPricingItem {
    const cost = Number(row.cost_price || 0);
    const currentPrice = Number(row.selling_price || 0);
    const minMargin = Number(row.min_margin_pct || settings.min_margin_pct_default);
    const stockQty = Number(row.stock_qty || 0);
    const qtySold = Number(row.qty_sold || 0);
    const invoiceCount = Number(row.invoice_count || 0);

    const currentMarginPct =
      currentPrice > 0
        ? round2((currentPrice - cost) / currentPrice * 100)
        : null;
    const currentMarkupPct =
      cost > 0 ? round2((currentPrice - cost) / cost * 100) : null;

    const base = {
      variant_id: row.variant_id,
      product_id: row.product_id,
      product_name: row.product_name,
      sku: row.sku,
      barcode: row.barcode,
      color: row.color,
      size: row.size,
      current_cost: round2(cost),
      current_price: round2(currentPrice),
      stock_qty: stockQty,
      qty_sold: qtySold,
      invoice_count: invoiceCount,
      last_sold_at: row.last_sold_at,
      current_margin_pct: currentMarginPct,
      current_markup_pct: currentMarkupPct,
      min_margin_pct: minMargin,
    } as const;

    // ── Rule 1: missing cost or price → REVIEW
    if (!(cost > 0) || !(currentPrice > 0)) {
      return {
        ...base,
        recommendation: 'review',
        suggested_selling_price: null,
        expected_profit_delta_per_unit: null,
        reason_ar:
          'التكلفة أو سعر البيع غير مكتمل ويحتاج مراجعة يدوية.',
        warnings: !(cost > 0) ? ['missing_cost'] : [],
        skipped_reason: 'cost_or_price_missing',
      };
    }

    // Strategy → target margin used for "lift up" cases.
    const liftTargetMargin =
      strategy === 'conservative'
        ? minMargin
        : strategy === 'aggressive'
          ? settings.high_margin_pct
          : settings.recommended_margin_pct;

    // Strategy → step % used for "trim down" cases.
    const trimPct =
      strategy === 'conservative'
        ? 5
        : strategy === 'balanced'
          ? 10
          : strategy === 'clearance'
            ? 15
            : 10; // aggressive uses balanced trim by default

    // ── Rule 2: selling < cost → INCREASE up to target margin
    if (currentPrice < cost) {
      const rawTarget = this._priceForMargin(cost, liftTargetMargin, minMargin);
      const suggested = applyRounding(rawTarget, settings.rounding_step, settings.rounding_mode);
      return this._finalize(base, 'increase', suggested, settings, minMargin, [
        'below_cost_at_current',
      ], 'السعر الحالي أقل من التكلفة — رفع السعر مطلوب.');
    }

    // ── Rule 3: margin below min_margin → INCREASE
    if (currentMarginPct !== null && currentMarginPct < minMargin) {
      const rawTarget = this._priceForMargin(cost, liftTargetMargin, minMargin);
      const suggested = applyRounding(rawTarget, settings.rounding_step, settings.rounding_mode);
      // Only recommend increase if the suggested price would actually
      // improve over current (rounding could leave us flat).
      if (Math.abs(suggested - currentPrice) < 0.01) {
        return this._finalize(base, 'keep', currentPrice, settings, minMargin, [], 'هامش الربح قريب من الحد الأدنى — لا تغيير بعد التقريب.');
      }
      return this._finalize(base, 'increase', suggested, settings, minMargin, [], 'هامش الربح أقل من الحد الأدنى — رفع السعر مطلوب.');
    }

    // ── Rule 4: high stock + slow movement → DECREASE
    const isHighStock = stockQty > 20;
    const isSlowMoving = invoiceCount < 3;
    const marginHeadroom =
      currentMarginPct !== null
        ? currentMarginPct - minMargin
        : 0;
    if (isHighStock && isSlowMoving && marginHeadroom > 5) {
      const trimmedRaw = currentPrice * (1 - trimPct / 100);
      // Floor at min_margin so the discount never breaks the policy.
      const flooredRaw = Math.max(trimmedRaw, this._priceForMargin(cost, minMargin, minMargin));
      const suggested = applyRounding(flooredRaw, settings.rounding_step, settings.rounding_mode);
      if (Math.abs(suggested - currentPrice) < 0.01) {
        return this._finalize(base, 'keep', currentPrice, settings, minMargin, ['high_stock', 'slow_moving'], 'مخزون مرتفع وبيع بطيء، لكن السعر بعد التقريب لم يتغير.');
      }
      const warnings: SmartPricingWarning[] = ['high_stock', 'slow_moving'];
      const change = Math.abs(suggested - currentPrice) / currentPrice;
      if (change > 0.20) warnings.push('large_decrease');
      return this._finalize(base, 'decrease', suggested, settings, minMargin, warnings, 'المخزون مرتفع وحركة البيع ضعيفة — يُقترح خفض السعر.');
    }

    // ── Rule 5: low stock or strong seller → KEEP or small INCREASE
    const isStrongSeller = invoiceCount >= 5;
    const isLowStock = stockQty < 5;
    if ((isStrongSeller || isLowStock) && currentMarginPct !== null) {
      // Only suggest an increase if margin is still below the
      // recommended threshold for balanced/aggressive.
      if (
        strategy !== 'conservative'
        && currentMarginPct < settings.recommended_margin_pct
      ) {
        const bumpPct = strategy === 'aggressive' ? 5 : 3;
        const rawTarget = currentPrice * (1 + bumpPct / 100);
        const suggested = applyRounding(rawTarget, settings.rounding_step, settings.rounding_mode);
        if (Math.abs(suggested - currentPrice) < 0.01) {
          return this._finalize(base, 'keep', currentPrice, settings, minMargin, isLowStock ? ['no_stock_alt'] : [], 'منتج سريع الحركة — لا تغيير بعد التقريب.');
        }
        return this._finalize(base, 'increase', suggested, settings, minMargin, isLowStock ? ['no_stock_alt'] : [], isStrongSeller ? 'منتج سريع الحركة وهامش الربح يحتمل زيادة بسيطة.' : 'مخزون منخفض ومجال لرفع بسيط.');
      }
      return this._finalize(base, 'keep', currentPrice, settings, minMargin, [], 'منتج سريع الحركة أو مخزون منخفض — الإبقاء على السعر الحالي مناسب.');
    }

    // ── Rule 6: otherwise KEEP
    return this._finalize(base, 'keep', currentPrice, settings, minMargin, [], 'السعر الحالي مناسب.');
  }

  /**
   * P3.5A.1 — Manual recommender. Same `SmartPricingItem` shape as the
   * smart path, but the suggested price comes from the operator's
   * flat formula (percent / amount / fixed price), not from the
   * strategy engine. Pure compute, no I/O.
   *
   * Recommendation rules:
   *   · cost or current_price missing → review (no suggested price)
   *   · resulting price <= 0.01 → review (skipped on apply)
   *   · resulting price == current within 0.01 EGP → keep
   *   · resulting price > current → increase
   *   · resulting price < current → decrease
   * Warnings are emitted by `_finalize` (e.g. below_cost_after_change,
   * below_min_margin_after_change, large_increase/decrease).
   */
  private _recommendForVariantManual(
    row: any,
    adj: ManualAdjustmentDto,
    settings: SmartPricingThresholds,
  ): SmartPricingItem {
    const cost = Number(row.cost_price || 0);
    const currentPrice = Number(row.selling_price || 0);
    const minMargin = Number(row.min_margin_pct || settings.min_margin_pct_default);
    const stockQty = Number(row.stock_qty || 0);
    const qtySold = Number(row.qty_sold || 0);
    const invoiceCount = Number(row.invoice_count || 0);

    const currentMarginPct =
      currentPrice > 0
        ? round2((currentPrice - cost) / currentPrice * 100)
        : null;
    const currentMarkupPct =
      cost > 0 ? round2((currentPrice - cost) / cost * 100) : null;

    const base = {
      variant_id: row.variant_id,
      product_id: row.product_id,
      product_name: row.product_name,
      sku: row.sku,
      barcode: row.barcode,
      color: row.color,
      size: row.size,
      current_cost: round2(cost),
      current_price: round2(currentPrice),
      stock_qty: stockQty,
      qty_sold: qtySold,
      invoice_count: invoiceCount,
      last_sold_at: row.last_sold_at,
      current_margin_pct: currentMarginPct,
      current_markup_pct: currentMarkupPct,
      min_margin_pct: minMargin,
    } as const;

    // Missing current price → can't apply a relative change. Set-price
    // is still allowed even when current price is missing.
    const op = adj.operation;
    const value = Number(adj.value);
    if (op !== 'set_price' && !(currentPrice > 0)) {
      return {
        ...base,
        recommendation: 'review',
        suggested_selling_price: null,
        expected_profit_delta_per_unit: null,
        reason_ar: 'لا يوجد سعر بيع حالي — لا يمكن تطبيق تعديل نسبي أو بقيمة.',
        warnings: !(cost > 0) ? ['missing_cost'] : [],
        skipped_reason: 'cost_or_price_missing',
      };
    }

    let raw = 0;
    let reason_ar = '';
    switch (op) {
      case 'increase_percent':
        raw = currentPrice * (1 + value / 100);
        reason_ar = `زيادة يدوية بنسبة ${value}%`;
        break;
      case 'decrease_percent':
        raw = currentPrice * (1 - value / 100);
        reason_ar = `تخفيض يدوي بنسبة ${value}%`;
        break;
      case 'increase_amount':
        raw = currentPrice + value;
        reason_ar = `زيادة يدوية بقيمة ${value} ج.م`;
        break;
      case 'decrease_amount':
        raw = currentPrice - value;
        reason_ar = `تخفيض يدوي بقيمة ${value} ج.م`;
        break;
      case 'set_price':
        raw = value;
        reason_ar = `تعيين سعر بيع ثابت ${value} ج.م`;
        break;
      default:
        return {
          ...base,
          recommendation: 'review',
          suggested_selling_price: null,
          expected_profit_delta_per_unit: null,
          reason_ar: 'نوع تعديل غير معروف.',
          warnings: [],
          skipped_reason: 'invalid_manual_operation',
        };
    }

    const suggested = round2(raw);

    // Resulting price must be > 0.01. Anything else → review.
    if (!(suggested >= 0.01)) {
      return {
        ...base,
        recommendation: 'review',
        suggested_selling_price: null,
        expected_profit_delta_per_unit: null,
        reason_ar: 'السعر الناتج أقل من أو يساوي صفر ويحتاج مراجعة.',
        warnings: [],
        skipped_reason: 'manual_price_non_positive',
      };
    }

    // Below-cost guard is informational — we attach the warning but the
    // operator can still choose to apply if they explicitly tick the
    // row in preview. (Same policy as the smart path.)
    const preWarnings: SmartPricingWarning[] = [];
    if (cost > 0 && currentPrice > 0 && currentPrice < cost) {
      preWarnings.push('below_cost_at_current');
    }

    if (Math.abs(suggested - currentPrice) < 0.01) {
      return this._finalize(
        base,
        'keep',
        currentPrice,
        settings,
        minMargin,
        preWarnings,
        `${reason_ar} — السعر الجديد يساوي السعر الحالي.`,
      );
    }
    const dir: SmartPricingRecommendation =
      suggested > currentPrice ? 'increase' : 'decrease';
    return this._finalize(
      base,
      dir,
      suggested,
      settings,
      minMargin,
      preWarnings,
      reason_ar,
    );
  }

  /** Compute price needed to reach the target margin %, but never below
   *  the price needed for the minimum-margin policy floor. */
  private _priceForMargin(cost: number, targetPct: number, minPct: number): number {
    const target = Math.max(0, Math.min(94.99, Number(targetPct ?? 0)));
    const minimum = Math.max(0, Math.min(94.99, Number(minPct ?? 0)));
    const fromTarget = target < 100 ? cost / (1 - target / 100) : cost;
    const fromMin = minimum < 100 ? cost / (1 - minimum / 100) : cost;
    return Math.max(fromTarget, fromMin);
  }

  /** Finalize a recommendation row: applies rounding, recomputes the
   *  post-suggestion margin / markup / warnings. */
  private _finalize(
    base: any,
    recommendation: SmartPricingRecommendation,
    suggested: number,
    _settings: SmartPricingThresholds,
    minMargin: number,
    warnings: SmartPricingWarning[],
    reason_ar: string,
  ): SmartPricingItem {
    const cost = base.current_cost;
    const current = base.current_price;
    const suggestedPrice = round2(suggested);
    const finalMarginPct =
      suggestedPrice > 0
        ? round2((suggestedPrice - cost) / suggestedPrice * 100)
        : null;
    const finalMarkupPct =
      cost > 0 ? round2((suggestedPrice - cost) / cost * 100) : null;

    const allWarnings = [...warnings];
    if (suggestedPrice < cost) allWarnings.push('below_cost_after_change');
    if (
      finalMarginPct !== null
      && finalMarginPct < minMargin
      && recommendation !== 'keep'
    ) {
      allWarnings.push('below_min_margin_after_change');
    }
    const changeAbs = Math.abs(suggestedPrice - current);
    if (current > 0 && changeAbs / current > 0.5) {
      if (suggestedPrice > current) allWarnings.push('large_increase');
      else allWarnings.push('large_decrease');
    }
    if (base.stock_qty === 0 && !allWarnings.includes('no_stock'))
      allWarnings.push('no_stock');

    return {
      ...base,
      recommendation,
      suggested_selling_price: suggestedPrice,
      expected_profit_delta_per_unit: round2(suggestedPrice - cost) - round2(current - cost),
      final_margin_pct: finalMarginPct,
      final_markup_pct: finalMarkupPct,
      reason_ar,
      warnings: allWarnings,
      skipped_reason:
        recommendation === 'keep'
          ? 'price_already_appropriate'
          : recommendation === 'review'
            ? 'needs_manual_review'
            : null,
    };
  }

  /** Public entry: read-only preview. */
  async smartPricingPreview(dto: SmartPricingPreviewDto) {
    // P3.5A.1 — defensive validation for manual mode (matches the rule
    // documented in the DTO comments: value > 0, percent ≤ 500,
    // set_price ≥ 0.01). The DTO already enforces `value > 0` via the
    // `Min(0.01)` decorator; this extra branch covers the ceiling.
    if (dto.mode === 'manual') {
      const adj = dto.manual_adjustment;
      if (!adj) {
        throw new BadRequestException('manual_adjustment مطلوب لتعديل يدوي');
      }
      if (
        (adj.operation === 'increase_percent' ||
          adj.operation === 'decrease_percent') &&
        adj.value > 500
      ) {
        throw new BadRequestException(
          'النسبة لا يمكن أن تتجاوز 500%',
        );
      }
    }
    const { items, settings, total_candidates, effective_limit } =
      await this._smartPricingComputeRecommendations(dto);
    const summary = {
      total: items.length,
      increase: items.filter((i) => i.recommendation === 'increase').length,
      decrease: items.filter((i) => i.recommendation === 'decrease').length,
      keep: items.filter((i) => i.recommendation === 'keep').length,
      review: items.filter((i) => i.recommendation === 'review').length,
    };
    // HOTFIX P3.5A.1 timeout — surface truncation metadata so the UI
    // can warn the operator that they're only seeing the first N of M
    // candidates and tell them to narrow the filter or apply in
    // batches.
    const truncated = total_candidates > items.length;
    const message_ar = truncated
      ? `تم عرض أول ${items.length} صنف فقط من ${total_candidates}. ضيّق الفلتر أو طبّق على دفعات.`
      : null;
    return {
      strategy: dto.strategy,
      scope_type: dto.scope.type,
      mode: dto.mode ?? 'smart',
      manual_adjustment: dto.mode === 'manual' ? dto.manual_adjustment : null,
      settings,
      summary,
      items,
      truncated,
      total_candidates,
      returned_count: items.length,
      limit: effective_limit,
      message_ar,
    };
  }

  /** Public entry: apply. Re-runs preview server-side then applies only
   *  rows whose recommendation is increase/decrease AND that survive the
   *  optional `variant_ids_to_apply` filter. NEVER touches cost_price. */
  async smartPricingApply(dto: SmartPricingApplyDto, userId?: string) {
    if (!dto.reason || dto.reason.trim().length < 3) {
      throw new BadRequestException('سبب التعديل مطلوب');
    }
    if (dto.scope.type === 'all') {
      if (dto.confirm_all !== 'تأكيد تعديل كل الأصناف') {
        throw new BadRequestException(
          'تأكيد تعديل كل الأصناف مطلوب لتطبيق التعديل على كل الأصناف',
        );
      }
    }
    // P3.5A.1 — server re-runs preview with the same mode + manual
    // adjustment; client-supplied prices are NEVER trusted.
    const isManual = dto.mode === 'manual';
    if (isManual && !dto.manual_adjustment) {
      throw new BadRequestException(
        'manual_adjustment مطلوب لتعديل يدوي',
      );
    }

    // HOTFIX P3.5A.1 timeout — apply must not loop over thousands of
    // variants in one request. Reject early if the client asked for a
    // batch larger than SMART_APPLY_BATCH_MAX; otherwise re-run the
    // preview at the same hard cap so the in-memory candidates list is
    // bounded too.
    const SMART_APPLY_BATCH_MAX = 500;
    if (
      dto.variant_ids_to_apply
      && dto.variant_ids_to_apply.length > SMART_APPLY_BATCH_MAX
    ) {
      throw new BadRequestException(
        'عدد الأصناف كبير جدًا للتطبيق مرة واحدة. طبّق على دفعات أصغر.',
      );
    }
    // For all/filtered scope without an explicit variant_ids_to_apply
    // narrowing, refuse to walk the whole catalog in one request. The
    // operator must tick rows from the preview first.
    if (
      (dto.scope.type === 'all' || dto.scope.type === 'filtered')
      && (!dto.variant_ids_to_apply || dto.variant_ids_to_apply.length === 0)
    ) {
      throw new BadRequestException(
        'حدد الأصناف من المعاينة قبل التطبيق على نطاق واسع. طبّق على دفعات.',
      );
    }

    const { items } = await this._smartPricingComputeRecommendations({
      scope: dto.scope,
      strategy: dto.strategy,
      mode: dto.mode,
      manual_adjustment: dto.manual_adjustment,
      limit: SMART_APPLY_BATCH_MAX * 2, // headroom for keep/review skips
    });

    const applyFilter = dto.variant_ids_to_apply
      ? new Set(dto.variant_ids_to_apply)
      : null;
    const candidates = items.filter((it) => {
      if (it.recommendation !== 'increase' && it.recommendation !== 'decrease') return false;
      if (it.suggested_selling_price == null || it.suggested_selling_price <= 0) return false;
      if (Math.abs(it.suggested_selling_price - it.current_price) < 0.01) return false;
      if (applyFilter && !applyFilter.has(it.variant_id)) return false;
      return true;
    });

    // Final safety check: even after preview narrowing, refuse to
    // touch more than the batch cap in one transaction.
    if (candidates.length > SMART_APPLY_BATCH_MAX) {
      throw new BadRequestException(
        'عدد الأصناف كبير جدًا للتطبيق مرة واحدة. طبّق على دفعات أصغر.',
      );
    }

    return this.ds.transaction(async (em) => {
      const out: any[] = [];
      let updated = 0;
      let skipped = items.length - candidates.length;
      for (const it of candidates) {
        const [variant] = await em.query(
          `SELECT id, selling_price FROM product_variants WHERE id = $1`,
          [it.variant_id],
        );
        if (!variant) {
          throw new NotFoundException(`الصنف غير موجود: ${it.variant_id}`);
        }
        const oldPrice = Number(variant.selling_price ?? 0);
        const newPrice = Number(it.suggested_selling_price);
        if (Math.abs(newPrice - oldPrice) < 0.01) {
          skipped += 1;
          continue;
        }
        await em.query(
          `UPDATE product_variants
              SET selling_price = $2,
                  updated_at    = NOW()
            WHERE id = $1`,
          [it.variant_id, newPrice],
        );
        const meta: Record<string, any> = {
          source: 'smart_bulk_pricing',
          mode: isManual ? 'manual' : 'smart',
          strategy: isManual ? null : dto.strategy,
          recommendation: it.recommendation,
          reason_ar: it.reason_ar,
          warnings: it.warnings,
          scope_type: dto.scope.type,
        };
        if (isManual && dto.manual_adjustment) {
          meta.operation = dto.manual_adjustment.operation;
          meta.value = dto.manual_adjustment.value;
        }
        const [hist] = await em.query(
          `INSERT INTO variant_price_history
             (variant_id, old_selling_price, new_selling_price,
              source_purchase_id, source_purchase_no,
              reason, changed_by, metadata)
           VALUES ($1,$2,$3,NULL,NULL,$4,$5,$6)
           RETURNING id`,
          [it.variant_id, oldPrice, newPrice, dto.reason, userId ?? null, meta],
        );
        out.push({
          variant_id: it.variant_id,
          old_selling_price: oldPrice,
          new_selling_price: newPrice,
          recommendation: it.recommendation,
          history_id: hist?.id ?? null,
        });
        updated += 1;
      }
      return {
        strategy: dto.strategy,
        scope_type: dto.scope.type,
        mode: isManual ? 'manual' : 'smart',
        updated,
        skipped,
        items: out,
      };
    });
  }

  listVariants(productId: string) {
    return this.variants.find({
      where: { product_id: productId },
      order: { created_at: 'ASC' },
    });
  }

  /** Master color list (for UI pickers). */
  listColors() {
    return this.ds.query(
      `SELECT id, name_ar, name_en, hex_code FROM colors WHERE is_active = true ORDER BY name_ar`,
    );
  }

  /** Master size list (for UI pickers). */
  listSizes() {
    return this.ds.query(
      `SELECT id, size_label, size_system, sort_order FROM sizes
         WHERE is_active = true
         ORDER BY sort_order, size_label`,
    );
  }

  /** Preview the next auto-generated product SKU for a given type. */
  async previewProductSku(type: string) {
    const [row] = await this.ds.query(
      `SELECT fn_next_product_sku($1) AS sku`,
      [type || 'other'],
    );
    return { sku: row?.sku as string };
  }

  /** Preview the auto-generated variant SKU for a product + color + optional size. */
  async previewVariantSku(
    product_id: string,
    color_id: string,
    size_id?: string | null,
  ) {
    const [row] = await this.ds.query(
      `SELECT fn_next_variant_sku($1, $2, $3) AS sku`,
      [product_id, color_id, size_id || null],
    );
    return { sku: row?.sku as string };
  }
}
