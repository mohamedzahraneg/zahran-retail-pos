import { Injectable, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as ExcelJS from 'exceljs';
import { ImportService } from './import.service';

export interface OpeningStockRow {
  row: number;
  data: Record<string, any>;
  errors: string[];
  warnings: string[];
}

export interface OpeningStockReport {
  total: number;
  valid: number;
  invalid: number;
  applied: number;
  skipped: number;
  rows: OpeningStockRow[];
  dryRun: boolean;
}

const REQUIRED = ['sku', 'warehouse_code', 'quantity'];

/**
 * Import opening stock balances.
 *
 * Unlike the product importer (which INSERTs products+variants+initial stock),
 * this service adjusts the quantity of *existing* variants in *existing*
 * warehouses. It's meant for data migration: "this is what my old system
 * says I have on the shelves as of today".
 *
 * Each row creates a stock_adjustment with reason='opening_balance' and
 * updates the stock table to match the target quantity exactly (difference
 * recorded in the adjustment line for audit).
 *
 * Columns:
 *   sku             ← variant SKU (required)
 *   warehouse_code  ← warehouse code (required)
 *   quantity        ← target on-hand quantity (required, ≥0)
 *   cost_price      ← optional: updates variant cost if provided
 *   notes
 */
@Injectable()
export class OpeningStockImportService {
  constructor(
    private readonly ds: DataSource,
    private readonly productsImport: ImportService,
  ) {}

  /** True if the sheet header includes product creation columns. */
  private async isRichTemplate(buffer: Buffer): Promise<boolean> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    const ws = wb.getWorksheet('OpeningStock') || wb.worksheets[0];
    if (!ws) return false;
    const header = ws.getRow(1);
    let found = false;
    header.eachCell((c) => {
      const v = String(c.value || '').trim();
      if (v.includes('product_name') || v.includes('اسم المنتج')) found = true;
    });
    return found;
  }

  async parseAndValidate(buffer: Buffer): Promise<OpeningStockReport> {
    // If the uploaded file is the rich template (product_name + color + size + …),
    // delegate to the products importer which handles full upsert.
    if (await this.isRichTemplate(buffer)) {
      const r = await this.productsImport.parseAndValidate(buffer);
      return {
        total: r.total,
        valid: r.valid,
        invalid: r.invalid,
        applied: 0,
        skipped: 0,
        rows: r.rows.map((x) => ({ ...x, warnings: [] })),
        dryRun: true,
      };
    }

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    const ws = wb.getWorksheet('OpeningStock') || wb.worksheets[0];
    if (!ws) throw new BadRequestException('No worksheet found');

    const headerRow = ws.getRow(1);
    const headers: string[] = [];
    headerRow.eachCell((c, col) => {
      headers[col] = String(c.value || '').trim().toLowerCase().replace(/\s+/g, '_');
    });

    const rows: OpeningStockRow[] = [];
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

      const num = (k: string) => {
        if (data[k] == null || data[k] === '') return;
        const n = Number(data[k]);
        if (!Number.isFinite(n)) errors.push(`${k}: قيمة رقمية غير صحيحة`);
        else if (n < 0) errors.push(`${k}: لا يقبل قيمة سالبة`);
        else data[k] = n;
      };
      num('quantity');
      num('cost_price');

      rows.push({ row: rowIdx, data, errors, warnings });
    });

    const valid = rows.filter((x) => x.errors.length === 0).length;
    return {
      total: rows.length,
      valid,
      invalid: rows.length - valid,
      applied: 0,
      skipped: 0,
      rows,
      dryRun: true,
    };
  }

  async apply(
    buffer: Buffer,
    opts: { userId: string },
  ): Promise<OpeningStockReport> {
    // Rich template → delegate to products importer.
    if (await this.isRichTemplate(buffer)) {
      const r = await this.productsImport.importRows(buffer, {
        userId: opts.userId,
      });
      return {
        total: r.total,
        valid: r.valid,
        invalid: r.invalid,
        applied: r.inserted,
        skipped: r.total - r.inserted,
        rows: r.rows.map((x) => ({ ...x, warnings: [] })),
        dryRun: false,
      };
    }

    const report = await this.parseAndValidate(buffer);
    report.dryRun = false;
    if (report.invalid > 0) {
      throw new BadRequestException({
        message: 'الملف يحتوي على أخطاء — لا يمكن التطبيق',
        report,
      });
    }

    let applied = 0;
    let skipped = 0;

    await this.ds.transaction(async (em) => {
      for (const row of report.rows) {
        const d = row.data;
        const [variant] = await em.query(
          `SELECT id FROM product_variants WHERE sku = $1 LIMIT 1`,
          [d.sku],
        );
        if (!variant) {
          row.errors.push(`SKU غير موجود: ${d.sku}`);
          skipped++;
          continue;
        }
        const [wh] = await em.query(
          `SELECT id FROM warehouses WHERE code = $1 LIMIT 1`,
          [d.warehouse_code],
        );
        if (!wh) {
          row.errors.push(`Warehouse غير موجود: ${d.warehouse_code}`);
          skipped++;
          continue;
        }

        // current quantity
        const [cur] = await em.query(
          `SELECT quantity FROM stock WHERE variant_id = $1 AND warehouse_id = $2`,
          [variant.id, wh.id],
        );
        const currentQty = Number(cur?.quantity || 0);
        const targetQty = Number(d.quantity);
        const delta = targetQty - currentQty;

        // Upsert stock row
        await em.query(
          `
          INSERT INTO stock (variant_id, warehouse_id, quantity, quantity_reserved)
          VALUES ($1, $2, $3, 0)
          ON CONFLICT (variant_id, warehouse_id)
            DO UPDATE SET quantity = EXCLUDED.quantity
          `,
          [variant.id, wh.id, targetQty],
        );

        // Update cost if provided
        if (d.cost_price != null) {
          await em.query(
            `UPDATE product_variants SET cost_price = $2 WHERE id = $1`,
            [variant.id, d.cost_price],
          );
        }

        // Record adjustment for audit trail (if table exists)
        try {
          await em.query(
            `
            INSERT INTO stock_adjustments
              (variant_id, warehouse_id, quantity_before, quantity_after,
               delta, reason, notes, user_id)
            VALUES ($1,$2,$3,$4,$5,'opening_balance',$6,$7)
            `,
            [
              variant.id,
              wh.id,
              currentQty,
              targetQty,
              delta,
              d.notes || 'Opening balance from migration',
              opts.userId || null,
            ],
          );
        } catch {
          // table may not exist yet — not fatal
        }

        applied++;
      }
    });

    report.applied = applied;
    report.skipped = skipped;
    return report;
  }
}
