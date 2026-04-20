import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  UpdateCompanyProfileDto,
  UpsertCashboxDto,
  UpsertSettingDto,
  UpsertWarehouseDto,
} from './dto/settings.dto';

@Injectable()
export class SettingsService {
  constructor(private readonly ds: DataSource) {}

  // ─── Key/Value settings ──────────────────────────────────────────────
  async list(group?: string) {
    if (group) {
      return this.ds.query(
        `SELECT * FROM settings WHERE group_name = $1 ORDER BY key`,
        [group],
      );
    }
    return this.ds.query(`SELECT * FROM settings ORDER BY group_name, key`);
  }

  async get(key: string) {
    const [row] = await this.ds.query(
      `SELECT * FROM settings WHERE key = $1`,
      [key],
    );
    if (!row) throw new NotFoundException('الإعداد غير موجود');
    return row;
  }

  async upsert(dto: UpsertSettingDto, userId: string) {
    const [row] = await this.ds.query(
      `
      INSERT INTO settings (key, value, group_name, is_public, description, updated_by)
      VALUES ($1, $2, COALESCE($3,'general'), COALESCE($4,FALSE), $5, $6)
      ON CONFLICT (key) DO UPDATE SET
        value = EXCLUDED.value,
        group_name = COALESCE(EXCLUDED.group_name, settings.group_name),
        is_public = COALESCE(EXCLUDED.is_public, settings.is_public),
        description = COALESCE(EXCLUDED.description, settings.description),
        updated_by = EXCLUDED.updated_by,
        updated_at = NOW()
      RETURNING *
      `,
      [
        dto.key,
        JSON.stringify(dto.value),
        dto.group_name ?? null,
        dto.is_public ?? null,
        dto.description ?? null,
        userId,
      ],
    );
    return row;
  }

  async delete(key: string) {
    const res = await this.ds.query(
      `DELETE FROM settings WHERE key = $1 RETURNING id`,
      [key],
    );
    if (!res.length) throw new NotFoundException('الإعداد غير موجود');
    return { deleted: true };
  }

  // ─── Company profile (single row table) ──────────────────────────────
  async getCompany() {
    const [row] = await this.ds.query(
      `SELECT * FROM company_profile WHERE id = 1 LIMIT 1`,
    );
    return row || null;
  }

  async updateCompany(dto: UpdateCompanyProfileDto) {
    const fields: string[] = [];
    const params: any[] = [];
    let i = 1;
    for (const [k, v] of Object.entries(dto)) {
      if (v === undefined) continue;
      fields.push(`${k} = $${i++}`);
      params.push(v);
    }
    if (!fields.length) return this.getCompany();

    fields.push(`updated_at = NOW()`);
    const existing = await this.getCompany();
    if (existing) {
      params.push(existing.id);
      const [row] = await this.ds.query(
        `UPDATE company_profile SET ${fields.join(', ')}
         WHERE id = $${i} RETURNING *`,
        params,
      );
      return row;
    } else {
      // Create the singleton row
      const cols = Object.keys(dto).filter(
        (k) => (dto as any)[k] !== undefined,
      );
      const placeholders = cols.map((_, idx) => `$${idx + 1}`);
      const vals = cols.map((k) => (dto as any)[k]);
      const [row] = await this.ds.query(
        `INSERT INTO company_profile (${cols.join(', ')})
         VALUES (${placeholders.join(', ')})
         RETURNING *`,
        vals,
      );
      return row;
    }
  }

  // ─── Warehouses ─────────────────────────────────────────────────────
  listWarehouses(includeInactive = false) {
    return this.ds.query(
      `SELECT w.*, u.full_name AS manager_name
       FROM warehouses w
       LEFT JOIN users u ON u.id = w.manager_id
       ${includeInactive ? '' : 'WHERE w.is_active = TRUE'}
       ORDER BY w.is_main DESC, w.code`,
    );
  }

  async createWarehouse(dto: UpsertWarehouseDto) {
    const [row] = await this.ds.query(
      `INSERT INTO warehouses (code, name_ar, name_en, address, phone, manager_id, is_main, is_retail, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,FALSE),COALESCE($8,TRUE),COALESCE($9,TRUE))
       RETURNING *`,
      [
        dto.code,
        dto.name_ar,
        dto.name_en ?? null,
        dto.address ?? null,
        dto.phone ?? null,
        dto.manager_id ?? null,
        dto.is_main,
        dto.is_retail,
        dto.is_active,
      ],
    );
    return row;
  }

