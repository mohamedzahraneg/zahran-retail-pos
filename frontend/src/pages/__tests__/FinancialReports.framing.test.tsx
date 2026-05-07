/**
 * FinancialReports.framing.test.tsx
 * ────────────────────────────────────────────────────────────────────
 *
 * Pins the central reporting-hub behavior of the Financial Reports
 * page (PR-FE-ACCOUNTING-FINANCIAL-REPORTS-HUB) AND the read-only
 * framing-shell guarantees inherited from the original framing PR
 * (#326).
 *
 * The page is a STATIC catalog — every report card either links to
 * an existing operational page (`<Link>`) or renders disabled
 * (`<div role="group" aria-disabled="true">`). It performs ZERO
 * data fetching, ZERO mutations, ZERO computed amounts.
 *
 * What this test pins:
 *   1. Title + two badges ("مرحلة التوطير" + "مركز التقارير").
 *   2. Framing notice present.
 *   3. Status totals strip (4 cards: ready / read_only / planned / needs_data).
 *   4. Filter bar: search input + category select + status select.
 *   5. All 10 category sections render their headings.
 *   6. Sample report cards:
 *        · "ready" cards render as `<a>` with correct href.
 *        · "planned" cards render as a non-anchor disabled element.
 *   7. Search input actually filters (typing a unique term collapses
 *      everything else).
 *   8. Status filter actually filters (e.g. picking "planned" hides
 *      "ready" cards).
 *   9. Empty state renders when filters yield no matches.
 *  10. Negative regressions:
 *        · page source has zero `@/api` imports
 *        · no `useQuery` / `useMutation` / `mutationFn` / `.mutate(`
 *        · no `FinancialEngine` / `engineApi` / `journalApi` / `postJournal`
 *        · no executive-verb function calls
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
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

describe('<FinancialReports /> — central reporting hub', () => {
  // ─── 1. Title + two badges ────────────────────────────────────
  it('renders the page title and both badges', () => {
    renderPage();
    const header = screen.getByTestId('financial-reports-header');
    expect(within(header).getByText('التقارير المالية')).toBeInTheDocument();

    const stage = screen.getByTestId('financial-reports-stage-badge');
    expect(stage.textContent).toBe('مرحلة التوطير');

    const hub = screen.getByTestId('financial-reports-hub-badge');
    expect(hub.textContent).toBe('مركز التقارير');
  });

  // ─── 2. Framing notice ────────────────────────────────────────
  it('renders the read-only framing notice', () => {
    renderPage();
    const notice = screen.getByTestId('financial-reports-framing-notice');
    expect(notice).toBeInTheDocument();
    expect(notice.textContent).toMatch(/للتأطير والمراجعة فقط/);
    expect(notice.textContent).toMatch(/لا يتم إنشاء قيود/);
    expect(notice.textContent).toMatch(/كل الروابط للقراءة فقط/);
  });

  // ─── 3. Totals strip (4 cards) ────────────────────────────────
  it('renders the 4-card status totals strip with positive counts', () => {
    renderPage();
    for (const key of ['ready', 'read-only', 'planned', 'needs-data']) {
      const card = screen.getByTestId(`financial-reports-total-${key}`);
      expect(card).toBeInTheDocument();
      // Each totals card must show a non-empty digit (the catalog has
      // multiple reports in every status bucket).
      expect(card.textContent).toMatch(/\d/);
    }
  });

  // ─── 4. Filter bar ────────────────────────────────────────────
  it('renders the filter bar (search + category + status)', () => {
    renderPage();
    expect(
      screen.getByTestId('financial-reports-filter-bar'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('financial-reports-search-input'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('financial-reports-category-filter'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('financial-reports-status-filter'),
    ).toBeInTheDocument();
    // Clear button appears only when filters are active — not yet.
    expect(
      screen.queryByTestId('financial-reports-clear-filters'),
    ).toBeNull();
  });

  // ─── 5. All 10 category sections ──────────────────────────────
  it.each([
    'accounting',
    'sales',
    'purchases',
    'inventory',
    'cash_payments',
    'customers_receivables',
    'suppliers_payables',
    'expenses',
    'payroll_employees',
    'operations_audit',
  ])('section "%s" renders', (key) => {
    renderPage();
    expect(
      screen.getByTestId(`financial-reports-section-${key}`),
    ).toBeInTheDocument();
  });

  // ─── 6. Card rendering — ready vs planned ────────────────────
  it('a "ready" card (trial-balance) renders as <a> with the correct href', () => {
    renderPage();
    const card = screen.getByTestId('financial-reports-card-trial-balance');
    expect(card.tagName.toLowerCase()).toBe('a');
    expect((card as HTMLAnchorElement).getAttribute('href')).toBe('/accounts');
    const status = screen.getByTestId(
      'financial-reports-card-status-trial-balance',
    );
    expect(status.textContent).toBe('جاهز');
  });

  it('a "read_only" card (zakat-tax) renders as <a> linking to /finance/zakat', () => {
    renderPage();
    const card = screen.getByTestId('financial-reports-card-zakat-tax');
    expect(card.tagName.toLowerCase()).toBe('a');
    expect((card as HTMLAnchorElement).getAttribute('href')).toBe(
      '/finance/zakat',
    );
    const status = screen.getByTestId(
      'financial-reports-card-status-zakat-tax',
    );
    expect(status.textContent).toBe('قراءة فقط');
  });

  it('a "planned" card (sales-by-category) renders as a non-anchor disabled element', () => {
    renderPage();
    const card = screen.getByTestId(
      'financial-reports-card-sales-by-category',
    );
    expect(card.tagName.toLowerCase()).not.toBe('a');
    expect(card.getAttribute('aria-disabled')).toBe('true');
    expect(card.getAttribute('title')).toBe('متاح في تحديث لاحق');
    expect(card.textContent).toMatch(/قريبًا/);
    const status = screen.getByTestId(
      'financial-reports-card-status-sales-by-category',
    );
    expect(status.textContent).toBe('مخطط');
  });

  it('a "needs_data" card (sales-vat) renders as a non-anchor disabled element', () => {
    renderPage();
    const card = screen.getByTestId('financial-reports-card-sales-vat');
    expect(card.tagName.toLowerCase()).not.toBe('a');
    expect(card.getAttribute('aria-disabled')).toBe('true');
    const status = screen.getByTestId(
      'financial-reports-card-status-sales-vat',
    );
    expect(status.textContent).toBe('يحتاج بيانات');
  });

  // ─── 7. Search filter ─────────────────────────────────────────
  it('typing a unique search term filters down to the matching card', () => {
    renderPage();
    // Pre-condition: a card the search will FIND ("ميزان المراجعة").
    expect(
      screen.queryByTestId('financial-reports-card-trial-balance'),
    ).toBeInTheDocument();
    // Pre-condition: a card the search will HIDE ("ملخص المبيعات").
    expect(
      screen.queryByTestId('financial-reports-card-sales-summary'),
    ).toBeInTheDocument();

    const input = screen.getByTestId(
      'financial-reports-search-input',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'ميزان' } });

    // Trial balance still visible.
    expect(
      screen.queryByTestId('financial-reports-card-trial-balance'),
    ).toBeInTheDocument();
    // Sales summary now hidden.
    expect(
      screen.queryByTestId('financial-reports-card-sales-summary'),
    ).toBeNull();
    // Clear-filters button appears when filters are active.
    expect(
      screen.getByTestId('financial-reports-clear-filters'),
    ).toBeInTheDocument();
  });

  // ─── 8. Status filter ─────────────────────────────────────────
  it('selecting status="planned" hides "ready" cards', () => {
    renderPage();
    expect(
      screen.queryByTestId('financial-reports-card-trial-balance'),
    ).toBeInTheDocument(); // ready
    expect(
      screen.queryByTestId('financial-reports-card-sales-by-category'),
    ).toBeInTheDocument(); // planned

    const select = screen.getByTestId(
      'financial-reports-status-filter',
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'planned' } });

    // Ready cards hidden.
    expect(
      screen.queryByTestId('financial-reports-card-trial-balance'),
    ).toBeNull();
    // Planned cards still visible.
    expect(
      screen.queryByTestId('financial-reports-card-sales-by-category'),
    ).toBeInTheDocument();
  });

  // ─── 9. Empty state ───────────────────────────────────────────
  it('renders the empty state when filters yield no matches', () => {
    renderPage();
    const input = screen.getByTestId(
      'financial-reports-search-input',
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: 'XX_NO_REPORT_MATCHES_THIS_QUERY_XX' },
    });
    const empty = screen.getByTestId('financial-reports-empty');
    expect(empty).toBeInTheDocument();
    expect(empty.textContent).toMatch(/لا توجد تقارير/);
  });

  // ─── 10. Source scan — no API surface, no executive verbs ────
  it('page source has no API imports, no mutation surface, no engine touches, no executive-verb calls', () => {
    const src = readFileSync('src/pages/FinancialReports.tsx', 'utf-8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    expect(code).not.toMatch(/from ['"]@\/api\//);
    expect(code).not.toMatch(/\buseQuery\b|\buseMutation\b/);
    expect(code).not.toMatch(/\bmutationFn\b/);
    expect(code).not.toMatch(/\.mutate\(/);
    expect(code).not.toMatch(/\bFinancialEngine\b/);
    expect(code).not.toMatch(/\bengineApi\.\w+/);
    expect(code).not.toMatch(/\bjournalApi\.\w+/);
    expect(code).not.toMatch(/\bpostJournal\b/);

    // Executive-verb function calls — same pattern used by the other
    // framing pages. The page may legitimately mention "approve" /
    // "post" / "submit" inside Arabic copy and JSX labels (e.g. report
    // descriptions); we only reject ACTUAL function calls (verb
    // followed by `(`).
    expect(code).not.toMatch(/\bapprove\(/);
    expect(code).not.toMatch(/\bpay\(/);
    expect(code).not.toMatch(/\bsubmit\(/);
    expect(code).not.toMatch(/\breverse\(/);
    expect(code).not.toMatch(/\bvoid[A-Z]\w*\(/);
    expect(code).not.toMatch(/\bpost[A-Z]\w*\(/);
  });
});
