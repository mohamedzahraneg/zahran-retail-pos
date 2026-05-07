/**
 * FinancialReports.framing.test.tsx — PR-FE-ACCOUNTING-FINANCIAL-REPORTS-FRAMING
 *
 * Pins the framing/planning shell behavior of the Financial Reports
 * page:
 *
 *   1. Page renders the title "التقارير المالية" + "مرحلة التوطير" badge.
 *   2. Renders the framing notice that no journal entries / report
 *      approvals happen from this page.
 *   3. All 5 KPI cards render with their Arabic labels — and EVERY
 *      monetary slot is the em-dash placeholder ("—"); zero numeric
 *      content anywhere on the page.
 *   4. القوائم المحاسبية section renders the 4 statement rows with
 *      the "مخطط — غير منفّذ" badge.
 *   5. تقارير تشغيلية مرتبطة section renders the 5 operational links
 *      with the same "مخطط — غير منفّذ" badge.
 *   6. جاهزية التقرير readiness matrix renders 5 rows, every status
 *      is the literal "غير مفعل".
 *   7. Statement + operational drilldowns are disabled buttons (NOT
 *      links).
 *   8. All 4 page-level CTAs are disabled buttons with "قريبًا"
 *      pills — negative regression guard against any executive
 *      action accidentally going live.
 *   9. Page does NOT import any API client (no network calls), no
 *      `useQuery` / `useMutation`, no FinancialEngine / engineApi /
 *      journalApi / postJournal references in actual code.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import FinancialReports from '@/pages/FinancialReports';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/finance/reports']}>
      <FinancialReports />
    </MemoryRouter>,
  );
}

describe('<FinancialReports /> — PR-FE-ACCOUNTING-FINANCIAL-REPORTS-FRAMING', () => {
  // ─── 1. Title + stage badge ───────────────────────────────────
  it('renders the page title "التقارير المالية" and the "مرحلة التوطير" badge', () => {
    renderPage();
    const header = screen.getByTestId('financial-reports-header');
    expect(within(header).getByText('التقارير المالية')).toBeInTheDocument();
    const badge = screen.getByTestId('financial-reports-stage-badge');
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toBe('مرحلة التوطير');
  });

  // ─── 2. Framing notice ────────────────────────────────────────
  it('renders the read-only framing notice (no JE / no report approvals)', () => {
    renderPage();
    const notice = screen.getByTestId('financial-reports-framing-notice');
    expect(notice).toBeInTheDocument();
    expect(notice.textContent).toMatch(/للتأطير والمراجعة فقط/);
    expect(notice.textContent).toMatch(/لا يتم إنشاء قيود أو اعتماد تقارير/);
  });

  // ─── 3. KPI cards — all 5 present, ZERO digits anywhere ───────
  it('renders all 5 report KPI cards with Arabic labels', () => {
    renderPage();
    const kpis = screen.getByTestId('financial-reports-kpis');
    for (const label of [
      'ميزان المراجعة',
      'قائمة الدخل',
      'الميزانية العمومية',
      'التدفقات النقدية',
      'تقرير الزكاة والضريبة',
    ]) {
      expect(within(kpis).getByText(label)).toBeInTheDocument();
    }
  });

  it.each([
    'trial-balance',
    'income-statement',
    'balance-sheet',
    'cash-flows',
    'zakat-tax',
  ])('KPI card "%s" renders the em-dash placeholder and ZERO digits', (key) => {
    renderPage();
    const card = screen.getByTestId(`financial-reports-kpi-${key}`);
    expect(card.textContent).toMatch(/—/);
    // Defense-in-depth — no digit-bearing content (catches any accidental
    // "0" or "0.00" placeholder that would imply a real computation).
    expect(card.textContent).not.toMatch(/\d/);
  });

  // ─── 4. القوائم المحاسبية section ────────────────────────────
  it('renders القوائم المحاسبية section with 4 statement rows + "مخطط — غير منفّذ"', () => {
    renderPage();
    const section = screen.getByTestId('financial-reports-statements');
    expect(within(section).getByText('القوائم المحاسبية')).toBeInTheDocument();
    expect(within(section).getByText('مخطط — غير منفّذ')).toBeInTheDocument();
    for (const key of [
      'trial-balance',
      'income-statement',
      'balance-sheet',
      'cash-flows',
    ]) {
      expect(
        screen.getByTestId(`financial-reports-statement-${key}`),
      ).toBeInTheDocument();
    }
  });

  it.each([
    'trial-balance',
    'income-statement',
    'balance-sheet',
    'cash-flows',
  ])('statement drilldown "%s" is a disabled button (not a link)', (key) => {
    renderPage();
    const btn = screen.getByTestId(`financial-reports-statement-drilldown-${key}`);
    expect(btn.tagName.toLowerCase()).toBe('button');
    expect(btn).toBeDisabled();
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.getAttribute('title')).toBe('متاح في تحديث لاحق');
    expect(btn.textContent).toMatch(/قريبًا/);
  });

  // ─── 5. تقارير تشغيلية مرتبطة section ────────────────────────
  it('renders تقارير تشغيلية مرتبطة section with 5 rows', () => {
    renderPage();
    const section = screen.getByTestId('financial-reports-operational');
    expect(within(section).getByText('تقارير تشغيلية مرتبطة')).toBeInTheDocument();
    for (const label of [
      'الخزائن والبنوك',
      'المصروفات',
      'العملاء والموردين',
      'المخزون والجرد',
      'الموظفين والرواتب',
    ]) {
      expect(within(section).getByText(label)).toBeInTheDocument();
    }
  });

  it.each([
    'cashboxes',
    'expenses',
    'customers-suppliers',
    'inventory',
    'payroll',
  ])('operational drilldown "%s" is a disabled button (not a link)', (key) => {
    renderPage();
    const btn = screen.getByTestId(
      `financial-reports-operational-drilldown-${key}`,
    );
    expect(btn.tagName.toLowerCase()).toBe('button');
    expect(btn).toBeDisabled();
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.getAttribute('title')).toBe('متاح في تحديث لاحق');
    expect(btn.textContent).toMatch(/قريبًا/);
  });

  // ─── 6. جاهزية التقرير readiness matrix ──────────────────────
  it('renders جاهزية التقرير matrix with 5 rows, every status is "غير مفعل"', () => {
    renderPage();
    const section = screen.getByTestId('financial-reports-readiness');
    expect(within(section).getByText('جاهزية التقرير')).toBeInTheDocument();
    for (const key of [
      'trial-balance',
      'income-statement',
      'balance-sheet',
      'cash-flows',
      'zakat-tax',
    ]) {
      const row = screen.getByTestId(`financial-reports-readiness-${key}`);
      expect(row).toBeInTheDocument();
      const status = within(row).getByTestId(
        `financial-reports-readiness-status-${key}`,
      );
      expect(status.textContent).toBe('غير مفعل');
    }
  });

  // ─── 7. CTAs are disabled — NEGATIVE REGRESSION ──────────────
  it.each([
    { key: 'generate', label: 'توليد تقرير' },
    { key: 'export-pdf', label: 'تصدير PDF' },
    { key: 'export-excel', label: 'تصدير Excel' },
    { key: 'approve', label: 'اعتماد التقرير' },
  ])('CTA "$label" is rendered DISABLED with a "قريبًا" pill', ({ key, label }) => {
    renderPage();
    const cta = screen.getByTestId(`financial-reports-cta-${key}`);
    expect(cta.tagName.toLowerCase()).toBe('button');
    expect(cta).toBeDisabled();
    expect(cta.getAttribute('aria-disabled')).toBe('true');
    expect(cta.getAttribute('title')).toBe('متاح في تحديث لاحق');
    expect(cta.textContent).toMatch(label);
    expect(cta.textContent).toMatch(/قريبًا/);
  });

  // ─── 8. Page source has zero API imports ─────────────────────
  // Defense-in-depth — read the file off disk and assert it does not
  // import from `@/api/*` and does not call any of the financial-
  // engine / journal helpers. Strips comments first so the page's
  // own negative-control header (which legitimately MENTIONS strings
  // like "FinancialEngine" / "engineApi" to document what the page
  // does NOT do) doesn't false-trigger these regex guards.
  it('page source imports zero API clients (no network in framing phase)', () => {
    const src = readFileSync('src/pages/FinancialReports.tsx', 'utf-8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    expect(code).not.toMatch(/from ['"]@\/api\//);
    expect(code).not.toMatch(/\buseQuery\b|\buseMutation\b/);

    expect(code).not.toMatch(/\bFinancialEngine\b/);
    expect(code).not.toMatch(/\bengineApi\.\w+/);
    expect(code).not.toMatch(/\bjournalApi\.\w+/);
    expect(code).not.toMatch(/\bpostJournal\b/);
  });
});
