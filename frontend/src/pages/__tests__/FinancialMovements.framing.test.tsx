/**
 * FinancialMovements.framing.test.tsx —
 *   PR-FE-ACCOUNTING-FINANCIAL-MOVEMENTS-FRAMING
 *
 * Pins the framing/planning shell behavior of the Financial Movements
 * tracking page:
 *
 *   1. Page renders the title "تتبع الحركات المالية" + "مرحلة التوطير" badge.
 *   2. Renders the framing notice that no movements are created /
 *      modified / reversed from this page.
 *   3. All 5 KPI cards render with their Arabic labels — and EVERY
 *      monetary slot is the em-dash placeholder ("—"); zero numeric
 *      content anywhere on the page.
 *   4. مسارات التتبع section renders the 5 tracking paths with the
 *      "مخطط — غير منفّذ" badge and per-row disabled drilldowns.
 *   5. مصادر الحركة section renders the 7 source families with
 *      per-row disabled drilldowns.
 *   6. حالة الربط matrix renders 7 rows × 4 status columns; every
 *      status cell is the literal "غير مفعل".
 *   7. All 4 page-level CTAs are disabled buttons with "قريبًا"
 *      pills — negative regression guard against any executive
 *      action accidentally going live (trace / open log / export /
 *      view exceptions).
 *   8. Page does NOT import any API client (no network calls), no
 *      `useQuery` / `useMutation`, no FinancialEngine / engineApi /
 *      journalApi / postJournal references in actual code, AND no
 *      executive verbs (reverse / approve / postJournal as actual
 *      function calls — checked with word-boundary regex against
 *      comment-stripped source).
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import FinancialMovements from '@/pages/FinancialMovements';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/audit/financial-movements']}>
      <FinancialMovements />
    </MemoryRouter>,
  );
}

describe('<FinancialMovements /> — PR-FE-ACCOUNTING-FINANCIAL-MOVEMENTS-FRAMING', () => {
  // ─── 1. Title + stage badge ───────────────────────────────────
  it('renders the page title "تتبع الحركات المالية" and the "مرحلة التوطير" badge', () => {
    renderPage();
    const header = screen.getByTestId('financial-movements-header');
    expect(within(header).getByText('تتبع الحركات المالية')).toBeInTheDocument();
    const badge = screen.getByTestId('financial-movements-stage-badge');
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toBe('مرحلة التوطير');
  });

  // ─── 2. Framing notice ────────────────────────────────────────
  it('renders the read-only framing notice (no create / no edit / no reverse)', () => {
    renderPage();
    const notice = screen.getByTestId('financial-movements-framing-notice');
    expect(notice).toBeInTheDocument();
    expect(notice.textContent).toMatch(/للتأطير والمراجعة فقط/);
    expect(notice.textContent).toMatch(/لا يتم إنشاء أو تعديل أو عكس/);
  });

  // ─── 3. KPI cards — all 5 present, ZERO digits anywhere ───────
  it('renders all 5 KPI cards with Arabic labels', () => {
    renderPage();
    const kpis = screen.getByTestId('financial-movements-kpis');
    for (const label of [
      'حركات اليوم',
      'حركات بحاجة لمراجعة',
      'قيود مرتبطة',
      'حركات خزينة مرتبطة',
      'حركات مخزون مرتبطة',
    ]) {
      expect(within(kpis).getByText(label)).toBeInTheDocument();
    }
  });

  it.each([
    'today',
    'needs-review',
    'linked-journals',
    'linked-cashbox',
    'linked-inventory',
  ])('KPI card "%s" renders the em-dash placeholder and ZERO digits', (key) => {
    renderPage();
    const card = screen.getByTestId(`financial-movements-kpi-${key}`);
    expect(card.textContent).toMatch(/—/);
    // Defense-in-depth — no digit-bearing content (catches accidental
    // "0" or "0.00" placeholder that would imply a real computation).
    expect(card.textContent).not.toMatch(/\d/);
  });

  // ─── 4. مسارات التتبع section ────────────────────────────────
  it('renders مسارات التتبع section with 5 tracking paths + "مخطط — غير منفّذ"', () => {
    renderPage();
    const section = screen.getByTestId('financial-movements-paths');
    expect(within(section).getByText('مسارات التتبع')).toBeInTheDocument();
    expect(within(section).getByText('مخطط — غير منفّذ')).toBeInTheDocument();
    for (const key of [
      'invoice-to-journal',
      'payment-to-cashbox',
      'return-to-reverse',
      'count-to-stock-movement',
      'payroll-to-employee-entry',
    ]) {
      expect(
        screen.getByTestId(`financial-movements-path-${key}`),
      ).toBeInTheDocument();
    }
  });

  it.each([
    'invoice-to-journal',
    'payment-to-cashbox',
    'return-to-reverse',
    'count-to-stock-movement',
    'payroll-to-employee-entry',
  ])('tracking path drilldown "%s" is a disabled button (not a link)', (key) => {
    renderPage();
    const btn = screen.getByTestId(`financial-movements-path-drilldown-${key}`);
    expect(btn.tagName.toLowerCase()).toBe('button');
    expect(btn).toBeDisabled();
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.getAttribute('title')).toBe('متاح في تحديث لاحق');
    expect(btn.textContent).toMatch(/قريبًا/);
  });

  // ─── 5. مصادر الحركة section ────────────────────────────────
  it('renders مصادر الحركة section with 7 source families', () => {
    renderPage();
    const section = screen.getByTestId('financial-movements-sources');
    expect(within(section).getByText('مصادر الحركة')).toBeInTheDocument();
    for (const label of [
      'المبيعات',
      'المرتجعات',
      'المصروفات',
      'المشتريات',
      'الخزائن',
      'المخزون',
      'الموظفين والرواتب',
    ]) {
      expect(within(section).getByText(label)).toBeInTheDocument();
    }
  });

  it.each([
    'sales',
    'returns',
    'expenses',
    'purchases',
    'cashboxes',
    'inventory',
    'payroll',
  ])('source-family drilldown "%s" is a disabled button (not a link)', (key) => {
    renderPage();
    const btn = screen.getByTestId(`financial-movements-source-drilldown-${key}`);
    expect(btn.tagName.toLowerCase()).toBe('button');
    expect(btn).toBeDisabled();
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.getAttribute('title')).toBe('متاح في تحديث لاحق');
    expect(btn.textContent).toMatch(/قريبًا/);
  });

  // ─── 6. حالة الربط matrix — every status is "غير مفعل" ───────
  it('renders حالة الربط matrix with 7 rows + 4 status columns', () => {
    renderPage();
    const section = screen.getByTestId('financial-movements-link-status');
    expect(within(section).getByText('حالة الربط')).toBeInTheDocument();
    // Column headers — scope to the <thead> because two header
    // labels ("الخزينة" and "المخزون") happen to match row labels
    // that ARE legitimate Arabic terms for the same domain. Using
    // a <thead> scope keeps the assertion specific to the column
    // header without an ambiguity error.
    const thead = section.querySelector('thead') as HTMLElement | null;
    expect(thead).not.toBeNull();
    for (const header of ['المصدر', 'القيد', 'الخزينة', 'المخزون', 'حالة المراجعة']) {
      expect(within(thead as HTMLElement).getByText(header)).toBeInTheDocument();
    }
  });

  it.each([
    'sales',
    'returns',
    'expenses',
    'purchases',
    'cashboxes',
    'inventory',
    'payroll',
  ])('link-status row "%s" shows "غير مفعل" in all 4 status columns', (key) => {
    renderPage();
    const row = screen.getByTestId(`financial-movements-link-status-${key}`);
    expect(row).toBeInTheDocument();
    for (const col of ['journal', 'cashbox', 'inventory', 'review']) {
      const chip = within(row).getByTestId(
        `financial-movements-link-${col}-${key}`,
      );
      expect(chip.textContent).toBe('غير مفعل');
    }
  });

  // ─── 7. CTAs are disabled — NEGATIVE REGRESSION ──────────────
  it.each([
    { key: 'trace-movement', label: 'تتبع حركة' },
    { key: 'open-review-log', label: 'فتح سجل المراجعة' },
    { key: 'export-trace', label: 'تصدير أثر الحركة' },
    { key: 'view-exceptions', label: 'عرض الاستثناءات' },
  ])('CTA "$label" is rendered DISABLED with a "قريبًا" pill', ({ key, label }) => {
    renderPage();
    const cta = screen.getByTestId(`financial-movements-cta-${key}`);
    expect(cta.tagName.toLowerCase()).toBe('button');
    expect(cta).toBeDisabled();
    expect(cta.getAttribute('aria-disabled')).toBe('true');
    expect(cta.getAttribute('title')).toBe('متاح في تحديث لاحق');
    expect(cta.textContent).toMatch(label);
    expect(cta.textContent).toMatch(/قريبًا/);
  });

  // ─── 8. Page source has zero API imports + zero executive verbs ─
  it('page source imports zero API clients (no network in framing phase)', () => {
    // Same pattern as Zakat.framing + FinancialReports.framing —
    // strip /* ... */ and // ... line comments before scanning so
    // the page's own negative-control header (which legitimately
    // MENTIONS strings like "FinancialEngine" / "reverse" / "void"
    // / "approve" / "post" to document what the page intentionally
    // does NOT do) doesn't false-trigger these regex guards. Only
    // actual code paths are checked.
    const src = readFileSync('src/pages/FinancialMovements.tsx', 'utf-8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    // No `import ... from '@/api/...'` and no react-query data hooks.
    expect(code).not.toMatch(/from ['"]@\/api\//);
    expect(code).not.toMatch(/\buseQuery\b|\buseMutation\b/);

    // No FinancialEngine / engineApi / journal-API / postJournal.
    expect(code).not.toMatch(/\bFinancialEngine\b/);
    expect(code).not.toMatch(/\bengineApi\.\w+/);
    expect(code).not.toMatch(/\bjournalApi\.\w+/);
    expect(code).not.toMatch(/\bpostJournal\b/);

    // No executive verbs as actual function calls. The regex looks
    // for the verb followed by `(`, which catches `reverse(...)`,
    // `voidThing(...)`, `approve(...)`, `postSomething(...)` while
    // letting English nouns inside string literals or identifiers
    // pass — the page intentionally uses words like "reverse" /
    // "void" inside Arabic copy and JSX labels.
    expect(code).not.toMatch(/\breverse\(/);
    expect(code).not.toMatch(/\bvoid[A-Z]\w*\(/);
    expect(code).not.toMatch(/\bapprove\(/);
    expect(code).not.toMatch(/\bpost[A-Z]\w*\(/);
  });
});
