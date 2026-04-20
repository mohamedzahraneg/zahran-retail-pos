import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface CreateCustomerGroupDto {
  code: string;
  name_ar: string;
  name_en?: string;
  description?: string;
  is_wholesale?: boolean;
  default_discount_pct?: number;
  min_order_amount?: number;
  credit_limit?: number;
  payment_terms_days?: number;
  is_active?: boolean;
  is_default?: boolean;
}

export interface UpdateCustomerGroupDto
  extends Partial<CreateCustomerGroupDto> {}

export interface UpsertGroupPriceDto {
  variant_id: string;
  price: number;
  min_qty?: number;
  valid_from?: string | null;
  valid_to?: string | null;
  is_active?: boolean;
  notes?: string;
}

export interface UpsertGroupCategoryDto {
  category_id: string;
  discount_pct: number;
  is_active?: boolean;
}

export interface ResolvePriceDto {
  variant_id: string;
  qty?: number;
}

@Injectable()
export class CustomerGroupsService {
  constructor(private readonly ds: DataSource) {}

  // ---------------------------------------------------------------- Groups

  async list(include_inactive = false) {
    return this.ds.query(
      `
      SELECT cg.*,
             (SELECT COUNT(*) FROM customers c WHERE c.group_id = cg.id)
                AS customers_count,
             (SELECT COUNT(*) FROM customer_group_prices gp
                WHERE gp.group_id = cg.id AND gp.is_active)
                AS variant_overrides_count,
             (SELECT COUNT(*) FROM customer_group_categories gc
                WHERE gc.group_id = cg.id AND gc.is_active)
                AS category_rules_count
      FROM customer_groups cg
      ${include_inactive ? '' : 'WHERE cg.is_active = TRUE'}
      ORDER BY cg.is_default DESC, cg.code ASC
      `,
    );
  }

  async get(id: string) {
    const [g] = await this.ds.query(
      `SELECT * FROM customer_groups WHERE id = $1`,
      [id],
    );
    if (!g) throw new NotFoundException('Customer group not found');
    const prices = await this.ds.query(
      `
      SELECT gp.*, pv.sku, p.name_ar AS product_name, pv.selling_price AS base_price
      FROM customer_group_prices gp
      JOIN product_variants pv ON pv.id = gp.variant_id
      JOIN products p          ON p.id  = pv.product_id
      WHERE gp.group_id = $1
      ORDER BY p.name_ar, gp.min_qty
      `,
      [id],
    );
    const categories = await this.ds.query(
      `
      SELECT gc.*, cat.name_ar AS category_name, cat.code AS category_code
      FROM customer_group_categories gc
      JOIN categories cat ON cat.id = gc.category_id
      WHERE gc.group_id = $1
      ORDER BY cat.name_ar
      `,
      [id],
    );
    return { ...g, prices, categories };
  }

  async create(dto: CreateCustomerGroupDto) {
    this.validateGroup(dto);
    return this.ds.transaction(async (em) => {
      if (dto.is_default) {
        await em.query(`UPDATE customer_groups SET is_default = FALSE`);
      }
      const [g] = await em.query(
        `
        INSERT INTO customer_groups
          (code, name_ar, name_en, description, is_wholesale,
           default_discount_pct, min_order_amount, credit_limit,
           payment_terms_days, is_active, is_default)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING *
        `,
        [
          dto.code,
          dto.name_ar,
          dto.name_en ?? null,
          dto.description ?? null,
          dto.is_wholesale ?? false,
          dto.default_discount_pct ?? 0,
          dto.min_order_amount ?? 0,
          dto.credit_limit ?? 0,
          dto.payment_terms_days ?? 0,
          dto.is_active ?? true,
          dto.is_default ?? false,
        ],
      );
      return g;
    });
  }

