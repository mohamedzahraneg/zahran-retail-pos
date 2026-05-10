/**
 * FinanceStatements.ux.test.tsx — PR-FIN-3-UX
 *
 * Behaviour + source-grep tests pinning the Account Statements UX
 * cleanup:
 *
 *   1. Header order — title is rendered BEFORE the actions cluster
 *      in DOM order, so RTL flex layout puts it on the right at all
 *      breakpoints (no `lg:order-*` swap that flipped it left at
 *      desktop sizes).
 *   2. StatementTable.Th uses static text-align classes (`text-right`
 *      / `text-left` / `text-center`); the dynamic `text-${align}`
 *      pattern is forbidden because Tailwind's build-time class
 *      scanner cannot detect it.
 *   3. Empty-state shows three numbered actionable steps.
 *   4. Date-preset buttons set from/to in one click (Cairo time).
 *   5. Print + Excel are demoted out of the page header into the
 *      filter bar's secondary actions cluster, and stay disabled
 *      until both an entity AND rows exist (in addition to the
 *      PR-FIN-7-pending hardcode).
 *   6. confidence.note is surfaced as an info banner above the table
 *      when rows exist (in-place inside the empty-state otherwise).
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FinanceStatements, presetRange } from '@/pages/FinanceStatements';
import type { StatementResponse } from '@/api/statements.api';

// ─── Mocks (mirror the existing FinanceStatements.test.tsx setup) ──

let fixture: StatementResponse;

vi.mock('@/api/statements.api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    statementsApi: {
      glAccount: vi.fn(async () => fixture),
      cashbox: vi.fn(async () => fixture),
      employee: vi.fn(async () => fixture),
      customer: vi.fn(async () => fixture),
      supplier: vi.fn(async () => fixture),
    },
  };
});
vi.mock('@/api/accounts.api', () => ({
  accountsApi: {
    list: vi.fn(async () => [
      { id: 'acc-1', code: '1111', name_ar: 'الخزينة', is_leaf: true, is_active: true, account_type: 'asset' },
    ]),
  },
}));
vi.mock('@/api/cash-desk.api', () => ({
  cashDeskApi: {
    cashboxes: vi.fn(async () => [
      { id: 'cb-1', name_ar: 'الخزينة الرئيسية', kind: 'cash', is_active: true },
    ]),
  },
}));
vi.mock('@/api/customers.api', () => ({
  customersApi: { list: vi.fn(async () => ({ data: [] })) },
}));
vi.mock('@/api/suppliers.api', () => ({
  suppliersApi: { list: vi.fn(async () => []) },
}));
vi.mock('@/api/users.api', () => ({
  usersApi: { list: vi.fn(async () => []) },
}));

function buildFixture(overrides: Partial<StatementResponse> = {}): StatementResponse {
  return {
    entity: {
      type: 'gl_account',
      id: 'acc-1',
      code: '1111',
      name_ar: 'الخزينة',
      name_en: null,
      extra: null,
    },
    range: { from: '2026-04-01', to: '2026-04-28' },
    opening_balance: 100,
    closing_balance: 250,
    totals: { debit: 200, credit: 50, net: 150, lines: 2 },
    rows: [
      {
        occurred_at: '2026-04-05T10:00:00Z',
        event_date: '2026-04-05',
        description: 'بيع',
        reference_type: 'invoice',
        reference_no: 'INV-001',
        debit: 100,
        credit: 0,
        running_balance: 200,
        counterparty: 'عميل نقدي',
        journal_entry_no: 'JE-001',
        drilldown_url: null,
        is_voided: false,
      },
      {
        occurred_at: '2026-04-10T10:00:00Z',
        event_date: '2026-04-10',
        description: 'مصروف',
        reference_type: 'expense',
        reference_no: 'EXP-001',
        debit: 0,
        credit: 50,
        running_balance: 150,
        counterparty: 'مورد',
        journal_entry_no: null,
        drilldown_url: null,
        is_voided: false,
      },
    ],
    confidence: { has_data: true, data_source: 'gl_lines', note: null, context: null },
    generated_at: '2026-04-28T10:00:00Z',
    ...overrides,
  };
}

function renderPage() {
  fixture = buildFixture();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <FinanceStatements />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ─── 1. Header order — title on the right (RTL) ─────────────────────

describe('FinanceStatements — header layout (PR-FIN-3-UX bug #1)', () => {
  it('title renders before the refresh button in DOM order (RTL → title on the right)', () => {
    renderPage();
    const header = screen.getByTestId('statements-header');
    const title = screen.getByText('كشف الحسابات');
    const refresh = screen.getByTestId('statements-refresh-btn');

    // Both live inside the page header.
    expect(header.contains(title)).toBe(true);
    expect(header.contains(refresh)).toBe(true);

    // Authoritative ordering check — RTL flex with `justify-between`
    // and order-1/order-2 puts the source-order-first element on the
    // right.  The title must come BEFORE the refresh button in DOM
    // order so the layout renders title-right / actions-left at every
    // breakpoint (no `lg:order-*` swap that flipped it left at desktop).
    expect(
      title.compareDocumentPosition(refresh) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('header className stays under dir="rtl" and uses no lg:order-* swap classes', () => {
    const src = readFileSync(
      resolve(__dirname, '../../../../pages/FinanceStatements.tsx'),
      'utf-8',
    );
    // No `lg:order-1` or `lg:order-2` — those caused the desktop-only
    // title-on-the-left bug.
    expect(src).not.toMatch(/\blg:order-1\b/);
    expect(src).not.toMatch(/\blg:order-2\b/);
    // Outer container still RTL.
    expect(src).toMatch(/dir="rtl"/);
  });
});

// ─── 2. StatementTable.Th — static text-align ───────────────────────

describe('StatementTable.Th — static alignment classes (PR-FIN-3-UX bug #2)', () => {
  const TABLE_SRC = readFileSync(
    resolve(__dirname, '../StatementTable.tsx'),
    'utf-8',
  );
  // Strip comments before grepping for forbidden patterns — the
  // docstring above the Th component intentionally cites the bad
  // pattern as an example, and we don't want that to trip the test.
  const TABLE_CODE = TABLE_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('does NOT use dynamic `text-${align}` Tailwind class in non-comment code', () => {
    expect(TABLE_CODE).not.toMatch(/text-\$\{/);
  });

  it('emits literal `text-right` and `text-left` so Tailwind can purge correctly', () => {
    expect(TABLE_CODE).toMatch(/['"`]text-right['"`]/);
    expect(TABLE_CODE).toMatch(/['"`]text-left['"`]/);
  });

  it('supports `align=\"center\"` via a literal `text-center` class', () => {
    expect(TABLE_CODE).toMatch(/['"`]text-center['"`]/);
    // The Th union type widened to include 'center'.
    expect(TABLE_SRC).toMatch(/align\?:\s*'right'\s*\|\s*'left'\s*\|\s*'center'/);
  });
});

// ─── 3. Empty-state guidance ────────────────────────────────────────

describe('FinanceStatements — empty-state guidance (PR-FIN-3-UX gap A)', () => {
  it('renders three numbered steps with the expected Arabic copy', () => {
    renderPage();
    expect(screen.getByTestId('statements-empty-steps')).toBeInTheDocument();
    expect(screen.getByTestId('statements-step-1')).toHaveTextContent('اختر نوع الكشف');
    expect(screen.getByTestId('statements-step-2')).toHaveTextContent('اختر الكيان');
    expect(screen.getByTestId('statements-step-3')).toHaveTextContent('حدّد الفترة');
  });

  it('mentions all 7 supported statement types in the lead paragraph', () => {
    renderPage();
    const empty = screen.getByTestId('statements-no-entity');
    // Arabic labels for each tab's surface area
    expect(empty.textContent).toMatch(/حسابات الأستاذ العام/);
    expect(empty.textContent).toMatch(/الخزائن النقدية والبنكية/);
    expect(empty.textContent).toMatch(/المحافظ/);
    expect(empty.textContent).toMatch(/الموظفين/);
    expect(empty.textContent).toMatch(/العملاء/);
    expect(empty.textContent).toMatch(/الموردين/);
  });
});

// ─── 4. Date presets ────────────────────────────────────────────────

describe('FinanceStatements — date presets (PR-FIN-3-UX gap B)', () => {
  it('renders all 5 preset buttons with Arabic labels', () => {
    renderPage();
    const presets = screen.getByTestId('statements-date-presets');
    expect(presets).toBeInTheDocument();
    expect(screen.getByTestId('statements-preset-today')).toHaveTextContent('اليوم');
    expect(screen.getByTestId('statements-preset-week')).toHaveTextContent('هذا الأسبوع');
    expect(screen.getByTestId('statements-preset-month')).toHaveTextContent('هذا الشهر');
    expect(screen.getByTestId('statements-preset-mtd')).toHaveTextContent('من بداية الشهر');
    expect(screen.getByTestId('statements-preset-last30')).toHaveTextContent('آخر 30 يوم');
  });

  it('clicking "اليوم" sets both date inputs to the same value (today)', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('statements-preset-today'));
    const from = screen.getByTestId('statements-date-from') as HTMLInputElement;
    const to = screen.getByTestId('statements-date-to') as HTMLInputElement;
    // Pure equality is the right invariant — "today→today".
    expect(from.value).toBe(to.value);
    // YYYY-MM-DD shape.
    expect(from.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('clicking "آخر 30 يوم" sets `from` to 29 days before `to`', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('statements-preset-last30'));
    const from = (screen.getByTestId('statements-date-from') as HTMLInputElement).value;
    const to = (screen.getByTestId('statements-date-to') as HTMLInputElement).value;
    // Day diff using calendar math.
    const fromMs = new Date(from + 'T00:00:00Z').getTime();
    const toMs = new Date(to + 'T00:00:00Z').getTime();
    expect(Math.round((toMs - fromMs) / 86_400_000)).toBe(29);
  });

  it('clicking "من بداية الشهر" sets `from` to the 1st of the current month', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('statements-preset-mtd'));
    const from = (screen.getByTestId('statements-date-from') as HTMLInputElement).value;
    expect(from).toMatch(/^\d{4}-\d{2}-01$/);
  });

  it('presetRange("today") returns a single-day range', () => {
    const { from, to } = presetRange('today', new Date('2026-05-10T12:00:00Z'));
    expect(from).toBe(to);
  });

  it('presetRange("month") returns the full calendar month', () => {
    const { from, to } = presetRange('month', new Date('2026-05-10T12:00:00Z'));
    expect(from).toBe('2026-05-01');
    expect(to).toBe('2026-05-31');
  });

  it('presetRange("mtd") clamps `to` at today', () => {
    const { from, to } = presetRange('mtd', new Date('2026-05-10T12:00:00Z'));
    expect(from).toBe('2026-05-01');
    expect(to).toBe('2026-05-10');
  });

  it('presetRange("week") starts from the prior Saturday (Egypt convention)', () => {
    // 2026-05-13 is a Wednesday (per ISO calendar).
    const wed = new Date('2026-05-13T12:00:00Z');
    const { from } = presetRange('week', wed);
    // Saturday before Wed = May 9.
    expect(from).toBe('2026-05-09');
  });

  // PR-FIN-3-UX regression guard: the runner's local TZ is whatever
  // GitHub Actions provides (UTC).  Date arithmetic must operate on
  // Cairo YYYY-MM-DD strings, not on `Date.setDate()` in local TZ,
  // otherwise the midnight crossover drifts results by a full day.
  // CI caught this on commit abc4a2d — pinning the symptom here so
  // it can't recur.
  it('presetRange("last30") is timezone-pure — exactly 29 days regardless of UTC-vs-Cairo midnight crossover', () => {
    // 21:10 UTC on 2026-05-10 is 00:10 Cairo on 2026-05-11.  Pre-fix
    // this produced a 30-day diff because `now.setDate(d - 29)` saw
    // UTC date 10, while `today` was already Cairo May 11.
    const crossover = new Date('2026-05-10T21:10:00Z');
    const { from, to } = presetRange('last30', crossover);
    expect(to).toBe('2026-05-11');
    expect(from).toBe('2026-04-12');
    const fromMs = new Date(from + 'T00:00:00Z').getTime();
    const toMs = new Date(to + 'T00:00:00Z').getTime();
    expect(Math.round((toMs - fromMs) / 86_400_000)).toBe(29);
  });

  it('presetRange("week") on the Cairo midnight crossover still anchors on the Cairo Saturday', () => {
    // 22:00 UTC on 2026-05-08 (Friday) is 01:00 Cairo on 2026-05-09
    // (Saturday).  `from` must be Cairo May 9 (= Saturday) and `to`
    // must be Cairo May 9 — i.e. a single-day "week-so-far".
    const crossover = new Date('2026-05-08T22:00:00Z');
    const { from, to } = presetRange('week', crossover);
    expect(to).toBe('2026-05-09');
    expect(from).toBe('2026-05-09');
  });
});

// ─── 5. Print / Export gating ───────────────────────────────────────

describe('FinanceStatements — print/export demotion + gating (PR-FIN-3-UX bug #3)', () => {
  it('print + export buttons live inside the secondary-actions cluster, NOT the page header', () => {
    renderPage();
    const header = screen.getByTestId('statements-header');
    const print = screen.getByTestId('statements-print-btn');
    const excel = screen.getByTestId('statements-export-btn');
    // Buttons are NOT children of the header.
    expect(header.contains(print)).toBe(false);
    expect(header.contains(excel)).toBe(false);
    // Buttons ARE children of the secondary-actions cluster.
    const secondary = screen.getByTestId('statements-secondary-actions');
    expect(secondary.contains(print)).toBe(true);
    expect(secondary.contains(excel)).toBe(true);
  });

  it('with no entity selected, print + export are disabled', () => {
    renderPage();
    expect(screen.getByTestId('statements-print-btn')).toBeDisabled();
    expect(screen.getByTestId('statements-export-btn')).toBeDisabled();
  });

  it('with an entity but rows.length === 0, print + export remain disabled', async () => {
    fixture = buildFixture({
      rows: [],
      totals: { debit: 0, credit: 0, net: 0, lines: 0 },
      confidence: { has_data: false, data_source: 'gl_lines', note: null, context: null },
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <FinanceStatements />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      const sel = screen.getByTestId('statements-entity-select') as HTMLSelectElement;
      expect(Array.from(sel.options).find((o) => o.value === 'acc-1')).toBeDefined();
    });
    fireEvent.change(screen.getByTestId('statements-entity-select'), {
      target: { value: 'acc-1' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('statement-empty-state')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('statements-print-btn')).toBeDisabled();
    expect(screen.getByTestId('statements-export-btn')).toBeDisabled();
  });
});

// ─── 6. confidence.note banner ──────────────────────────────────────

describe('FinanceStatements — confidence.note banner (PR-FIN-3-UX gap C)', () => {
  it('shows an info banner above the table when rows exist AND note is set', async () => {
    fixture = buildFixture({
      confidence: {
        has_data: true,
        data_source: 'gl_lines',
        note: 'بعض الفواتير في هذه الفترة غير مرتبطة بحساب فرعي.',
        context: { period_total_invoices: 5 },
      },
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <FinanceStatements />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      const sel = screen.getByTestId('statements-entity-select') as HTMLSelectElement;
      expect(Array.from(sel.options).find((o) => o.value === 'acc-1')).toBeDefined();
    });
    fireEvent.change(screen.getByTestId('statements-entity-select'), {
      target: { value: 'acc-1' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('statement-table')).toBeInTheDocument(),
    );
    const banner = screen.getByTestId('statements-confidence-banner');
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toMatch(/بعض الفواتير/);
  });

  it('does NOT show the banner when rows exist but note is null', async () => {
    renderPage(); // default fixture: rows present, note null
    await waitFor(() => {
      const sel = screen.getByTestId('statements-entity-select') as HTMLSelectElement;
      expect(Array.from(sel.options).find((o) => o.value === 'acc-1')).toBeDefined();
    });
    fireEvent.change(screen.getByTestId('statements-entity-select'), {
      target: { value: 'acc-1' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('statement-table')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('statements-confidence-banner')).toBeNull();
  });
});
