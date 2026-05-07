/**
 * Zakat.framing.test.tsx — PR-FE-ACCOUNTING-ZAKAT-FRAMING
 *
 * Pins the framing/planning shell behavior of the Zakat page:
 *
 *   1. Page renders the title "الزكاة" + "مرحلة التوطير" badge.
 *   2. Renders the framing notice that no journal entries / accounting
 *      approvals happen from this page.
 *   3. All 5 KPI cards render with their Arabic labels — and ONLY
 *      "نسبة الزكاة" carries a numeric-looking literal (the visual
 *      default 2.5%); the other 4 KPIs render the EM-DASH placeholder
 *      ("—"), proving no fake numbers are surfaced.
 *   4. Settings / pool-components sections render with "قريبًا" pills.
 *   5. Pool-component drilldowns are disabled buttons (NOT links).
 *   6. All 3 page-level CTAs are disabled buttons with "قريبًا"
 *      pills — negative regression guard against any executive
 *      action accidentally going live.
 *   7. Page does NOT import any API client (no network calls).
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import Zakat from '@/pages/Zakat';

function renderZakat() {
  return render(
    <MemoryRouter initialEntries={['/finance/zakat']}>
      <Zakat />
    </MemoryRouter>,
  );
}

describe('<Zakat /> — PR-FE-ACCOUNTING-ZAKAT-FRAMING', () => {
  // ─── 1. Title + stage badge ───────────────────────────────────
  it('renders the page title "الزكاة" and the "مرحلة التوطير" badge', () => {
    renderZakat();
    const header = screen.getByTestId('zakat-header');
    expect(within(header).getByText('الزكاة')).toBeInTheDocument();
    const badge = screen.getByTestId('zakat-stage-badge');
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toBe('مرحلة التوطير');
  });

  // ─── 2. Framing notice ────────────────────────────────────────
  it('renders the read-only framing notice (no JE/no approvals)', () => {
    renderZakat();
    const notice = screen.getByTestId('zakat-framing-notice');
    expect(notice).toBeInTheDocument();
    expect(notice.textContent).toMatch(/للتأطير والمراجعة فقط/);
    expect(notice.textContent).toMatch(/لا يتم إنشاء قيود/);
  });

  // ─── 3. KPI cards — all 5 present, only "rate" carries a numeric literal
  it('renders all 5 KPI cards with Arabic labels', () => {
    renderZakat();
    const kpis = screen.getByTestId('zakat-kpis');
    for (const label of [
      'وعاء الزكاة',
      'الأصول الزكوية',
      'الالتزامات المخصومة',
      'نسبة الزكاة',
      'الزكاة المقدّرة',
    ]) {
      expect(within(kpis).getByText(label)).toBeInTheDocument();
    }
  });

  it('only the rate KPI carries a numeric literal (2.5%) — every other KPI is the em-dash placeholder', () => {
    renderZakat();
    // The rate card is the only one that intentionally surfaces a
    // visual numeric default. All other monetary KPIs MUST render
    // the em-dash placeholder so the operator never sees a fake
    // computed amount.
    const rateCard = screen.getByTestId('zakat-kpi-rate');
    expect(rateCard.textContent).toMatch(/2\.5%/);

    for (const key of ['pool', 'assets', 'liabilities', 'estimated']) {
      const card = screen.getByTestId(`zakat-kpi-${key}`);
      // The amount slot inside each non-rate card is the em dash.
      expect(card.textContent).toMatch(/—/);
      // And explicitly NO digit-bearing content (defense in depth —
      // catches any accidental "0" or "0.00" placeholder).
      expect(card.textContent).not.toMatch(/\d/);
    }
  });

  // ─── 4. Settings + pool-components sections render ────────────
  it('renders the settings section with the "قريبًا" pill', () => {
    renderZakat();
    const settings = screen.getByTestId('zakat-settings');
    expect(within(settings).getByText('إعدادات الزكاة')).toBeInTheDocument();
    expect(within(settings).getByText('قريبًا')).toBeInTheDocument();
    expect(
      within(settings).getByText('نسبة الزكاة الافتراضية'),
    ).toBeInTheDocument();
    expect(within(settings).getByText('بداية / نهاية الحول')).toBeInTheDocument();
    expect(within(settings).getByText('طريقة الاحتساب')).toBeInTheDocument();
  });

  it('renders the 5 pool-component rows with the "مخطط — غير منفّذ" badge', () => {
    renderZakat();
    const pool = screen.getByTestId('zakat-pool-components');
    expect(within(pool).getByText('مكونات الوعاء')).toBeInTheDocument();
    expect(within(pool).getByText('مخطط — غير منفّذ')).toBeInTheDocument();
    for (const label of [
      'النقدية والخزائن',
      'البنوك والمحافظ',
      'المخزون',
      'الذمم المدينة',
      'الالتزامات المؤهلة للخصم',
    ]) {
      expect(within(pool).getByText(label)).toBeInTheDocument();
    }
  });

  // ─── 5. Pool drilldowns are disabled buttons ──────────────────
  it.each([
    'cash',
    'bank_wallet',
    'inventory',
    'receivables',
    'liabilities',
  ])('pool drilldown for "%s" is a disabled button (not a link)', (key) => {
    renderZakat();
    const btn = screen.getByTestId(`zakat-pool-drilldown-${key}`);
    expect(btn.tagName.toLowerCase()).toBe('button');
    expect(btn).toBeDisabled();
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.getAttribute('title')).toBe('متاح في تحديث لاحق');
    expect(btn.textContent).toMatch(/قريبًا/);
  });

  // ─── 6. CTAs are disabled — NEGATIVE REGRESSION ───────────────
  it.each([
    { key: 'setup-rules', label: 'إعداد قواعد الزكاة' },
    { key: 'dry-run', label: 'حساب تجريبي' },
    { key: 'export-report', label: 'تصدير تقرير الزكاة' },
  ])('CTA "$label" is rendered DISABLED with a "قريبًا" pill', ({ key, label }) => {
    renderZakat();
    const cta = screen.getByTestId(`zakat-cta-${key}`);
    expect(cta.tagName.toLowerCase()).toBe('button');
    expect(cta).toBeDisabled();
    expect(cta.getAttribute('aria-disabled')).toBe('true');
    expect(cta.getAttribute('title')).toBe('متاح في تحديث لاحق');
    expect(cta.textContent).toMatch(label);
    expect(cta.textContent).toMatch(/قريبًا/);
  });

  // ─── 7. Page source has zero API imports ──────────────────────
  // Defense-in-depth — read the file off disk and assert it does not
  // import from `@/api/*`. This guards against a future contributor
  // accidentally wiring up a fetch in the framing PR.
  it('page source imports zero API clients (no network in framing phase)', () => {
    // Same pattern as FinanceStatements.test.tsx — read relative to
    // the vitest CWD (which is `frontend/`). We strip /* ... */ and
    // // ... line comments before scanning so the page's own
    // negative-control header comment (which legitimately MENTIONS
    // strings like "FinancialEngine" / "journal entries" to document
    // what the page intentionally does NOT do) doesn't false-trigger
    // these regex guards. Only actual code paths are checked.
    const src = readFileSync('src/pages/Zakat.tsx', 'utf-8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    // No `import ... from '@/api/...'` and no react-query data hooks.
    expect(code).not.toMatch(/from ['"]@\/api\//);
    expect(code).not.toMatch(/\buseQuery\b|\buseMutation\b/);

    // No FinancialEngine class import / instantiation, no engineApi
    // method calls, no journal-API method calls or postJournal helper.
    expect(code).not.toMatch(/\bFinancialEngine\b/);
    expect(code).not.toMatch(/\bengineApi\.\w+/);
    expect(code).not.toMatch(/\bjournalApi\.\w+/);
    expect(code).not.toMatch(/\bpostJournal\b/);
  });
});
