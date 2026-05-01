/**
 * cashboxDriftReportBuilder.test.ts — PR-FIN-PAYACCT-4D-REPORTS-1A-UX-FIX
 *
 * Pure-function tests for the drift Excel + Print HTML builders.
 * Production-shaped fixture: 3 real economic gaps (sum +250) plus
 * 1 self-cancelling pair (sum 0). Verifies categorization flows
 * through to the export output.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CashboxDriftDetailResponse } from '@/api/cash-desk.api';
import {
  buildDriftExcelRows,
  buildDriftPrintHtml,
  buildDriftReportFilename,
  buildDriftReportTitle,
} from '../cashboxDriftReportBuilder';

const SHIFT_REF_ID = 'shift-id-1';

const FIXTURE: CashboxDriftDetailResponse = {
  cashbox: {
    id: 'cb-1', name: 'الخزينة الرئيسية',
    kind: 'cash', is_active: true,
    stored_balance: '29800.00', gl_net: '29550.00', gl_drift: '250.00',
  },
  rows: [
    // 3 real economic gaps
    { cashbox_id: 'cb-1', cashbox_name: 'الخزينة الرئيسية',
      reference_type: 'invoice', reference_id: 'inv-A', reference_no: 'INV-2026-000147',
      coverage: 'both', ct_count: 5, je_line_count: 1,
      ct_signed_amount: '1050.00', je_signed_amount: '350.00', drift_amount: '700.00',
      first_seen_at: '2026-04-30T13:24:33Z', last_seen_at: '2026-04-30T14:15:09Z',
      sample_entry_no: 'JE-2026-000333' },
    { cashbox_id: 'cb-1', cashbox_name: 'الخزينة الرئيسية',
      reference_type: 'return', reference_id: 'ret-A', reference_no: null,
      coverage: 'CT_only', ct_count: 1, je_line_count: 0,
      ct_signed_amount: '-650.00', je_signed_amount: '0', drift_amount: '-650.00',
      first_seen_at: '2026-04-28T17:02:44Z', last_seen_at: '2026-04-28T17:02:44Z',
      sample_entry_no: null },
    { cashbox_id: 'cb-1', cashbox_name: 'الخزينة الرئيسية',
      reference_type: 'invoice', reference_id: 'inv-B', reference_no: 'INV-2026-000116',
      coverage: 'both', ct_count: 4, je_line_count: 1,
      ct_signed_amount: '400.00', je_signed_amount: '200.00', drift_amount: '200.00',
      first_seen_at: '2026-04-28T11:24:15Z', last_seen_at: '2026-04-28T13:23:23Z',
      sample_entry_no: 'JE-2026-000286' },
    // 1 self-cancelling pair (shift / shift_variance on the same id, opposite signs)
    { cashbox_id: 'cb-1', cashbox_name: 'الخزينة الرئيسية',
      reference_type: 'shift', reference_id: SHIFT_REF_ID, reference_no: null,
      coverage: 'CT_only', ct_count: 1, je_line_count: 0,
      ct_signed_amount: '17.99', je_signed_amount: '0', drift_amount: '17.99',
      first_seen_at: '2026-04-26T07:16:14Z', last_seen_at: '2026-04-26T07:16:14Z',
      sample_entry_no: null },
    { cashbox_id: 'cb-1', cashbox_name: 'الخزينة الرئيسية',
      reference_type: 'shift_variance', reference_id: SHIFT_REF_ID, reference_no: null,
      coverage: 'JE_only', ct_count: 0, je_line_count: 1,
      ct_signed_amount: '0', je_signed_amount: '17.99', drift_amount: '-17.99',
      first_seen_at: '2026-04-26T07:16:14Z', last_seen_at: '2026-04-26T07:16:14Z',
      sample_entry_no: 'JE-2026-000242' },
  ],
  totals: { count: 5, total_ct: '817.99', total_je: '567.99', total_drift: '250.00' },
};

describe('buildDriftReportTitle / buildDriftReportFilename — PR-FIN-PAYACCT-4D-REPORTS-1A-UX-FIX', () => {
  it('title includes the cashbox name', () => {
    const t = buildDriftReportTitle({ data: FIXTURE });
    expect(t).toMatch(/^تقرير فجوة الخزنة مع الأستاذ العام/);
    expect(t).toMatch(/الخزينة الرئيسية/);
  });

  it('filename has the cashbox slug + YYYY-MM-DD suffix; no filesystem-illegal chars', () => {
    const f = buildDriftReportFilename({ data: FIXTURE });
    expect(f).toMatch(/^cashbox-drift-report-/);
    expect(f).toMatch(/-\d{4}-\d{2}-\d{2}$/);
    expect(f).not.toMatch(/[\\/:*?"<>|]/);
  });
});

describe('buildDriftExcelRows — PR-FIN-PAYACCT-4D-REPORTS-1A-UX-FIX', () => {
  it('renders Arabic column headers (10 columns) + appends a totals summary row', () => {
    const rows = buildDriftExcelRows({ data: FIXTURE });
    // 5 fixture rows + 1 trailing summary row.
    expect(rows).toHaveLength(6);
    const sample = rows[0]!;
    [
      'التصنيف', 'نوع المرجع', 'رقم المرجع', 'التغطية',
      'مبلغ الخزنة (CT)', 'مبلغ الأستاذ (JE)', 'الفرق',
      'أول ظهور', 'آخر ظهور', 'قيد عيني',
    ].forEach((k) => expect(sample).toHaveProperty(k));
  });

  it('flags real-economic vs self-cancelling rows in the التصنيف column', () => {
    const rows = buildDriftExcelRows({ data: FIXTURE });
    const realCount = rows.filter(
      (r: any) => r['التصنيف'] === 'فرق مؤثر على الرصيد',
    ).length;
    const selfCount = rows.filter(
      (r: any) => r['التصنيف'] === 'اختلاف تصنيف يلغي نفسه',
    ).length;
    expect(realCount).toBe(3);
    expect(selfCount).toBe(2);
  });

  it('money columns are typed Number (so Excel can SUM)', () => {
    const rows = buildDriftExcelRows({ data: FIXTURE });
    const r0: any = rows[0];
    expect(typeof r0['مبلغ الخزنة (CT)']).toBe('number');
    expect(typeof r0['مبلغ الأستاذ (JE)']).toBe('number');
    expect(typeof r0['الفرق']).toBe('number');
  });

  it('summary row carries totals and the real / self split note', () => {
    const rows = buildDriftExcelRows({ data: FIXTURE });
    const last: any = rows[rows.length - 1];
    expect(last['التصنيف']).toMatch(/ملخص الفجوة/);
    expect(last['الفرق']).toBe(250);
    expect(last['قيد عيني']).toMatch(/فروقات حقيقية/);
    expect(last['قيد عيني']).toMatch(/اختلافات تلغي نفسها/);
  });

  it('returns [] when there are no rows (no blank workbook)', () => {
    const rows = buildDriftExcelRows({
      data: { ...FIXTURE, rows: [], totals: { count: 0, total_ct: '0', total_je: '0', total_drift: '0' } },
    });
    expect(rows).toEqual([]);
  });
});

describe('buildDriftPrintHtml — PR-FIN-PAYACCT-4D-REPORTS-1A-UX-FIX', () => {
  it('includes summary cards, contributors block, guidance block, both group tables, and the read-only footer', () => {
    const html = buildDriftPrintHtml({ data: FIXTURE });
    // Summary cards.
    expect(html).toMatch(/إجمالي الفرق/);
    expect(html).toMatch(/عدد المراجع/);
    expect(html).toMatch(/فروقات حقيقية/);
    expect(html).toMatch(/اختلافات تلغي نفسها/);
    // Contributors + guidance.
    expect(html).toMatch(/ما سبب الفرق؟/);
    expect(html).toMatch(/ماذا أفعل؟/);
    expect(html).toMatch(/شاشة التسويات/);
    // Both group tables (titled by the count).
    expect(html).toMatch(/الفروقات المؤثرة على الرصيد \(3\)/);
    expect(html).toMatch(/اختلافات تصنيف لا تؤثر على الإجمالي \(2\)/);
    // Footer.
    expect(html).toMatch(/هذه قراءة فقط؛ لا يتم إجراء أي تسوية تلقائية/);
  });

  it('Arabic reference-type labels render — never raw schema codes inside cells', () => {
    const html = buildDriftPrintHtml({ data: FIXTURE });
    expect(html).toMatch(/فاتورة بيع/);
    expect(html).toMatch(/مرتجع/);
    expect(html).toMatch(/وردية/);
    // Raw codes must NOT show up as cell values (they may appear in
    // CSS class names, but not as visible text).
    expect(html).not.toMatch(/>invoice</);
    expect(html).not.toMatch(/>return</);
    expect(html).not.toMatch(/>shift_variance</);
  });

  it('does NOT expose any "auto-settle" / "fix" action UI elements in the print output', () => {
    const html = buildDriftPrintHtml({ data: FIXTURE });
    // The guidance section legitimately MENTIONS "تسوية تلقائية" (in
    // the negative — "لا تقم بتسوية تلقائية") and the footer reinforces
    // the read-only contract. What must NOT exist is an action surface:
    // a <button>/<a> with action-y text, or instructions to click.
    expect(html).not.toMatch(/<button[^>]*>[^<]*تسوية[^<]*<\/button>/);
    expect(html).not.toMatch(/<a[^>]*>[^<]*تسوية[^<]*<\/a>/);
    expect(html).not.toMatch(/زر التسوية/);
    expect(html).not.toMatch(/اضغط للتسوية/);
  });

  it('escapes HTML special chars in user-supplied fields (cashbox name)', () => {
    const html = buildDriftPrintHtml({
      data: { ...FIXTURE, cashbox: { ...FIXTURE.cashbox!, name: '<script>alert(1)</script>' } },
    });
    expect(html).not.toMatch(/<script>alert/);
    expect(html).toMatch(/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });
});

/**
 * PR-FIN-PAYACCT-4D-REPORTS-1A-UX-FIX — read-only contract pinned at
 * the source-code level. The builder is supposed to be a pure
 * function over already-loaded data — never call APIs, never write.
 */
describe('cashboxDriftReportBuilder source — read-only contract', () => {
  it('imports zero write primitives (no useMutation, no .mutate(, no API instance imports)', () => {
    const path = resolve(__dirname, '..', 'cashboxDriftReportBuilder.ts');
    const src = readFileSync(path, 'utf8');
    expect(src).not.toMatch(/\buseMutation\b/);
    expect(src).not.toMatch(/\.mutate\(/);
    expect(src).not.toMatch(/from\s+['"]@\/api\/cash-desk\.api['"]\s*;.*cashDeskApi/);
    expect(src).not.toMatch(/from\s+['"]@\/api\/payments\.api['"]\s*;.*paymentsApi/);
  });
});
