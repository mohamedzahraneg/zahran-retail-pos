import { api, unwrap } from './client';

export interface ImportRow {
  row: number;
  data: Record<string, any>;
  errors: string[];
  warnings?: string[];
}

export interface ImportReport {
  total: number;
  valid: number;
  invalid: number;
  inserted: number;
  updated?: number;
  skipped?: number;
  applied?: number;
  rows: ImportRow[];
  dryRun: boolean;
}

function formWithFile(file: File, extra: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.append('file', file);
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return form;
}

const MULTIPART = { headers: { 'Content-Type': 'multipart/form-data' } };

export const importApi = {
  // ---- Products ----
  validate: (file: File, warehouse_code?: string) =>
    unwrap<ImportReport>(
      api.post(
        '/import/products/validate',
        formWithFile(file, warehouse_code ? { warehouse_code } : {}),
        MULTIPART,
      ),
    ),
  importProducts: (file: File, warehouse_code?: string) =>
    unwrap<ImportReport>(
      api.post(
        '/import/products',
        formWithFile(file, warehouse_code ? { warehouse_code } : {}),
        MULTIPART,
      ),
    ),

  // ---- Customers ----
  validateCustomers: (file: File) =>
    unwrap<ImportReport>(
      api.post('/import/customers/validate', formWithFile(file), MULTIPART),
    ),
  importCustomers: (file: File, upsert = true) =>
    unwrap<ImportReport>(
      api.post(
        '/import/customers',
        formWithFile(file, { upsert: String(upsert) }),
        MULTIPART,
      ),
    ),

  // ---- Suppliers ----
  validateSuppliers: (file: File) =>
    unwrap<ImportReport>(
      api.post('/import/suppliers/validate', formWithFile(file), MULTIPART),
    ),
  importSuppliers: (file: File, upsert = true) =>
    unwrap<ImportReport>(
      api.post(
        '/import/suppliers',
        formWithFile(file, { upsert: String(upsert) }),
        MULTIPART,
      ),
    ),

  // ---- Opening stock ----
  validateOpeningStock: (file: File) =>
    unwrap<ImportReport>(
      api.post('/import/opening-stock/validate', formWithFile(file), MULTIPART),
    ),
  applyOpeningStock: (file: File) =>
    unwrap<ImportReport>(
      api.post('/import/opening-stock', formWithFile(file), MULTIPART),
    ),
};
