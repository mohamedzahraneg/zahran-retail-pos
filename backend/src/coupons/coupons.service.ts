import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  CreateCouponDto,
  UpdateCouponDto,
  ValidateCouponDto,
} from './dto/coupon.dto';

@Injectable()
export class CouponsService {
  constructor(private readonly ds: DataSource) {}

  async create(dto: CreateCouponDto, userId: string) {
    const [row] = await this.ds.query(
      `
      INSERT INTO coupons
        (code, name_ar, name_en, coupon_type, value, max_discount_amount,
         applies_to_category, applies_to_product, min_order_value,
         starts_at, expires_at, max_uses_total, max_uses_per_customer,
         is_active, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING *
      `,
      [
        dto.code.toUpperCase(),
        dto.name_ar,
        dto.name_en ?? null,
        dto.coupon_type,
        dto.value,
        dto.max_discount_amount ?? null,
        dto.applies_to_category ?? null,
        dto.applies_to_product ?? null,
        dto.min_order_value ?? 0,
        dto.starts_at ?? null,
        dto.expires_at ?? null,
        dto.max_uses_total ?? null,
        dto.max_uses_per_customer ?? 1,
        dto.is_active ?? true,
        userId,
      ],
    );
    return row;
  }

  async update(id: string, dto: UpdateCouponDto) {
    const keys = Object.keys(dto).filter(
      (k) => (dto as any)[k] !== undefined,
    );
    if (keys.length === 0) return this.findOne(id);
    const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const params = keys.map((k) =>
      k === 'code' ? String((dto as any)[k]).toUpperCase() : (dto as any)[k],
    );
    params.push(id);
    const [row] = await this.ds.query(
      `UPDATE coupons SET ${sets}, updated_at = NOW() WHERE id = $${keys.length + 1} RETURNING *`,
      params,
    );
    if (!row) throw new NotFoundException('الكوبون غير موجود');
    return row;
  }

  async remove(id: string) {
    const [row] = await this.ds.query(
      `UPDATE coupons SET is_active = FALSE, updated_at = NOW() WHERE id = $1 RETURNING id`,
      [id],
    );
    if (!row) throw new NotFoundException('الكوبون غير موجود');
    return { id, is_active: false };
  }

  list(params: { q?: string; active?: string }) {
    const conds: string[] = [];
    const ps: any[] = [];
    if (params.q) {
      ps.push(`%${params.q}%`);
      conds.push(
        `(code ILIKE $${ps.length} OR name_ar ILIKE $${ps.length} OR name_en ILIKE $${ps.length})`,
      );
    }
    if (params.active !== undefined && params.active !== '') {
      ps.push(params.active === 'true');
      conds.push(`is_active = $${ps.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    return this.ds.query(
      `
      SELECT c.*,
        cat.name_ar AS category_name,
        p.name_ar AS product_name,
        u.full_name AS created_by_name
      FROM coupons c
      LEFT JOIN categories cat ON cat.id = c.applies_to_category
      LEFT JOIN products p ON p.id = c.applies_to_product
      LEFT JOIN users u ON u.id = c.created_by
      ${where}
      ORDER BY c.created_at DESC
      LIMIT 200
      `,
      ps,
    );
  }

  async findOne(id: string) {
    const [row] = await this.ds.query(
      `SELECT * FROM coupons WHERE id = $1`,
      [id],
    );
    if (!row) throw new NotFoundException('الكوبون غير موجود');
    const usages = await this.ds.query(
      `
      SELECT cu.*, i.invoice_no, c.full_name AS customer_name
      FROM coupon_usages cu
      LEFT JOIN invoices i ON i.id = cu.invoice_id
      LEFT JOIN customers c ON c.id = cu.customer_id
      WHERE cu.coupon_id = $1
      ORDER BY cu.used_at DESC
      LIMIT 100
      `,
      [id],
    );
    return { ...row, usages };
  }

  /**
   * Validate a coupon and compute discount amount for a given subtotal.
   * Does NOT record usage — used by the POS preview.
   */
  async validate(dto: ValidateCouponDto) {
    const [coupon] = await this.ds.query(
      `SELECT * FROM coupons WHERE code = $1`,
      [dto.code.toUpperCase()],
    );
    if (!coupon) throw new NotFoundException('الكوبون غير موجود');

    if (!coupon.is_active) {
      throw new BadRequestException('الكوبون غير مفعل');
    }
    const now = new Date();
    if (coupon.starts_at && new Date(coupon.starts_at) > now) {
      throw new BadRequestException('الكوبون لم يبدأ بعد');
    }
    if (coupon.expires_at && new Date(coupon.expires_at) < now) {
      throw new BadRequestException('الكوبون منتهي الصلاحية');
    }
    if (
      coupon.max_uses_total &&
      Number(coupon.uses_count) >= Number(coupon.max_uses_total)
    ) {
      throw new BadRequestException('تم استنفاد عدد الاستخدامات');
    }

    const subtotal = Number(dto.subtotal ?? 0);
    if (Number(coupon.min_order_value) > subtotal) {
      throw new BadRequestException(
        `الحد الأدنى للفاتورة ${coupon.min_order_value} ج.م`,
      );
    }

    if (dto.customer_id && coupon.max_uses_per_customer) {
      const [{ cnt }] = await this.ds.query(
        `SELECT COUNT(*)::int AS cnt FROM coupon_usages
         WHERE coupon_id = $1 AND customer_id = $2`,
        [coupon.id, dto.customer_id],
      );
      if (Number(cnt) >= Number(coupon.max_uses_per_customer)) {
        throw new BadRequestException(
          'هذا العميل استنفد استخدامات الكوبون',
        );
      }
    }

    let discount = 0;
    if (coupon.coupon_type === 'percentage') {
      discount = (subtotal * Number(coupon.value)) / 100;
      if (coupon.max_discount_amount) {
        discount = Math.min(discount, Number(coupon.max_discount_amount));
      }
    } else {
      discount = Number(coupon.value);
    }
    discount = Math.min(discount, subtotal);

    return {
      coupon_id: coupon.id,
      code: coupon.code,
      name_ar: coupon.name_ar,
      coupon_type: coupon.coupon_type,
      value: coupon.value,
      discount_amount: Number(discount.toFixed(2)),
      subtotal,
    };
  }
}
