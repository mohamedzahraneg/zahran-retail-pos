import * as XLSX from 'xlsx';

/**
 * Export a flat array of rows to an Excel file download. Uses RTL
 * column order (fields appear right-to-left in Excel for Arabic
 * readers).
 *
 * @param filename  e.g. "aging-receivable-2026-04-22"
 * @param rows      Array of plain objects — keys become column headers
 * @param sheetName Optional worksheet name (default "Sheet1")
 */
export function exportToExcel<T extends Record<string, any>>(
  filename: string,
  rows: T[],
  sheetName = 'Sheet1',
) {
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!views'] = [{ RTL: true }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  XLSX.writeFile(
    wb,
    filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`,
  );
}

/**
 * Export multiple sheets in one workbook — useful for compound reports
 * (e.g. Income Statement + Balance Sheet in the same file).
 */
export function exportMultiSheet(
  filename: string,
  sheets: Array<{ name: string; rows: any[] }>,
) {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const ws = XLSX.utils.json_to_sheet(s.rows);
    ws['!views'] = [{ RTL: true }];
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
  }
  XLSX.writeFile(
    wb,
    filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`,
  );
}

/**
 * Generic "print this report" helper — opens a plain HTML dump in a
 * new window and calls print. Fast PDF replacement without a library.
 */
export function printReport(title: string, htmlBody: string) {
  const w = window.open('', '_blank', 'width=900,height=1100');
  if (!w) return;
  w.document.write(`<!doctype html>
<html dir="rtl" lang="ar">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    body { font-family: 'Tajawal','Cairo',Tahoma,sans-serif; padding: 20px; }
    h1 { font-size: 22px; margin: 0 0 10px; }
    table { width: 100%; border-collapse: collapse; margin: 10px 0; }
    th, td { border: 1px solid #ddd; padding: 6px 8px; text-align: right; }
    th { background: #f8fafc; }
    .muted { color: #64748b; font-size: 11px; }
    .right { text-align: left; }
    @media print { body { padding: 0; } }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <div class="muted">طُبع في ${new Date().toLocaleString('ar-EG', { timeZone: 'Africa/Cairo' })}</div>
  ${htmlBody}
  <script>
    setTimeout(() => window.print(), 300);
  </script>
</body>
</html>`);
  w.document.close();
}
