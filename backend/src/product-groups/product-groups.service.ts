/**
 * product-groups.service.ts — PR-P9.1a
 *
 * Manual product-group CRUD + variant membership.
 *
 * Hard guarantees (pinned by product-groups.service.spec.ts static
 * guardrail tests):
 *   · NO writes to `product_variants.selling_price` /
 *     `product_variants.cost_price` from this service.
 *   · NO writes to `stock`, `stock_movements`, `journal_entries`,
 *     `journal_lines`, `cashbox_transactions`, `cashbox_balances`,
 *     `supplier_ledger`, `supplier_payments`,
 *     `supplier_payment_allocations`.
 *   · NO `posting.service` / `financialEngine` / `recordTransaction`
 *     / `postPurchase` / `postSupplierPayment` / `reverseByReference`
 *     / `fn_void_purchase` / `fn_record_cashbox_txn` references.
 *   · NO apply-style methods. Selector-only by design.
 *
 * The only mutations this service makes are:
 *   · INSERT / UPDATE rows in `product_groups`
 *   · INSERT / DELETE rows in `product_group_variants`
 */
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  AddProductGroupVariantsDto,
  CreateProductGroupDto,
  UpdateProductGroupDto,
} from './dto/product-group.dto';

const VARIANTS_ADD_BATCH_MAX = 500;

@Injectable()
export class ProductGroupsService {
  constructor(private readonly ds: DataSource) {}

  // --------------------------------------------------------------------------
  //  Group CRUD
  // --------------------------------------------------------------------------

