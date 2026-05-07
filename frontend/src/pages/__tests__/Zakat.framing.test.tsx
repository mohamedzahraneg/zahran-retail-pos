/**
 * Zakat.framing.test.tsx — PR-FE-ACCOUNTING-ZAKAT-FRAMING (header)
 *                       + PR-FE-ACCOUNTING-ZAKAT-DATA-SOURCES (this PR)
 *
 * Pins the read-only data-source readiness behavior of the Zakat
 * page. Builds on the original framing-shell contract (PR #325) and
 * extends it for the new sections introduced by this PR.
 *
 * Original framing-shell guarantees still pinned:
 *   1. Title "الزكاة" + "مرحلة التوطير" badge present.
 *   2. Framing notice that no journal entries / accounting
 *      approvals happen from this page.
 *   3. All 5 KPI cards render with their Arabic labels — and ONLY
 *      "نسبة الزكاة" carries a numeric-looking literal (the visual
 *      default 2.5%); the other 4 KPIs render the EM-DASH placeholder.
 *   4. Settings section renders with "قريبًا" pill.
 *   5. Pool-component rows present (5 of them).
 *   6. All 3 page-level CTAs are disabled buttons (negative
 *      regression guard against any executive action going live).
 *
 * NEW guarantees added by PR-FE-ACCOUNTING-ZAKAT-DATA-SOURCES:
 *   7. Header carries the new "ربط مصادر البيانات" badge alongside
 *      the existing "مرحلة التوطير" badge.
 *   8. Secondary source-data notice present, clarifying that any
 *      numbers shown represent source data, not a confirmed pool.
 *   9. New "جاهزية مصادر الوعاء الزكوي" matrix renders 5 rows with
 *      their classification pills (جاهز للربط / جزئي / غير مربوط).
 *  10. Pool drilldowns: 4 of 5 (cash, bank_wallet, receivables,
 *      liabilities) are now active <a> links pointing at existing
 *      operational routes; "inventory" stays a disabled <button>
 *      because no aggregate-valuation page exists today.
 *  11. CTA tooltip changed to "يتطلب اعتماد مصادر البيانات أولًا".
 *  12. Page source still imports ZERO @/api clients (we deliberately
 *      avoid useQuery so that no aggregate number can be misread as
 *      a "zakat pool"). The matrix is purely descriptive.
 *  13. NO mutation surface: no `useMutation`, no `mutationFn`, no
 *      `mutate(`, no executive-verb function calls.
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

describe('<Zakat /> — framing + data-source readiness', () => {
  // ─── 1. Title + stage badge ───────────────────────────────────
  it('renders the page title "الزكاة" and the "مرحلة التوطير" badge', () => {
    renderZakat();
    const header = screen.getByTestId('zakat-header');
    expect(within(header).getByText('الزكاة')).toBeInTheDocument();
    const badge = screen.getByTestId('zakat-stage-badge');
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toBe('مرحلة التوطير');
  });

  // ─── 1b. NEW: data-sources badge alongside stage badge ─────────
  it('renders the new "ربط مصادر البيانات" badge alongside the stage badge', () => {
    renderZakat();
    const badge = screen.getByTestId('zakat-data-sources-badge');
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toMatch(/ربط مصادر البيانات/);
  });

  // ─── 2. Framing notice (existing) ─────────────────────────────
  it('renders the read-only framing notice (no JE/no approvals)', () => {
    renderZakat();
    const notice = screen.getByTestId('zakat-framing-notice');
    expect(notice).toBeInTheDocument();
    expect(notice.textContent).toMatch(/للتأطير والمراجعة فقط/);
    expect(notice.textContent).toMatch(/لا يتم إنشاء قيود/);
  });

  // ─── 2b. NEW: secondary source-data notice ────────────────────
  it('renders the secondary source-data notice (numbers ≠ approved pool)', () => {
    renderZakat();
    const notice = screen.getByTestId('zakat-source-data-notice');
    expect(notice).toBeInTheDocument();
    expect(notice.textContent).toMatch(/الأرقام المعروضة/);
    expect(notice.textContent).toMatch(/مصادر بيانات أولية/);
    expect(notice.textContent).toMatch(/وعاءً زكويًا معتمدًا/);
  });

  // ─── 3. KPI cards — all 5 present ─────────────────────────────
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
    const rateCard = screen.getByTestId('zakat-kpi-rate');
    expect(rateCard.textContent).toMatch(/2\.5%/);

    for (const key of ['pool', 'assets', 'liabilities', 'estimated']) {
      const card = screen.getByTestId(`zakat-kpi-${key}`);
      expect(card.textContent).toMatch(/—/);
      // Defense-in-depth — no digit-bearing content (catches any
      // accidental "0" or "0.00" placeholder).
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

  // ─── 5. Pool drilldowns — 4 active links + 1 disabled ────────
  // Inventory has no aggregate-valuation page in the app today, so
  // it stays as a disabled <button>. The other four point at safe
  // read-only operational pages.
  it.each([
    { key: 'cash', route: '/cashboxes' },
    { key: 'bank_wallet', route: '/cashboxes' },
    { key: 'receivables', route: '/customers' },
    { key: 'liabilities', route: '/suppliers' },
  ])(
    'pool drilldown "$key" is an active <a> link pointing to "$route"',
    ({ key, route }) => {
      renderZakat();
      const el = screen.getByTestId(`zakat-pool-drilldown-${key}`);
      expect(el.tagName.toLowerCase()).toBe('a');
      expect((el as HTMLAnchorElement).getAttribute('href')).toBe(route);
      // Must NOT carry the "قريبًا" pill — it's an active link.
      expect(el.textContent).not.toMatch(/قريبًا/);
    },
  );

  it('pool drilldown "inventory" remains a disabled <button> (no valuation page exists)', () => {
    renderZakat();
    const btn = screen.getByTestId('zakat-pool-drilldown-inventory');
    expect(btn.tagName.toLowerCase()).toBe('button');
    expect(btn).toBeDisabled();
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.getAttribute('title')).toBe('متاح في تحديث لاحق');
    expect(btn.textContent).toMatch(/قريبًا/);
  });

  // ─── 6. NEW: Readiness matrix ────────────────────────────────
  it('renders the "جاهزية مصادر الوعاء الزكوي" readiness matrix with 5 rows', () => {
    renderZakat();
    const section = screen.getByTestId('zakat-readiness');
    expect(within(section).getByText('جاهزية مصادر الوعاء الزكوي')).toBeInTheDocument();
    // Column headers (scoped to <thead> because some labels overlap
    // with row content elsewhere on the page).
    const thead = section.querySelector('thead') as HTMLElement | null;
    expect(thead).not.toBeNull();
    for (const header of [
      'المكوّن',
      'مصدر البيانات',
      'حالة الربط',
      'مستوى الثقة',
      'الإجراء القادم',
    ]) {
      expect(within(thead as HTMLElement).getByText(header)).toBeInTheDocument();
    }
    // 5 readiness rows
    for (const key of ['cash', 'bank_wallet', 'inventory', 'receivables', 'liabilities']) {
      expect(screen.getByTestId(`zakat-readiness-${key}`)).toBeInTheDocument();
    }
  });

  it.each([
    { key: 'cash', expected: 'جاهز للربط' },
    { key: 'bank_wallet', expected: 'جزئي' },
    { key: 'inventory', expected: 'غير مربوط' },
    { key: 'receivables', expected: 'جزئي' },
    { key: 'liabilities', expected: 'جزئي' },
  ])('readiness row "$key" shows the "$expected" status pill', ({ key, expected }) => {
    renderZakat();
    const pill = screen.getByTestId(`zakat-readiness-status-${key}`);
    expect(pill.textContent).toBe(expected);
  });

  // The matrix MUST NOT surface any computed numeric amount per row
  // — readiness is descriptive only. This is the strongest guard
  // against accidentally wiring a formula in this PR.
  it('readiness matrix carries ZERO digit-bearing cells (descriptive only)', () => {
    renderZakat();
    const section = screen.getByTestId('zakat-readiness');
    const tbody = section.querySelector('tbody') as HTMLElement | null;
    expect(tbody).not.toBeNull();
    expect(tbody!.textContent ?? '').not.toMatch(/\d/);
  });

  // ─── 7. CTAs disabled — NEGATIVE REGRESSION ──────────────────
  it.each([
    { key: 'setup-rules', label: 'إعداد قواعد الزكاة' },
    { key: 'dry-run', label: 'حساب تجريبي' },
    { key: 'export-report', label: 'تصدير تقرير الزكاة' },
  ])('CTA "$label" is rendered DISABLED with the readiness-gate tooltip', ({ key, label }) => {
    renderZakat();
    const cta = screen.getByTestId(`zakat-cta-${key}`);
    expect(cta.tagName.toLowerCase()).toBe('button');
    expect(cta).toBeDisabled();
    expect(cta.getAttribute('aria-disabled')).toBe('true');
    // PR-FE-ACCOUNTING-ZAKAT-DATA-SOURCES — tooltip changed.
    expect(cta.getAttribute('title')).toBe(
      'يتطلب اعتماد مصادر البيانات أولًا',
    );
    expect(cta.textContent).toMatch(label);
    expect(cta.textContent).toMatch(/قريبًا/);
  });

  // ─── 8. Page source — zero API imports + zero mutation surface ─
  // Read the file off disk and assert: no `@/api/*` imports, no
  // react-query data hooks, no FinancialEngine / engineApi /
  // journalApi / postJournal references in actual code, and no
  // executive-verb function calls. Comments stripped first so the
  // page's own negative-control header (which legitimately MENTIONS
  // these terms to document what the page does NOT do) doesn't
  // false-trigger these regex guards.
  it('page source has no API imports, no mutation surface, no engine touches, no executive-verb calls', () => {
    const src = readFileSync('src/pages/Zakat.tsx', 'utf-8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    // No `@/api/*` imports.
    expect(code).not.toMatch(/from ['"]@\/api\//);

    // No react-query data hooks (we deliberately stayed off them in
    // this PR). If a follow-up wires real source-data balances, that
    // will be a clearly-scoped separate change.
    expect(code).not.toMatch(/\buseQuery\b|\buseMutation\b/);
    expect(code).not.toMatch(/\bmutationFn\b/);
    expect(code).not.toMatch(/\.mutate\(/);

    // No FinancialEngine / engineApi / journalApi / postJournal in code.
    expect(code).not.toMatch(/\bFinancialEngine\b/);
    expect(code).not.toMatch(/\bengineApi\.\w+/);
    expect(code).not.toMatch(/\bjournalApi\.\w+/);
    expect(code).not.toMatch(/\bpostJournal\b/);

    // Executive-verb function calls — same word-boundary regex
    // family used by FinancialMovements.framing. The page may
    // mention these verbs inside Arabic copy and JSX labels (e.g.
    // CTA descriptions) — that's fine; we only reject ACTUAL
    // function calls (verb followed by `(`).
    expect(code).not.toMatch(/\bapprove\(/);
    expect(code).not.toMatch(/\bpay\(/);
    expect(code).not.toMatch(/\bsubmit\(/);
    expect(code).not.toMatch(/\breverse\(/);
    expect(code).not.toMatch(/\bvoid[A-Z]\w*\(/);
    expect(code).not.toMatch(/\bpost[A-Z]\w*\(/);
  });
});
