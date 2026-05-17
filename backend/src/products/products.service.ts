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
} from './dto/product.dto';

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