  async updateWarehouse(id: string, dto: UpsertWarehouseDto) {
    const fields: string[] = [];
    const params: any[] = [];
    let i = 1;
    for (const [k, v] of Object.entries(dto)) {
      if (v === undefined) continue;
      fields.push(`${k} = $${i++}`);
      params.push(v);
    }
    if (!fields.length) throw new NotFoundException('No fields to update');
    fields.push(`updated_at = NOW()`);
    params.push(id);
    const [row] = await this.ds.query(
      `UPDATE warehouses SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      params,
    );
    if (!row) throw new NotFoundException('المخزن غير موجود');
    return row;
  }

  // ─── Cashboxes ──────────────────────────────────────────────────────
  listCashboxes(warehouseId?: string) {
    const params: any[] = [];
    let cond = 'WHERE cb.is_active = TRUE';
    if (warehouseId) {
      params.push(warehouseId);
      cond += ` AND cb.warehouse_id = $1`;
    }
    return this.ds.query(
      `SELECT cb.*, w.name_ar AS warehouse_name
       FROM cashboxes cb
       LEFT JOIN warehouses w ON w.id = cb.warehouse_id
       ${cond}
       ORDER BY cb.name_ar`,
      params,
    );
  }

  async createCashbox(dto: UpsertCashboxDto) {
    const [row] = await this.ds.query(
      `INSERT INTO cashboxes (name_ar, name_en, warehouse_id, is_active)
       VALUES ($1,$2,$3,COALESCE($4,TRUE))
       RETURNING *`,
      [dto.name_ar, dto.name_en ?? null, dto.warehouse_id, dto.is_active],
    );
    return row;
  }

  async updateCashbox(id: string, dto: UpsertCashboxDto) {
    const fields: string[] = [];
    const params: any[] = [];
    let i = 1;
    for (const [k, v] of Object.entries(dto)) {
      if (v === undefined) continue;
      fields.push(`${k} = $${i++}`);
      params.push(v);
    }
    if (!fields.length) throw new NotFoundException('No fields to update');
    fields.push(`updated_at = NOW()`);
    params.push(id);
    const [row] = await this.ds.query(
      `UPDATE cashboxes SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      params,
    );
    if (!row) throw new NotFoundException('الخزينة غير موجودة');
    return row;
  }

  // ─── Roles + Payment methods (read-only lookups) ────────────────────
  listRoles() {
    return this.ds.query(
      `SELECT r.*,
              (SELECT COUNT(*)::int FROM users u WHERE u.role_id = r.id) AS users_count
         FROM roles r
        WHERE r.is_active = true
        ORDER BY r.is_system DESC, r.name_ar`,
    );
  }

