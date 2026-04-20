import { Injectable, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as ExcelJS from 'exceljs';

export interface CustomerImportRow {
  row: number;
  data: Record<string, any>;
  errors: string[];
  warnings: string[];
}

export interface CustomerImportReport {
  total: number;
  valid: number;
  invalid: number;
  inserted: number;
  updated: number;
  skipped: number;
  rows: CustomerImportRow[];
  dryRun: boolean;
}

const REQUIRED = ['full_name'];
const GENDERS = ['female', 'male', 'other'];
const TIERS = ['bronze', 'silver', 'gold', 'platinum'];

/**
 * Import customers from Excel (for migrating from legacy systems).
 *
 * Expected columns (case-insensitive, Arabic-friendly):
 *   full_name       ← required
 *   phone           ← primary identifier
 *   alt_phone
 *   email
 *   national_id
 *   birth_date      (yyyy-mm-dd or Excel date)
 *   gender          (female/male/other)
 *   address_line
 *   city
 *   governorate
 *   loyalty_points  (int, defaults 0)
 *   loyalty_tier    (bronze/silver/gold/platinum)
 *   total_spent     (numeric, opening balance for analytics)
 *   notes
 *   is_vip          (true/false, 0/1, yes/no)
 *
 * Upsert behavior:
 *   - Matches by phone (if provided) → updates
 *   - Else matches by email (if provided)
 *   - Else matches by national_id (if provided)
 *   - Else inserts new
 */
@Injectable()
export class CustomersImportService {
  constructor(private readonly ds: DataSource) {}

  async parseAndValidate(buffer: Buffer): Promise<CustomerImportReport> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    const ws = wb.getWorksheet('Customers') || wb.worksheets[0];
    if (!ws) throw new BadRequestException('No worksheet found');

    const headerRow = ws.getRow(1);
    const headers: string[] = [];
    headerRow.eachCell((c, col) => {
      headers[col] = String(c.value || '').trim().toLowerCase().replace(/\s+/g, '_');
    });

    const rows: CustomerImportRow[] = [];
    const seenPhones = new Set<string>();
    const seenEmails = new Set<string>();

    ws.eachRow((r, rowIdx) => {
      if (rowIdx === 1) return;
      const data: Record<string, any> = {};
      let hasAny = false;
      r.eachCell((c, col) => {
        const key = headers[col];
        if (!key) return;
        const v = c.value;
        let val: any = v;
        if (v && typeof v === 'object' && 'richText' in (v as any)) {
          val = (v as any).richText.map((t: any) => t.text).join('');
        } else if (v && typeof v === 'object' && 'result' in (v as any)) {
          val = (v as any).result;
        } else if (v && typeof v === 'object' && 'text' in (v as any)) {
          val = (v as any).text;
        } else if (v instanceof Date) {
          val = v.toISOString().slice(0, 10);
        }
        data[key] = typeof val === 'string' ? val.trim() : val;
        if (val != null && val !== '') hasAny = true;
      });
      if (!hasAny) return;

      const errors: string[] = [];
      const warnings: string[] = [];

      for (const f of REQUIRED) {
        if (data[f] == null || data[f] === '') errors.push(`${f}: مطلوب`);
      }

      // phone normalization (Egypt: +20 / 0...)
      if (data.phone) {
        const p = String(data.phone).replace(/[^0-9+]/g, '');
        data.phone = p;
        if (!/^(\+?20)?0?1[0125]\d{8}$/.test(p) && p.length < 7) {
          warnings.push('phone: الشكل قد يكون غير صحيح');
        }
        if (seenPhones.has(p)) errors.push('phone: مكرر في الملف');
        seenPhones.add(p);
      }

      if (data.email) {
        const e = String(data.email).toLowerCase();
        data.email = e;
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) {
          warnings.push('email: الشكل قد يكون غير صحيح');
        }
        if (seenEmails.has(e)) errors.push('email: مكرر في الملف');
        seenEmails.add(e);
      }

      if (data.gender) {
        const g = String(data.gender).toLowerCase();
        if (!GENDERS.includes(g)) {
          errors.push(`gender: القيمة المسموحة ${GENDERS.join(' / ')}`);
        } else data.gender = g;
      }

      if (data.loyalty_tier) {
        const t = String(data.loyalty_tier).toLowerCase();
        if (!TIERS.includes(t)) {
          errors.push(`loyalty_tier: القيمة المسموحة ${TIERS.join(' / ')}`);
        } else data.loyalty_tier = t;
      }

      const numField = (k: string) => {
        if (data[k] == null || data[k] === '') return;
        const n = Number(data[k]);
        if (!Number.isFinite(n)) errors.push(`${k}: قيمة رقمية غير صحيحة`);
        else if (n < 0) errors.push(`${k}: لا يقبل قيمة سالبة`);
        else data[k] = n;
      };
      numField('loyalty_points');
      numField('total_spent');

      if (data.is_vip != null) {
        const v = String(data.is_vip).toLowerCase();
        data.is_vip = ['true', '1', 'yes', 'y', 'نعم'].includes(v);
      }

      if (data.birth_date) {
        const d = new Date(data.birth_date);
        if (!Number.isFinite(d.getTime())) warnings.push('birth_date: تاريخ غير مفهوم — سيتم تجاهله');
        else data.birth_date = d.toISOString().slice(0, 10);
      }

      rows.push({ row: rowIdx, data, errors, warnings });
    });

    const valid = rows.filter((x) => x.errors.length === 0).length;
    return {
      total: rows.length,
      valid,
      invalid: rows.length - valid,
      inserted: 0,
      updated: 0,
      skipped: 0,
      rows,
      dryRun: true,
    };
  }

  async importRows(
    buffer: Buffer,
    opts: { userId: string; upsert?: boolean },
  ): Promise<CustomerImportReport> {
    const report = await this.parseAndValidate(buffer);
    report.dryRun = false;
    if (report.invalid > 0) {
      throw new BadRequestException({
        message: 'الملف يحتوي على أخطاء — لا يمكن الاستيراد',
        report,
      });
    }

    const upsert = opts.upsert !== false;
    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    await this.ds.transaction(async (em) => {
      for (const row of report.rows) {
        const d = row.data;

        // find existing
        let existingId: string | null = null;
        if (d.phone) {
          const [x] = await em.query(
            `SELECT id FROM customers WHERE phone = $1 LIMIT 1`,
            [d.phone],
          );
          if (x) existingId = x.id;
        }
        if (!existingId && d.email) {
          const [x] = await em.query(
            `SELECT id FROM customers WHERE email = $1 LIMIT 1`,
            [d.email],
          );
          if (x) existingId = x.id;
        }
        if (!existingId && d.national_id) {
          const [x] = await em.query(
            `SELECT id FROM customers WHERE national_id = $1 LIMIT 1`,
            [d.national_id],
          );
          if (x) existingId = x.id;
        }

        if (existingId && !upsert) {
          skipped++;
          continue;
        }

        if (existingId) {
          await em.query(
            `
            UPDATE customers SET
              full_name      = COALESCE($2, full_name),
              alt_phone      = COALESCE($3, alt_phone),
              email          = COALESCE($4, email),
              national_id    = COALESCE($5, national_id),
              birth_date     = COALESCE($6, birth_date),
              gender         = COALESCE($7, gender),
              address_line   = COALESCE($8, address_line),
              city           = COALESCE($9, city),
              governorate    = COALESCE($10, governorate),
              loyalty_points = COALESCE($11, loyalty_points),
              loyalty_tier   = COALESCE($12, loyalty_tier),
              total_spent    = COALESCE($13, total_spent),
              notes          = COALESCE($14, notes),
              is_vip         = COALESCE($15, is_vip),
              updated_at     = NOW()
            WHERE id = $1
            `,
            [
              existingId,
              d.full_name || null,
              d.alt_phone || null,
              d.email || null,
              d.national_id || null,
              d.birth_date || null,
              d.gender || null,
              d.address_line || null,
              d.city || null,
              d.governorate || null,
              d.loyalty_points ?? null,
              d.loyalty_tier || null,
              d.total_spent ?? null,
              d.notes || null,
              d.is_vip ?? null,
            ],
          );
          updated++;
        } else {
          // generate customer_no
          const [{ nextnum }] = await em.query(
            `SELECT COALESCE(MAX(CAST(SUBSTRING(customer_no FROM 5) AS INT)), 0) + 1 AS nextnum
             FROM customers WHERE customer_no LIKE 'CUS-%'`,
          );
          const customerNo = `CUS-${String(nextnum).padStart(6, '0')}`;
          await em.query(
            `
            INSERT INTO customers
              (customer_no, full_name, phone, alt_phone, email, national_id,
               birth_date, gender, address_line, city, governorate,
               loyalty_points, loyalty_tier, total_spent, notes, is_vip, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
            `,
            [
              customerNo,
              d.full_name,
              d.phone || null,
              d.alt_phone || null,
              d.email || null,
              d.national_id || null,
              d.birth_date || null,
              d.gender || null,
              d.address_line || null,
              d.city || null,
              d.governorate || null,
              d.loyalty_points ?? 0,
              d.loyalty_tier || 'bronze',
              d.total_spent ?? 0,
              d.notes || null,
              d.is_vip ?? false,
              opts.userId || null,
            ],
          );
          inserted++;
        }
      }
    });

    report.inserted = inserted;
    report.updated = updated;
    report.skipped = skipped;
    return report;
  }
}
