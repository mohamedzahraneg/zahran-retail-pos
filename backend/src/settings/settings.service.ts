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
        { code: 'dashboard.view',           label: 'عرض لوحة التحكم' },
        { code: 'dashboard.analytics',      label: 'عرض التحليلات الذكية' },
        { code: 'dashboard.profit',         label: 'عرض الأرباح في لوحة التحكم' },
      ],
      'نقطة البيع': [
        { code: 'pos.sell',                 label: 'بيع وإتمام الفاتورة' },
        { code: 'pos.discount',             label: 'خصم يدوي على الفاتورة' },
        { code: 'pos.void',                 label: 'إلغاء/إرجاع فاتورة من نقطة البيع' },
        { code: 'pos.reopen',               label: 'فتح فاتورة لتعديلها' },
        { code: 'pos.price_override',       label: 'تعديل سعر البيع يدويًا' },
        { code: 'pos.coupon',               label: 'استخدام كوبون في نقطة البيع' },
        { code: 'pos.loyalty',              label: 'استبدال نقاط ولاء في نقطة البيع' },
        { code: 'pos.hold',                 label: 'تعليق فاتورة (Park)' },
      ],
      'الفواتير': [
        { code: 'invoices.view',            label: 'عرض الفواتير' },
        { code: 'invoices.print',           label: 'طباعة الفواتير' },
        { code: 'invoices.edit',            label: 'تعديل فاتورة مبيعات' },
        { code: 'invoices.void',            label: 'إلغاء فاتورة' },
        { code: 'invoices.export',          label: 'تصدير الفواتير' },
        { code: 'invoices.history',         label: 'عرض سجل تعديلات الفاتورة' },
        { code: 'invoices.reprint',         label: 'إعادة طباعة الفاتورة' },
        { code: 'invoices.edit_request',    label: 'تقديم طلب تعديل فاتورة (ينتظر الموافقة)' },
        { code: 'invoices.edit_approve',    label: 'اعتماد/رفض طلبات تعديل الفواتير' },
      ],
      'الحجوزات': [
        { code: 'reservations.view',        label: 'عرض الحجوزات' },
        { code: 'reservations.create',      label: 'إنشاء حجز' },
        { code: 'reservations.update',      label: 'تعديل الحجز' },
        { code: 'reservations.fulfill',     label: 'استلام/تنفيذ الحجز' },
        { code: 'reservations.cancel',      label: 'إلغاء الحجز' },
      ],
      'المرتجعات': [
        { code: 'returns.view',             label: 'عرض المرتجعات' },
        { code: 'returns.create',           label: 'إنشاء مرتجع' },
        { code: 'returns.approve',          label: 'اعتماد مرتجع' },
        { code: 'returns.refund',           label: 'صرف قيمة المرتجع' },
        { code: 'returns.reject',           label: 'رفض مرتجع' },
        { code: 'returns.analytics',        label: 'تحليلات المرتجعات' },
      ],
      'المنتجات': [
        { code: 'products.view',            label: 'عرض المنتجات' },
        { code: 'products.create',          label: 'إضافة منتج' },
        { code: 'products.update',          label: 'تعديل منتج' },
        { code: 'products.delete',          label: 'حذف منتج' },
        { code: 'products.import',          label: 'استيراد Excel للمنتجات' },
        { code: 'products.barcode',         label: 'طباعة الباركود' },
        { code: 'products.cost',            label: 'عرض سعر التكلفة' },
        { code: 'products.value_view',      label: 'عرض إجمالي قيمة المخزون' },
        { code: 'products.price_change',    label: 'تعديل سعر البيع من شاشة المنتجات' },
        { code: 'categories.view',          label: 'عرض الفئات' },
        { code: 'categories.manage',        label: 'إدارة المجموعات والفئات' },
      ],
      'المخزون': [
        { code: 'stock.view',               label: 'عرض المخزون' },
        { code: 'stock.adjust',             label: 'تعديل/تسوية المخزون' },
        { code: 'stock.transfer',           label: 'نقل بين الفروع' },
        { code: 'stock.receive',            label: 'استلام تحويل' },
        { code: 'stock.count',              label: 'الجرد الفعلي' },
        { code: 'stock.count.post',         label: 'ترحيل نتيجة الجرد' },
        { code: 'stock.opening',            label: 'إدخال رصيد افتتاحي' },
        { code: 'stock.history',            label: 'حركة الصنف' },
        { code: 'stock.low_alerts',         label: 'تنبيهات المخزون المنخفض' },
        { code: 'warehouses.view',          label: 'عرض المخازن' },
        { code: 'warehouses.manage',        label: 'إدارة المخازن' },
      ],
      'المشتريات': [
        { code: 'purchases.view',           label: 'عرض المشتريات' },
        { code: 'purchases.create',         label: 'إنشاء فاتورة شراء' },
        { code: 'purchases.receive',        label: 'استلام بضاعة' },
        { code: 'purchases.edit',           label: 'تعديل فاتورة مشتريات' },
        { code: 'purchases.cancel',         label: 'إلغاء فاتورة مشتريات' },
        { code: 'purchases.pay',            label: 'دفع لمورد' },
        { code: 'purchases.return',         label: 'مرتجع للمورد' },
        { code: 'purchases.print',          label: 'طباعة فاتورة الشراء' },
      ],
      'الموردون': [
        { code: 'suppliers.view',           label: 'عرض الموردين' },
        { code: 'suppliers.create',         label: 'إضافة مورد' },
        { code: 'suppliers.update',         label: 'تعديل مورد' },
        { code: 'suppliers.delete',         label: 'حذف مورد' },
        { code: 'suppliers.balance',        label: 'عرض أرصدة الموردين' },
        { code: 'suppliers.statement',      label: 'كشف حساب المورد' },
        { code: 'suppliers.pay',            label: 'دفع لمورد' },
      ],
      'العملاء': [
        { code: 'customers.view',           label: 'عرض العملاء' },
        { code: 'customers.create',         label: 'إضافة عميل' },
        { code: 'customers.update',         label: 'تعديل عميل' },
        { code: 'customers.delete',         label: 'حذف عميل' },
        { code: 'customers.balance',        label: 'عرض أرصدة العملاء' },
        { code: 'customers.statement',      label: 'كشف حساب العميل' },
        { code: 'customers.credit_limit',   label: 'تعديل حد الائتمان' },
        { code: 'customers.receive',        label: 'قبض من عميل' },
        { code: 'customer_groups.view',     label: 'عرض مجموعات العملاء' },
        { code: 'customer_groups.manage',   label: 'إدارة مجموعات العملاء والأسعار' },
      ],
      'الولاء': [
        { code: 'loyalty.view',             label: 'عرض نقاط الولاء' },
        { code: 'loyalty.adjust',           label: 'تعديل نقاط العميل يدويًا' },
        { code: 'loyalty.config',           label: 'إعدادات معدل الكسب والاستبدال' },
        { code: 'loyalty.redeem',           label: 'استبدال نقاط في POS' },
      ],
      'العمولات': [
        { code: 'commissions.view',         label: 'عرض عمولات البائعين' },
        { code: 'commissions.manage',       label: 'تعديل نسب العمولة' },
        { code: 'commissions.payout',       label: 'صرف العمولات' },
      ],
      'الخزينة': [
        { code: 'cashdesk.view',            label: 'عرض الصندوق' },
        { code: 'cashdesk.receive',         label: 'قبض من العملاء' },
        { code: 'cashdesk.pay',             label: 'دفع للموردين' },
        { code: 'cashdesk.deposit',         label: 'إيداع يدوي / رصيد افتتاحي' },
        { code: 'cashdesk.withdraw',        label: 'سحب / تسوية يدوية' },
        { code: 'cashdesk.transfer',        label: 'تحويل بين الخزائن' },
        { code: 'cashdesk.history',         label: 'كشف حركة الخزينة' },
        { code: 'cashboxes.view',           label: 'عرض الخزائن' },
        { code: 'cashboxes.manage',         label: 'إدارة الخزائن' },
      ],
      'الورديات': [
        { code: 'shifts.view',              label: 'عرض الورديات' },
        { code: 'shifts.view_team',         label: 'عرض ورديات باقي الفريق' },
        { code: 'shifts.open',              label: 'فتح وردية' },
        { code: 'shifts.close',             label: 'طلب إقفال وردية' },
        { code: 'shifts.close_approve',     label: 'اعتماد/رفض طلبات إقفال الورديات' },
        { code: 'shifts.edit',              label: 'تعديل وردية' },
        { code: 'shifts.report',            label: 'تقرير الوردية' },
      ],
      'الحسابات والمصاريف': [
        { code: 'accounting.view',          label: 'عرض الحسابات' },
        { code: 'accounting.reports',       label: 'تقارير محاسبية' },
        { code: 'accounting.journal',       label: 'قيود اليومية' },
        { code: 'expenses.view',            label: 'عرض المصاريف' },
        { code: 'expenses.create',          label: 'إضافة مصروف' },
        { code: 'expenses.edit',            label: 'تعديل مصروف' },
        { code: 'expenses.delete',          label: 'حذف مصروف' },
        { code: 'expenses.approve',         label: 'اعتماد مصروف' },
        { code: 'recurring_expenses.view',  label: 'عرض المصاريف الدورية' },
        { code: 'recurring_expenses.manage',label: 'إدارة المصاريف الدورية' },
      ],
      'التقارير': [
        { code: 'reports.view',             label: 'عرض التقارير العامة' },
        { code: 'reports.sales',            label: 'تقارير المبيعات' },
        { code: 'reports.stock',            label: 'تقارير المخزون' },
        { code: 'reports.pnl',              label: 'تحليل الربح والخسارة' },
        { code: 'reports.customers',        label: 'تقارير العملاء' },
        { code: 'reports.suppliers',        label: 'تقارير الموردين' },
        { code: 'reports.cashier',          label: 'تقارير أداء الكاشيرين' },
        { code: 'reports.salesperson',      label: 'تقارير أداء البائعين' },
        { code: 'reports.tax',              label: 'تقارير الضريبة' },
        { code: 'reports.export',           label: 'تصدير التقارير' },
      ],
      'التنبيهات والإشعارات': [
        { code: 'alerts.view',              label: 'عرض التنبيهات' },
        { code: 'alerts.dismiss',           label: 'تجاهل تنبيه' },
        { code: 'alerts.manage',            label: 'إدارة قواعد التنبيهات' },
        { code: 'notifications.view',       label: 'عرض سجل الإشعارات' },
        { code: 'notifications.send',       label: 'إرسال إشعار / واتساب' },
        { code: 'notifications.manage',     label: 'إدارة قوالب الإشعارات' },
      ],
      'العروض والكوبونات': [
        { code: 'coupons.view',             label: 'عرض الكوبونات' },
        { code: 'coupons.create',           label: 'إنشاء كوبون' },
        { code: 'coupons.update',           label: 'تعديل كوبون' },
        { code: 'coupons.delete',           label: 'حذف كوبون' },
        { code: 'coupons.manage',           label: 'تفعيل/إيقاف الكوبونات' },
      ],
      'الحضور والانصراف': [
        { code: 'attendance.clock',         label: 'تسجيل حضور/انصراف شخصي' },
        { code: 'attendance.view_team',     label: 'عرض حضور الفريق' },
        { code: 'attendance.adjust',        label: 'تعديل سجل الحضور' },
        { code: 'attendance.reports',       label: 'تقارير الحضور' },
        { code: 'employee.attendance.manage', label: 'إدارة حضور ويومية الموظفين (نيابة + تثبيت + إلغاء)' },
      ],
      'المستخدمون والأدوار': [
        { code: 'users.view',               label: 'عرض المستخدمين' },
        { code: 'users.create',             label: 'إضافة مستخدم' },
        { code: 'users.update',             label: 'تعديل مستخدم' },
        { code: 'users.delete',             label: 'تعطيل/حذف مستخدم' },
        { code: 'users.password',           label: 'إعادة تعيين كلمات المرور' },
        { code: 'users.permissions',        label: 'تعديل صلاحيات المستخدم' },
        { code: 'users.manage',             label: 'إدارة شاملة للمستخدمين' },
        { code: 'roles.view',               label: 'عرض الأدوار' },
        { code: 'roles.manage',             label: 'إدارة الأدوار والصلاحيات' },
      ],
      'ملفات الموظفين (HR)': [
        { code: 'employee.dashboard.view',  label: 'عرض الملف الشخصي للموظف' },
        { code: 'employee.requests.submit', label: 'تقديم طلب (سلفة/إجازة/تمديد)' },
        { code: 'employee.team.view',       label: 'عرض ملفات فريق العمل' },
        { code: 'employee.requests.approve',label: 'اعتماد/رفض طلبات الموظفين' },
        { code: 'employee.profile.manage',  label: 'تعديل الراتب وساعات العمل' },
        { code: 'employee.bonuses.view',    label: 'عرض الحوافز والمكافآت' },
        { code: 'employee.bonuses.manage',  label: 'إضافة حوافز/مكافآت/ساعات إضافية' },
        { code: 'employee.deductions.view', label: 'عرض الاستقطاعات' },
        { code: 'employee.deductions.manage', label: 'إضافة/تعديل استقطاعات' },
        { code: 'employee.tasks.assign',    label: 'إسناد مهام للموظفين' },
        { code: 'employee.tasks.view_team', label: 'عرض مهام كل الموظفين' },
      ],
      'الإعدادات': [
        { code: 'settings.view',            label: 'عرض الإعدادات' },
        { code: 'settings.manage',          label: 'تعديل إعدادات النظام' },
        { code: 'settings.branding',        label: 'شعار واسم المتجر' },
        { code: 'settings.receipts',        label: 'قوالب الفواتير' },
        { code: 'settings.taxes',           label: 'إعدادات الضريبة' },
        { code: 'settings.payment_methods', label: 'طرق الدفع' },
        { code: 'settings.security',        label: 'إعدادات الأمان' },
        { code: 'settings.backup',          label: 'نسخ واستعادة البيانات' },
      ],
      'النظام والتدقيق': [
        { code: 'audit.view',               label: 'سجل التدقيق' },
        { code: 'audit.export',             label: 'تصدير سجل التدقيق' },
        { code: 'import.run',               label: 'استيراد Excel' },
        { code: 'import.history',           label: 'عرض سجل الاستيراد' },
        { code: 'setup.run',                label: 'تشغيل معالج الإعداد الأول' },
      ],
    };
    // Flatten list for quick lookup/validation.
    const flat = Object.values(groups).flat().map((p) => p.code);
    return { groups, all: flat };
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