  async updateRole(
    id: string,
    body: { name_ar?: string; name_en?: string; description?: string; permissions?: string[] },
  ) {
    const fields: string[] = [];
    const params: any[] = [];
    let i = 1;
    if (body.name_ar !== undefined) {
      fields.push(`name_ar = $${i++}`);
      params.push(body.name_ar);
    }
    if (body.name_en !== undefined) {
      fields.push(`name_en = $${i++}`);
      params.push(body.name_en);
    }
    if (body.description !== undefined) {
      fields.push(`description = $${i++}`);
      params.push(body.description);
    }
    if (body.permissions !== undefined) {
      fields.push(`permissions = $${i++}::text[]`);
      params.push(body.permissions);
    }
    if (!fields.length) throw new NotFoundException('لا توجد حقول للتعديل');
    fields.push(`updated_at = NOW()`);
    params.push(id);
    const [row] = await this.ds.query(
      `UPDATE roles SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      params,
    );
    if (!row) throw new NotFoundException('الدور غير موجود');
    return row;
  }

  async createRole(body: {
    code: string;
    name_ar: string;
    name_en?: string;
    description?: string;
    permissions?: string[];
  }) {
    const [row] = await this.ds.query(
      `INSERT INTO roles (code, name_ar, name_en, description, permissions, is_system, is_active)
       VALUES ($1, $2, $3, $4, COALESCE($5::text[], '{}'::text[]), false, true)
       RETURNING *`,
      [
        body.code,
        body.name_ar,
        body.name_en ?? body.name_ar, // name_en is NOT NULL; fall back to Arabic name
        body.description ?? null,
        body.permissions ?? [],
      ],
    );
    return row;
  }

  async deleteRole(id: string) {
    const [row] = await this.ds.query(
      `SELECT is_system FROM roles WHERE id = $1`,
      [id],
    );
    if (!row) throw new NotFoundException('الدور غير موجود');
    if (row.is_system) {
      throw new NotFoundException('لا يمكن حذف الأدوار الأساسية للنظام');
    }
    await this.ds.query(
      `UPDATE roles SET is_active = false, updated_at = NOW() WHERE id = $1`,
      [id],
    );
    return { archived: true };
  }

  /** Catalogue of permission codes grouped by module (for the UI permission picker). */
  listPermissions() {
    const groups: Record<string, Array<{ code: string; label: string }>> = {
      'لوحة التحكم': [
        { code: 'dashboard.view', label: 'عرض لوحة التحكم' },
        { code: 'reports.view', label: 'عرض التقارير' },
      ],
      'نقطة البيع': [
        { code: 'pos.sell', label: 'بيع' },
        { code: 'pos.discount', label: 'خصم يدوي' },
        { code: 'pos.void', label: 'إلغاء فاتورة' },
        { code: 'pos.reserve', label: 'حجز بعربون' },
      ],
      'المنتجات والمخزون': [
        { code: 'products.view', label: 'عرض المنتجات' },
        { code: 'products.create', label: 'إضافة منتج' },
        { code: 'products.update', label: 'تعديل منتج' },
        { code: 'products.delete', label: 'حذف منتج' },
        { code: 'stock.adjust', label: 'تعديل المخزون' },
        { code: 'stock.transfer', label: 'نقل بين الفروع' },
      ],
      'العملاء والموردون': [
        { code: 'customers.view', label: 'عرض العملاء' },
        { code: 'customers.manage', label: 'إدارة العملاء' },
        { code: 'suppliers.view', label: 'عرض الموردين' },
        { code: 'suppliers.manage', label: 'إدارة الموردين' },
      ],
      'المشتريات': [
        { code: 'purchases.view', label: 'عرض المشتريات' },
        { code: 'purchases.create', label: 'إنشاء فاتورة شراء' },
        { code: 'purchases.receive', label: 'استلام بضاعة' },
      ],
      'الخزينة والحسابات': [
        { code: 'cashdesk.view', label: 'عرض الصندوق' },
        { code: 'cashdesk.receive', label: 'قبض من عميل' },
        { code: 'cashdesk.pay', label: 'دفع لمورد' },
        { code: 'expenses.create', label: 'إضافة مصروف' },
        { code: 'expenses.approve', label: 'اعتماد مصروف' },
        { code: 'accounting.reports', label: 'تقارير محاسبية' },
      ],
      'المرتجعات': [
        { code: 'returns.create', label: 'إنشاء مرتجع' },
        { code: 'returns.approve', label: 'اعتماد مرتجع' },
        { code: 'returns.refund', label: 'صرف مبلغ مرتجع' },
      ],
      'الإدارة': [
        { code: 'users.manage', label: 'إدارة المستخدمين' },
        { code: 'roles.manage', label: 'إدارة الأدوار والصلاحيات' },
        { code: 'settings.manage', label: 'إعدادات النظام' },
        { code: 'audit.view', label: 'سجل التدقيق' },
      ],
    };
    return { groups };
  }

  listPaymentMethods() {
    return this.ds.query(
      `SELECT * FROM payment_methods ORDER BY sort_order, name_ar`,
    );
  }

  async togglePaymentMethod(code: string, is_active: boolean) {
    const [row] = await this.ds.query(
      `UPDATE payment_methods SET is_active = $1 WHERE code = $2::payment_method_code RETURNING *`,
      [is_active, code],
    );
    if (!row) throw new NotFoundException('طريقة الدفع غير موجودة');
    return row;
  }
}
