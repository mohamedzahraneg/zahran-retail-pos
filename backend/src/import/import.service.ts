import { Injectable, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as ExcelJS from 'exceljs';

export interface ImportRow {
  row: number;
  data: Record<string, any>;
  errors: string[];
}

export interface ImportReport {
  total: number;
  valid: number;
  invalid: number;
  inserted: number;
  rows: ImportRow[];
  dryRun: boolean;
}

const REQUIRED = [
  'product_name',
  'category',
  'type',
  'color',
  'cost_price',
  'selling_price',
  'quantity',
];

const TYPES = ['shoe', 'bag', 'accessory'];
const AUDIENCES = ['women', 'men', 'kids', 'unisex'];

@Injectable()
export class ImportService {
  constructor(private readonly ds: DataSource) {}

  /**
   * Parse Excel buffer → rows with validation errors.
   */
  async parseAndValidate(
    buffer: Buffer,
    opts: { warehouseCode?: string } = {},
  ): Promise<ImportReport> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    const ws = wb.getWorksheet('Products') || wb.worksheets[0];
    if (!ws) throw new BadRequestException('No worksheet found');

    // Read header from first row
    const headerRow = ws.getRow(1);
    const headers: string[] = [];
    headerRow.eachCell((c, col) => {
      headers[col] = String(c.value || '').trim();
    });

    const rows: ImportRow[] = [];
    ws.eachRow((r, rowIdx) => {
      if (rowIdx === 1) return; // skip header
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
        data[key] = val;
        if (val != null && val !== '') hasAny = true;
      });
      if (!hasAny) return;

      const errors: string[] = [];
      for (const f of REQUIRED) {
        if (data[f] == null || data[f] === '') {
          errors.push(`${f}: مطلوب`);
        }
      }
      if (data.type && !TYPES.includes(String(data.type).toLowerCase())) {
        errors.push(`type: القيمة المسموحة ${TYPES.join(' / ')}`);
      }
      if (data.target_audience && !AUDIENCES.includes(String(data.target_audience).toLowerCase())) {
        errors.push(`target_audience: القيمة المسموحة ${AUDIENCES.join(' / ')}`);
      }
      const num = (k: string) => {
        const n = Number(data[k]);
        if (data[k] != null && data[k] !== '' && !Number.isFinite(n)) {
          errors.push(`${k}: قيمة رقمية غير صحيحة`);
        }
        return n;
      };
      const cost = num('cost_price');
      const sell = num('selling_price');
      const qty = num('quantity');
      if (Number.isFinite(cost) && cost < 0) errors.push('cost_price: لا يقبل قيمة سالبة');
      if (Number.isFinite(sell) && sell < 0) errors.push('selling_price: لا يقبل قيمة سالبة');
      if (Number.isFinite(qty) && qty < 0) errors.push('quantity: لا يقبل قيمة سالبة');
      if (Number.isFinite(cost) && Number.isFinite(sell) && sell < cost) {
        errors.push('selling_price أقل من cost_price — تحقق');
      }
      if (String(data.type).toLowerCase() === 'shoe' && !data.size) {
        errors.push('size: مطلوب للأحذية');
      }

      rows.push({ row: rowIdx, data, errors });
    });

    const valid = rows.filter((r) => r.errors.length === 0).length;
    const invalid = rows.length - valid;
    return {
      total: rows.length,
      valid,
      invalid,
      inserted: 0,
      rows,
      dryRun: true,
    };
  }

  /**
   * After validation, actually insert products and stock entries.
   */
  async importRows(
    buffer: Buffer,
    opts: { warehouseCode?: string; userId: string },
  ): Promise<ImportReport> {
    const report = await this.parseAndValidate(buffer, {
      warehouseCode: opts.warehouseCode,
    });
    report.dryRun = false;

    if (report.invalid > 0) {
      throw new BadRequestException({
        message: 'الملف يحتوي على أخطاء — لا يمكن الاستيراد',
        report,
      });
    }

    // Resolve warehouse
    const whCode = opts.warehouseCode || 'ZHR-01';
    const [{ id: warehouseId } = {} as any] = await this.ds.query(
      `SELECT id FROM warehouses WHERE code = $1 LIMIT 1`,
      [whCode],
    );
    if (!warehouseId) {
      throw new BadRequestException(`Warehouse not found: ${whCode}`);
    }

    let inserted = 0;
    await this.ds.transaction(async (em) => {
      for (const row of report.rows) {
        const d = row.data;
        // Upsert product (by name+category unique?)
        const skuRoot = (d.sku || this.buildSku(d)).toString().slice(0, 60);
        const [existing] = await em.query(
          `SELECT id FROM products WHERE sku_root = $1 LIMIT 1`,
          [skuRoot],
        );
        let productId = existing?.id;
        if (!productId) {
          const [p] = await em.query(
            `
            INSERT INTO products
              (sku_root, name, type, category_name, base_price, brand, target_audience, is_active)
            VALUES ($1,$2,$3,$4,$5,$6,$7,true)
            RETURNING id
            `,
            [
              skuRoot,
              d.product_name,
              String(d.type).toLowerCase(),
              d.category || null,
              Number(d.selling_price),
              d.brand || null,
              d.target_audience || 'women',
            ],
          );
          productId = p.id;
        }

        // Variant (color + size)
        const [variant] = await em.query(
          `
          INSERT INTO product_variants
            (product_id, sku, barcode, color, size, cost_price, price_override, is_active)
          VALUES ($1,$2,$3,$4,$5,$6,$7,true)
          ON CONFLICT (sku) DO UPDATE SET cost_price = EXCLUDED.cost_price, price_override = EXCLUDED.price_override
          RETURNING id
          `,
          [
            productId,
            `${skuRoot}-${d.color}-${d.size || 'N/A'}`.slice(0, 60),
            d.barcode || null,
            d.color,
            d.size || null,
            Number(d.cost_price),
            Number(d.selling_price),
          ],
        );

        // Stock
        await em.query(
          `
          INSERT INTO stock (variant_id, warehouse_id, quantity, quantity_reserved)
          VALUES ($1,$2,$3,0)
          ON CONFLICT (variant_id, warehouse_id)
            DO UPDATE SET quantity = stock.quantity + EXCLUDED.quantity
          `,
          [variant.id, warehouseId, Number(d.quantity)],
        );

        inserted++;
      }
    });

    report.inserted = inserted;
    return report;
  }

  private buildSku(d: Record<string, any>): string {
    const base = String(d.product_name || 'P')
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 6)
      .toUpperCase();
    const t = String(d.type || 'X').slice(0, 1).toUpperCase();
    const rand = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    return `${base}-${t}-${rand}`;
  }
}