  async update(id: string, dto: UpdateCustomerGroupDto) {
    this.validateGroup(dto, true);
    const [cur] = await this.ds.query(
      `SELECT * FROM customer_groups WHERE id = $1`,
      [id],
    );
    if (!cur) throw new NotFoundException('not found');

    return this.ds.transaction(async (em) => {
      if (dto.is_default === true) {
        await em.query(`UPDATE customer_groups SET is_default = FALSE`);
      }
      const fields: string[] = [];
      const vals: any[] = [id];
      const push = (col: string, val: any) => {
        if (val === undefined) return;
        vals.push(val);
        fields.push(`${col} = $${vals.length}`);
      };
      push('code', dto.code);
      push('name_ar', dto.name_ar);
      push('name_en', dto.name_en);
      push('description', dto.description);
      push('is_wholesale', dto.is_wholesale);
      push('default_discount_pct', dto.default_discount_pct);
      push('min_order_amount', dto.min_order_amount);
      push('credit_limit', dto.credit_limit);
      push('payment_terms_days', dto.payment_terms_days);
      push('is_active', dto.is_active);
      push('is_default', dto.is_default);
      if (fields.length === 0) return cur;
      const [r] = await em.query(
        `UPDATE customer_groups SET ${fields.join(', ')}, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        vals,
      );
      return r;
    });
  }

  async remove(id: string) {
    const [g] = await this.ds.query(
      `SELECT * FROM customer_groups WHERE id = $1`,
      [id],
    );
    if (!g) throw new NotFoundException('not found');
    if (g.is_default) {
      throw new BadRequestException('لا يمكن حذف المجموعة الافتراضية');
    }
    // Reassign customers to default group, then delete
    return this.ds.transaction(async (em) => {
      const [defaultG] = await em.query(
        `SELECT id FROM customer_groups WHERE is_default = TRUE LIMIT 1`,
      );
      if (defaultG) {
        await em.query(
          `UPDATE customers SET group_id = $2 WHERE group_id = $1`,
          [id, defaultG.id],
        );
      }
      await em.query(`DELETE FROM customer_groups WHERE id = $1`, [id]);
      return { success: true };
    });
  }

  // ------------------------------------------------------- Variant overrides

  async listPrices(groupId: string) {
    return this.ds.query(
      `
      SELECT gp.*, pv.sku, pv.selling_price AS base_price,
             p.name_ar AS product_name,
             c.name_ar AS color_name, s.value AS size_value
      FROM customer_group_prices gp
      JOIN product_variants pv ON pv.id = gp.variant_id
      JOIN products p          ON p.id  = pv.product_id
      LEFT JOIN colors c       ON c.id  = pv.color_id
      LEFT JOIN sizes s        ON s.id  = pv.size_id
      WHERE gp.group_id = $1
      ORDER BY p.name_ar, pv.sku, gp.min_qty
      `,
      [groupId],
    );
  }

  async upsertPrice(groupId: string, dto: UpsertGroupPriceDto) {
    const [existing] = await this.ds.query(
      `SELECT id FROM customer_group_prices
       WHERE group_id = $1 AND variant_id = $2 AND min_qty = $3`,
      [groupId, dto.variant_id, dto.min_qty ?? 1],
    );
    if (existing) {
      const [r] = await this.ds.query(
        `UPDATE customer_group_prices SET
           price = $2, valid_from = $3, valid_to = $4,
           is_active = $5, notes = $6, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [
          existing.id,
          dto.price,
          dto.valid_from ?? null,
          dto.valid_to ?? null,
          dto.is_active ?? true,
          dto.notes ?? null,
        ],
      );
      return r;
    }
    const [r] = await this.ds.query(
      `
      INSERT INTO customer_group_prices
        (group_id, variant_id, price, min_qty, valid_from, valid_to, is_active, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        groupId,
        dto.variant_id,
        dto.price,
        dto.min_qty ?? 1,
        dto.valid_from ?? null,
        dto.valid_to ?? null,
        dto.is_active ?? true,
        dto.notes ?? null,
      ],
    );
    return r;
  }

  async removePrice(priceId: string) {
    await this.ds.query(
      `DELETE FROM customer_group_prices WHERE id = $1`,
      [priceId],
    );
    return { success: true };
  }

  async bulkUpsertPrices(
    groupId: string,
    items: UpsertGroupPriceDto[],
  ) {
    const results: any[] = [];
    for (const it of items) {
      results.push(await this.upsertPrice(groupId, it));
    }
    return { count: results.length, results };
  }

  // --------------------------------------------------------- Category rules

  async upsertCategoryRule(groupId: string, dto: UpsertGroupCategoryDto) {
    const [r] = await this.ds.query(
      `
      INSERT INTO customer_group_categories (group_id, category_id, discount_pct, is_active)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (group_id, category_id)
      DO UPDATE SET discount_pct = EXCLUDED.discount_pct,
                    is_active    = EXCLUDED.is_active
      RETURNING *`,
      [groupId, dto.category_id, dto.discount_pct, dto.is_active ?? true],
    );
    return r;
  }

  async removeCategoryRule(ruleId: string) {
    await this.ds.query(
      `DELETE FROM customer_group_categories WHERE id = $1`,
      [ruleId],
    );
    return { success: true };
  }

  // -------------------------------------------------------- Price resolver

  /**
   * Returns effective price for a variant given an optional customer.
   * Used by POS front-end when a customer is selected.
   */
  async resolve(variant_id: string, customer_id?: string, qty = 1) {
    const [r] = await this.ds.query(
      `SELECT fn_resolve_price($1, $2, $3) AS price`,
      [variant_id, customer_id ?? null, qty],
    );
    const price = r?.price !== null && r?.price !== undefined ? Number(r.price) : null;
    return { variant_id, customer_id: customer_id ?? null, qty, price };
  }

  /**
   * Batch resolve — returns { variant_id: price } for many variants.
   * Optimized for POS basket updates when the customer changes.
   */
  async resolveMany(
    variantIds: string[],
    customer_id?: string,
    qty = 1,
  ): Promise<Record<string, number>> {
    if (!variantIds?.length) return {};
    const rows = await this.ds.query(
      `
      SELECT v AS variant_id, fn_resolve_price(v, $2, $3) AS price
      FROM unnest($1::uuid[]) AS v
      `,
      [variantIds, customer_id ?? null, qty],
    );
    const out: Record<string, number> = {};
    for (const row of rows) {
      if (row.price !== null && row.price !== undefined) {
        out[row.variant_id] = Number(row.price);
      }
    }
    return out;
  }

  // --------------------------------------------------------------- helpers
  private validateGroup(dto: Partial<CreateCustomerGroupDto>, update = false) {
    if (!update) {
      if (!dto.code) throw new BadRequestException('code is required');
      if (!dto.name_ar) throw new BadRequestException('name_ar is required');
    }
    if (
      dto.default_discount_pct !== undefined &&
      (dto.default_discount_pct < 0 || dto.default_discount_pct > 100)
    ) {
      throw new BadRequestException('default_discount_pct must be 0..100');
    }
  }
}