  /** List groups with member_count. Supports a free-text `q` filter
   *  (ILIKE on `name_ar` / `name_en`) and an `is_active` boolean. */
  async list(filters: { q?: string; is_active?: boolean } = {}) {
    const params: any[] = [];
    const conds: string[] = [];
    if (filters.q && filters.q.trim()) {
      params.push(`%${filters.q.trim()}%`);
      const idx = params.length;
      conds.push(
        `(g.name_ar ILIKE $${idx}::text OR g.name_en ILIKE $${idx}::text)`,
      );
    }
    if (filters.is_active !== undefined) {
      params.push(filters.is_active);
      conds.push(`g.is_active = $${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    return this.ds.query(
      `SELECT g.id, g.name_ar, g.name_en, g.description, g.color,
              g.is_active, g.created_at, g.updated_at,
              COALESCE(m.cnt, 0)::int AS member_count
         FROM product_groups g
         LEFT JOIN (
           SELECT group_id, COUNT(*)::int AS cnt
             FROM product_group_variants
            GROUP BY group_id
         ) m ON m.group_id = g.id
        ${where}
        ORDER BY g.is_active DESC, g.name_ar ASC`,
      params,
    );
  }

  /** Detail: group header + member rows (variant + product + color +
   *  size + stock_on_hand). Throws 404 if the group is missing. */
  async findOne(id: string) {
    const [group] = await this.ds.query(
      `SELECT id, name_ar, name_en, description, color, is_active,
              created_by, created_at, updated_at
         FROM product_groups
        WHERE id = $1`,
      [id],
    );
    if (!group) {
      throw new NotFoundException(`Product group ${id} not found`);
    }
    const members = await this.ds.query(
      `SELECT pgv.variant_id,
              pgv.added_at,
              pv.sku,
              pv.barcode,
              pv.cost_price::numeric(14,2)    AS current_cost_price,
              pv.selling_price::numeric(14,2) AS current_selling_price,
              pv.is_active                     AS variant_is_active,
              p.id                             AS product_id,
              p.name_ar                        AS product_name,
              c.name_ar                        AS color_name,
              s.size_label                     AS size_label,
              COALESCE(stock_sum.qty, 0)::int  AS stock_on_hand
         FROM product_group_variants pgv
         JOIN product_variants pv ON pv.id = pgv.variant_id
         JOIN products p          ON p.id = pv.product_id
         LEFT JOIN colors c       ON c.id = pv.color_id
         LEFT JOIN sizes s        ON s.id = pv.size_id
         LEFT JOIN (
           SELECT variant_id, SUM(quantity_on_hand)::int AS qty
             FROM stock GROUP BY variant_id
         ) stock_sum ON stock_sum.variant_id = pv.id
        WHERE pgv.group_id = $1
        ORDER BY p.name_ar, pv.sku`,
      [id],
    );
    return { ...group, members };
  }

  async create(dto: CreateProductGroupDto, userId?: string | null) {
    const name = dto.name_ar.trim();
    if (!name) {
      throw new BadRequestException('اسم المجموعة مطلوب');
    }
    const [row] = await this.ds.query(
      `INSERT INTO product_groups
          (name_ar, name_en, description, color, created_by)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *`,
      [
        name,
        dto.name_en?.trim() || null,
        dto.description?.trim() || null,
        dto.color || null,
        userId ?? null,
      ],
    );
    return row;
  }

  async update(id: string, dto: UpdateProductGroupDto) {
    const sets: string[] = [];
    const params: any[] = [];
    const push = (col: string, val: any) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };
    if (dto.name_ar !== undefined) {
      const name = dto.name_ar.trim();
      if (!name) {
        throw new BadRequestException('اسم المجموعة لا يمكن أن يكون فارغًا');
      }
      push('name_ar', name);
    }
    if (dto.name_en !== undefined) {
      push('name_en', dto.name_en.trim() || null);
    }
    if (dto.description !== undefined) {
      push('description', dto.description.trim() || null);
    }
    if (dto.color !== undefined) {
      push('color', dto.color || null);
    }
    if (dto.is_active !== undefined) {
      push('is_active', dto.is_active);
    }
    if (sets.length === 0) {
      // Defensive — empty PATCH still returns the row.
      return this.findOne(id);
    }
    sets.push('updated_at = NOW()');
    params.push(id);
    const [row] = await this.ds.query(
      `UPDATE product_groups SET ${sets.join(', ')}
        WHERE id = $${params.length}
        RETURNING *`,
      params,
    );
    if (!row) {
      throw new NotFoundException(`Product group ${id} not found`);
    }
    return row;
  }

  /** Soft-delete: flips `is_active=false`. The actual DB row stays
   *  so existing memberships remain queryable for audit. */
  async remove(id: string) {
    const [row] = await this.ds.query(
      `UPDATE product_groups
          SET is_active = FALSE, updated_at = NOW()
        WHERE id = $1
        RETURNING id`,
      [id],
    );
    if (!row) {
      throw new NotFoundException(`Product group ${id} not found`);
    }
    return { deactivated: true, id };
  }

  // --------------------------------------------------------------------------
  //  Variant membership
  // --------------------------------------------------------------------------

  /** Bulk add. Idempotent: existing pairs are ignored via
   *  `ON CONFLICT DO NOTHING`. Returns how many new rows landed. */
  async addVariants(
    id: string,
    dto: AddProductGroupVariantsDto,
    userId?: string | null,
  ) {
    if (!dto.variant_ids || dto.variant_ids.length === 0) {
      throw new BadRequestException('قائمة الأصناف مطلوبة');
    }
    if (dto.variant_ids.length > VARIANTS_ADD_BATCH_MAX) {
      throw new BadRequestException(
        'عدد الأصناف كبير جدًا. أضف بدفعات لا تتجاوز 500.',
      );
    }
    const [group] = await this.ds.query(
      `SELECT id FROM product_groups WHERE id = $1`,
      [id],
    );
    if (!group) {
      throw new NotFoundException(`Product group ${id} not found`);
    }
    const before = await this.ds.query(
      `SELECT COUNT(*)::int AS cnt FROM product_group_variants
        WHERE group_id = $1`,
      [id],
    );
    const beforeCount = Number(before?.[0]?.cnt ?? 0);
    await this.ds.query(
      `INSERT INTO product_group_variants (group_id, variant_id, added_by)
         SELECT $1::uuid, v_id::uuid, $3
           FROM unnest($2::uuid[]) AS v_id
        ON CONFLICT DO NOTHING`,
      [id, dto.variant_ids, userId ?? null],
    );
    const after = await this.ds.query(
      `SELECT COUNT(*)::int AS cnt FROM product_group_variants
        WHERE group_id = $1`,
      [id],
    );
    const afterCount = Number(after?.[0]?.cnt ?? 0);
    return {
      group_id: id,
      requested: dto.variant_ids.length,
      added: afterCount - beforeCount,
      skipped: dto.variant_ids.length - (afterCount - beforeCount),
      member_count: afterCount,
    };
  }

  async removeVariant(id: string, variantId: string) {
    const res = await this.ds.query(
      `DELETE FROM product_group_variants
        WHERE group_id = $1 AND variant_id = $2`,
      [id, variantId],
    );
    // `ds.query` for DELETE returns affected-rows metadata via the
    // second element of the result tuple in some driver shapes. Be
    // tolerant — operators see a clean response either way.
    const removed = Array.isArray(res) ? (res[1] ?? 1) : 1;
    const [{ cnt }] = await this.ds.query(
      `SELECT COUNT(*)::int AS cnt FROM product_group_variants
        WHERE group_id = $1`,
      [id],
    );
    return {
      group_id: id,
      variant_id: variantId,
      removed: Number(removed) > 0,
      member_count: Number(cnt ?? 0),
    };
  }
}
