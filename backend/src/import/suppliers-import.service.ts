import { Injectable, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as ExcelJS from 'exceljs';

export interface SupplierImportRow {
  row: number;
  data: Record<string, any>;
  errors: string[];
  warnings: string[];
}

export interface SupplierImportReport {
  total: number;
  valid: number;
  invalid: number;
  inserted: number;
  updated: number;
  skipped: number;
  rows: SupplierImportRow[];
  dryRun: boolean;
}

const REQUIRED = ['name'];

/**
 * Import suppliers from Excel.
 *
 * Columns:
 *   name                ← required
 *   contact_person
 *   phone
 *   alt_phone
 *   email
 *   address
 *   tax_number
 *   payment_terms_days
 *   credit_limit
 *   current_balance      (opening balance; +ve = we owe them)
 *   is_active            (true/false)
 *   notes
 */
@Injectable()
export class SuppliersImportService {
  constructor(private readonly ds: DataSource) {}

  async parseAndValidate(buffer: Buffer): Promise<SupplierImportReport> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    const ws = wb.getWorksheet('Suppliers') || wb.worksheets[0];
    if (!ws) throw new BadRequestException('No worksheet found');

    const headerRow = ws.getRow(1);
    const headers: string[] = [];
    headerRow.eachCell((c, col) => {
      headers[col] = String(c.value || '').trim().toLowerCase().replace(/\s+/g, '_');
    });

    const rows: SupplierImportRow[] = [];
    const seenNames = new Set<string>();

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

      if (data.name) {
        const key = String(data.name).toLowerCase();
        if (seenNames.has(key)) errors.push('name: مكرر في الملف');
        seenNames.add(key);
      }

      const numField = (k: string) => {
        if (data[k] == null || data[k] === '') return;
        const n = Number(data[k]);
        if (!Number.isFinite(n)) errors.push(`${k}: قيمة رقمية غير صحيحة`);
        else data[k] = n;
      };
      numField('payment_terms_days');
      numField('credit_limit');
      numField('current_balance');

      if (data.is_active != null) {
        const v = String(data.is_active).toLowerCase();
        data.is_active = !['false', '0', 'no', 'n', 'لا'].includes(v);
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
  ): Promise<SupplierImportReport> {
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
        const [x] = await em.query(
          `SELECT id FROM suppliers WHERE LOWER(name) = LOWER($1) LIMIT 1`,
          [d.name],
        );
        if (x && !upsert) {
          skipped++;
          continue;
        }
        if (x) {
          await em.query(
            `
            UPDATE suppliers SET
              contact_person     = COALESCE($2, contact_person),
              phone              = COALESCE($3, phone),
              alt_phone          = COALESCE($4, alt_phone),
              email              = COALESCE($5, email),
              address            = COALESCE($6, address),
              tax_number         = COALESCE($7, tax_number),
              payment_terms_days = COALESCE($8, payment_terms_days),
              credit_limit       = COALESCE($9, credit_limit),
              current_balance    = COALESCE($10, current_balance),
              is_active          = COALESCE($11, is_active),
              notes              = COALESCE($12, notes),
              updated_at         = NOW()
            WHERE id = $1
            `,
            [
              x.id,
              d.contact_person || null,
              d.phone || null,
              d.alt_phone || null,
              d.email || null,
              d.address || null,
              d.tax_number || null,
              d.payment_terms_days ?? null,
              d.credit_limit ?? null,
              d.current_balance ?? null,
              d.is_active ?? null,
              d.notes || null,
            ],
          );
          updated++;
        } else {
          const [{ nextnum }] = await em.query(
            `SELECT COALESCE(MAX(CAST(SUBSTRING(supplier_no FROM 5) AS INT)), 0) + 1 AS nextnum
             FROM suppliers WHERE supplier_no LIKE 'SUP-%'`,
          );
          const supplierNo = `SUP-${String(nextnum).padStart(6, '0')}`;
          await em.query(
            `
            INSERT INTO suppliers
              (supplier_no, name, contact_person, phone, alt_phone, email, address,
               tax_number, payment_terms_days, credit_limit, current_balance,
               is_active, notes, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
            `,
            [
              supplierNo,
              d.name,
              d.contact_person || null,
              d.phone || null,
              d.alt_phone || null,
              d.email || null,
              d.address || null,
              d.tax_number || null,
              d.payment_terms_days ?? 0,
              d.credit_limit ?? 0,
              d.current_balance ?? 0,
              d.is_active ?? true,
              d.notes || null,
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
