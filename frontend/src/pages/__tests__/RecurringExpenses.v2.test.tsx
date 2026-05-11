/**
 * RecurringExpenses.v2.test.tsx — PR-A
 *
 * Pins the Recurring Expenses v2 UX/RTL cleanup:
 *
 *   1. Header — title appears BEFORE the actions cluster in DOM
 *      order so RTL flex puts the title on the right at every
 *      breakpoint (no `lg:order-*` swap that flipped it left).
 *   2. Empty state — three numbered Arabic steps + CTA when zero
 *      templates exist.
 *   3. Generation-behavior radio group — collapses the three
 *      booleans (auto_post / auto_paid / require_approval) into one
 *      self-describing choice; pure helpers `flagsToBehavior` and
 *      `behaviorToFlags` round-trip cleanly.
 *   4. Due-status filter pills — 6 named filters; client-side
 *      `filterRowsByDue` helper covers each case.
 *   5. Runs history drawer — opens for a row, fetches via
 *      `GET /recurring-expenses/:id`, renders runs.
 *   6. Source-grep — RecurringExpenses.tsx no longer uses
 *      `lg:order-1` / `lg:order-2`.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import RecurringExpenses, {
  flagsToBehavior,
  behaviorToFlags,
  filterRowsByDue,
  RECURRING_PAYMENT_METHOD_OPTIONS,
  RECURRING_PAYMENT_METHOD_VALUES,
  DEFAULT_GENERATION_BEHAVIOR,
} from '@/pages/RecurringExpenses';
import type { RecurringExpense } from '@/api/recurringExpenses.api';

// ─── Mocks ──────────────────────────────────────────────────────────

let listFixture: RecurringExpense[] = [];
let statsFixture: any = {
  active_templates: 0,
  paused_templates: 0,
  due_now: 0,
  due_next_7_days: 0,
  monthly_commitment_estimate: 0,
  due_amount: 0,
};
let getFixture: any = null;

vi.mock('@/api/recurringExpenses.api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    recurringExpensesApi: {
      list: vi.fn(async () => listFixture),
      stats: vi.fn(async () => statsFixture),
      get: vi.fn(async (id: string) => getFixture ?? { id, runs: [] }),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      run: vi.fn(),
      processDue: vi.fn(),
    },
  };
});

vi.mock('@/api/accounting.api', () => ({
  accountingApi: {
    categories: vi.fn(async () => [
      { id: 'cat-1', name_ar: 'إيجار' },
      { id: 'cat-2', name_ar: 'كهرباء' },
    ]),
  },
}));

vi.mock('@/api/settings.api', () => ({
  settingsApi: {
    listWarehouses: vi.fn(async () => [
      { id: 'wh-1', name: 'المخزن الرئيسي' },
    ]),
  },
}));

vi.mock('@/api/cash-desk.api', () => ({
  cashDeskApi: {
    cashboxes: vi.fn(async () => [
      { id: 'cb-MAIN', name_ar: 'الخزينة الرئيسية', kind: 'cash', is_active: true },
      { id: 'cb-OLD',  name_ar: 'خزنة مغلقة',       kind: 'cash', is_active: false },
    ]),
  },
}));

vi.mock('react-hot-toast', () => {
  const fn = vi.fn();
  return {
    default: Object.assign(fn, { success: vi.fn(), error: vi.fn() }),
    toast: Object.assign(fn, { success: vi.fn(), error: vi.fn() }),
  };
});

function buildTemplate(o: Partial<RecurringExpense> = {}): RecurringExpense {
  return {
    id: 'tpl-1',
    code: 'RENT-01',
    name_ar: 'إيجار',
    category_id: 'cat-1',
    category_name: 'إيجار',
    warehouse_id: 'wh-1',
    cashbox_id: 'cb-1',
    amount: 5000,
    payment_method: 'cash',
    vendor_name: 'مالك العقار',
    description: undefined,
    frequency: 'monthly',
    custom_interval_days: undefined,
    day_of_month: 1,
    start_date: '2026-01-01',
    end_date: undefined,
    next_run_date: '2026-06-01',
    last_run_date: '2026-05-01',
    auto_post: true,
    auto_paid: true,
    notify_days_before: 3,
    require_approval: false,
    status: 'active',
    runs_count: 4,
    last_error: undefined,
    due_status: 'scheduled',
    days_overdue: -21,
    ...o,
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <RecurringExpenses />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ─── Pure helpers ───────────────────────────────────────────────────

describe('flagsToBehavior / behaviorToFlags — round trip (PR-A)', () => {
  it('maps each behavior to the expected boolean triplet', () => {
    expect(behaviorToFlags('draft')).toEqual({
      auto_post: false,
      auto_paid: false,
      require_approval: false,
    });
    expect(behaviorToFlags('auto_post')).toEqual({
      auto_post: true,
      auto_paid: false,
      require_approval: false,
    });
    expect(behaviorToFlags('auto_paid')).toEqual({
      auto_post: true,
      auto_paid: true,
      require_approval: false,
    });
    expect(behaviorToFlags('approval')).toEqual({
      auto_post: false,
      auto_paid: false,
      require_approval: true,
    });
  });

  it('flagsToBehavior is the inverse: any behavior round-trips', () => {
    for (const b of ['draft', 'auto_post', 'auto_paid', 'approval'] as const) {
      expect(flagsToBehavior(behaviorToFlags(b))).toBe(b);
    }
  });

  it('flagsToBehavior treats require_approval=TRUE as the dominant flag', () => {
    // Even if a legacy row has auto_post=true AND require_approval=true,
    // it must classify as "approval" — that's the path that wires up
    // the expense_approvals inbox.
    expect(
      flagsToBehavior({ auto_post: true, auto_paid: true, require_approval: true }),
    ).toBe('approval');
  });
});

// ─── filterRowsByDue ────────────────────────────────────────────────

describe('filterRowsByDue — client-side due-status slicing (PR-A)', () => {
  const rows: RecurringExpense[] = [
    buildTemplate({ id: 'A', status: 'active', due_status: 'due', days_overdue: 3 }),  // overdue
    buildTemplate({ id: 'B', status: 'active', due_status: 'due', days_overdue: 0 }),  // due now
    buildTemplate({ id: 'C', status: 'active', due_status: 'upcoming', days_overdue: -2 }), // within 7d
    buildTemplate({ id: 'D', status: 'active', due_status: 'scheduled', days_overdue: -30 }), // far future
    buildTemplate({ id: 'E', status: 'paused', due_status: 'scheduled' }),
    buildTemplate({ id: 'F', status: 'ended', due_status: 'scheduled' }),
  ];

  it('"all" excludes ended templates', () => {
    const ids = filterRowsByDue(rows, 'all').map((r) => r.id);
    expect(ids).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('"due_now" returns active rows due today (days_overdue <= 0)', () => {
    const ids = filterRowsByDue(rows, 'due_now').map((r) => r.id);
    expect(ids).toEqual(['B']);
  });

  it('"overdue" returns active rows whose due date is in the past', () => {
    const ids = filterRowsByDue(rows, 'overdue').map((r) => r.id);
    expect(ids).toEqual(['A']);
  });

  it('"due_7d" returns upcoming + due-today (not overdue)', () => {
    const ids = filterRowsByDue(rows, 'due_7d').map((r) => r.id);
    expect(ids.sort()).toEqual(['B', 'C']);
  });

  it('"paused" / "ended" return only that bucket', () => {
    expect(filterRowsByDue(rows, 'paused').map((r) => r.id)).toEqual(['E']);
    expect(filterRowsByDue(rows, 'ended').map((r) => r.id)).toEqual(['F']);
  });
});

// ─── Header layout ──────────────────────────────────────────────────

describe('RecurringExpenses — header layout (PR-A)', () => {
  it('title appears before the action cluster in DOM order (RTL → right)', async () => {
    listFixture = [];
    renderPage();
    const header = await screen.findByTestId('recurring-expenses-header');
    const title = screen.getByText('المصروفات الدورية');
    const action = screen.getByTestId('recurring-new-template-btn');

    expect(header.contains(title)).toBe(true);
    expect(header.contains(action)).toBe(true);
    // RTL ordering invariant — title's DOM position precedes the action.
    expect(
      title.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('source no longer contains `lg:order-1` / `lg:order-2` swap classes', () => {
    const src = readFileSync(
      resolve(__dirname, '../RecurringExpenses.tsx'),
      'utf-8',
    );
    expect(src).not.toMatch(/\blg:order-1\b/);
    expect(src).not.toMatch(/\blg:order-2\b/);
    expect(src).toMatch(/dir="rtl"/);
  });
});

// ─── Empty state ────────────────────────────────────────────────────

describe('RecurringExpenses — empty state guidance (PR-A)', () => {
  it('renders the 3-step Arabic guide when zero templates exist', async () => {
    listFixture = [];
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('recurring-empty')).toBeInTheDocument(),
    );
    expect(screen.getByText('ابدأ بإضافة قالب مصروف دوري')).toBeInTheDocument();
    expect(screen.getByTestId('recurring-empty-step-1')).toHaveTextContent(
      'أضف قالب مصروف دوري',
    );
    expect(screen.getByTestId('recurring-empty-step-2')).toHaveTextContent(
      'راجع الاستحقاق القادم',
    );
    expect(screen.getByTestId('recurring-empty-step-3')).toHaveTextContent(
      'ولّد المصروف أو اتركه تلقائيًا',
    );
  });

  it('empty state mentions the integration with the normal expense workflow', async () => {
    listFixture = [];
    renderPage();
    const empty = await screen.findByTestId('recurring-empty');
    // "تتحول إلى مصروفات عادية" — sets the expectation that there's
    // no parallel accounting pipeline.
    expect(empty.textContent).toMatch(/مصروفات عادية/);
  });

  it('"قالب جديد" CTA inside the empty state opens the form modal', async () => {
    listFixture = [];
    renderPage();
    const cta = await screen.findByTestId('recurring-empty-cta');
    fireEvent.click(cta);
    expect(screen.getByText('قالب مصروف دوري جديد')).toBeInTheDocument();
  });
});

// ─── Filter pills ───────────────────────────────────────────────────

describe('RecurringExpenses — due-status filter pills (PR-A)', () => {
  it('renders all six pills with the expected Arabic labels', async () => {
    listFixture = [buildTemplate()];
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('recurring-filters')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('recurring-filter-all')).toHaveTextContent('الكل');
    expect(screen.getByTestId('recurring-filter-due_now')).toHaveTextContent(
      'مستحقة الآن',
    );
    expect(screen.getByTestId('recurring-filter-due_7d')).toHaveTextContent(
      'خلال 7 أيام',
    );
    expect(screen.getByTestId('recurring-filter-overdue')).toHaveTextContent('متأخرة');
    expect(screen.getByTestId('recurring-filter-paused')).toHaveTextContent('موقوفة');
    expect(screen.getByTestId('recurring-filter-ended')).toHaveTextContent('منتهية');
  });

  it('clicking "متأخرة" narrows the table to overdue rows only', async () => {
    listFixture = [
      buildTemplate({
        id: 'A',
        code: 'OVR-01',
        name_ar: 'متأخر',
        status: 'active',
        due_status: 'due',
        days_overdue: 5,
      }),
      buildTemplate({
        id: 'B',
        code: 'SCH-01',
        name_ar: 'مجدول',
        status: 'active',
        due_status: 'scheduled',
        days_overdue: -10,
      }),
    ];
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('recurring-table')).toBeInTheDocument(),
    );
    // Both rows visible by default
    expect(screen.getByText('متأخر')).toBeInTheDocument();
    expect(screen.getByText('مجدول')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('recurring-filter-overdue'));
    // Only the overdue row remains
    expect(screen.getByText('متأخر')).toBeInTheDocument();
    expect(screen.queryByText('مجدول')).toBeNull();
  });
});

// ─── Behavior/form default sync (PR-A2-FIX-2) ──────────────────────

describe('RecurringExpenses — new-template behavior/form defaults are SYNCED (PR-A2-FIX-2)', () => {
  it('DEFAULT_GENERATION_BEHAVIOR is "auto_paid" (most common workflow)', () => {
    expect(DEFAULT_GENERATION_BEHAVIOR).toBe('auto_paid');
  });

  it('the default behaviour maps to {auto_post:true, auto_paid:true, require_approval:false}', () => {
    expect(behaviorToFlags(DEFAULT_GENERATION_BEHAVIOR)).toEqual({
      auto_post: true,
      auto_paid: true,
      require_approval: false,
    });
  });

  it('opening the form for a NEW template visually selects the "auto_paid" radio', async () => {
    listFixture = [];
    renderPage();
    fireEvent.click(await screen.findByTestId('recurring-new-template-btn'));
    const autoPaid = screen.getByTestId(
      'recurring-behavior-auto_paid',
    ) as HTMLInputElement;
    expect(autoPaid.checked).toBe(true);
    // None of the other radios should be selected.
    expect(
      (screen.getByTestId('recurring-behavior-draft') as HTMLInputElement).checked,
    ).toBe(false);
    expect(
      (screen.getByTestId('recurring-behavior-auto_post') as HTMLInputElement).checked,
    ).toBe(false);
    expect(
      (screen.getByTestId('recurring-behavior-approval') as HTMLInputElement).checked,
    ).toBe(false);
  });

  it('saving a NEW template WITHOUT touching the radio sends auto_paid=true (regression for the silent desync bug)', async () => {
    // Spy on the create call so we can inspect the exact payload.
    const { recurringExpensesApi } = await import('@/api/recurringExpenses.api');
    const createSpy = vi
      .mocked(recurringExpensesApi.create)
      .mockResolvedValue({} as any);

    listFixture = [];
    renderPage();
    fireEvent.click(await screen.findByTestId('recurring-new-template-btn'));

    // Wait for the cashbox list to load — needed because the default
    // payment_method='cash' makes the Save button require a cashbox.
    await waitFor(() => {
      const cb = screen.getByTestId('recurring-cashbox-select') as HTMLSelectElement;
      expect(Array.from(cb.options).find((o) => o.value === 'cb-MAIN')).toBeDefined();
    });

    // Fill the required text + select fields.  Notice: we never touch
    // the behaviour radio.  The radio is already visually showing
    // "auto_paid"; the bug being tested would have shipped auto_paid=
    // false anyway.
    fireEvent.change(screen.getByPlaceholderText('RENT-CAIRO-01'), {
      target: { value: 'TEST-NEW-DEFAULT' },
    });
    fireEvent.change(screen.getAllByRole('textbox')[1]!, {
      target: { value: 'اختبار افتراضي' },
    });
    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0]!, { target: { value: 'cat-1' } });
    fireEvent.change(selects[1]!, { target: { value: 'wh-1' } });
    fireEvent.change(screen.getByTestId('recurring-cashbox-select'), {
      target: { value: 'cb-MAIN' },
    });
    fireEvent.change(screen.getByDisplayValue('0'), {
      target: { value: '1000' },
    });

    await waitFor(() => {
      const save = screen.getByTestId('recurring-save-btn') as HTMLButtonElement;
      expect(save.disabled).toBe(false);
    });
    fireEvent.click(screen.getByTestId('recurring-save-btn'));

    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    const payload = createSpy.mock.calls[0]![0];
    expect(payload).toMatchObject({
      auto_post: true,
      auto_paid: true, // ← the bug fix: was previously FALSE
      require_approval: false,
    });
  });

  it('editing an existing auto_post=true / auto_paid=false template classifies as "auto_post" behaviour', async () => {
    const existing = buildTemplate({
      id: 'tpl-EXISTING-B',
      code: 'EXISTING-B',
      name_ar: 'قالب B',
      auto_post: true,
      auto_paid: false,
      require_approval: false,
    });
    listFixture = [existing];
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('recurring-table')).toBeInTheDocument(),
    );
    // Open the edit modal by clicking the row's edit icon.  The edit
    // icon doesn't have a test-id, so target by title.
    fireEvent.click(screen.getByTitle('تعديل'));
    // Behaviour radio "auto_post" should be selected.
    const autoPost = screen.getByTestId(
      'recurring-behavior-auto_post',
    ) as HTMLInputElement;
    expect(autoPost.checked).toBe(true);
    expect(
      (screen.getByTestId('recurring-behavior-auto_paid') as HTMLInputElement).checked,
    ).toBe(false);
  });

  it('editing an existing require_approval=true template classifies as "approval" behaviour', async () => {
    const existing = buildTemplate({
      id: 'tpl-EXISTING-APP',
      code: 'EXISTING-APP',
      name_ar: 'قالب اعتماد',
      auto_post: false,
      auto_paid: false,
      require_approval: true,
      payment_method: 'card_visa',
    });
    listFixture = [existing];
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('recurring-table')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTitle('تعديل'));
    const approval = screen.getByTestId(
      'recurring-behavior-approval',
    ) as HTMLInputElement;
    expect(approval.checked).toBe(true);
  });

  it('source-grep — no separate hardcoded defaults exist for auto_post / auto_paid / require_approval', () => {
    const src = readFileSync(
      resolve(__dirname, '../RecurringExpenses.tsx'),
      'utf-8',
    );
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    // The legacy hard-coded form defaults pattern (each boolean with
    // its own `?? <bool>` fallback) must be gone — that's what caused
    // the radio/form desync.
    expect(code).not.toMatch(/auto_post:\s*editing\??\.auto_post\s*\?\?\s*true/);
    expect(code).not.toMatch(/auto_paid:\s*editing\??\.auto_paid\s*\?\?\s*false/);
    expect(code).not.toMatch(
      /require_approval:\s*editing\??\.require_approval\s*\?\?\s*false/,
    );
    // Positive guard — defaults flow through the shared constant.
    expect(code).toMatch(/DEFAULT_GENERATION_BEHAVIOR/);
  });
});

// ─── Behavior radio group ───────────────────────────────────────────

describe('RecurringExpenses — generation-behavior radio (PR-A)', () => {
  it('renders all four radio options inside the fieldset', async () => {
    listFixture = [];
    renderPage();
    fireEvent.click(await screen.findByTestId('recurring-new-template-btn'));
    expect(screen.getByTestId('recurring-behavior-fieldset')).toBeInTheDocument();
    expect(screen.getByTestId('recurring-behavior-draft')).toBeInTheDocument();
    expect(screen.getByTestId('recurring-behavior-auto_post')).toBeInTheDocument();
    expect(screen.getByTestId('recurring-behavior-auto_paid')).toBeInTheDocument();
    expect(screen.getByTestId('recurring-behavior-approval')).toBeInTheDocument();
  });

  it('default selection for a brand-new template is "اعتماد ودفع تلقائي"', async () => {
    listFixture = [];
    renderPage();
    fireEvent.click(await screen.findByTestId('recurring-new-template-btn'));
    const autoPaidRadio = screen.getByTestId(
      'recurring-behavior-auto_paid',
    ) as HTMLInputElement;
    expect(autoPaidRadio.checked).toBe(true);
  });

  it('switching to "مسودة للمراجعة" deselects the previous option', async () => {
    listFixture = [];
    renderPage();
    fireEvent.click(await screen.findByTestId('recurring-new-template-btn'));
    const draft = screen.getByTestId('recurring-behavior-draft') as HTMLInputElement;
    const autoPaid = screen.getByTestId(
      'recurring-behavior-auto_paid',
    ) as HTMLInputElement;

    fireEvent.click(draft);
    expect(draft.checked).toBe(true);
    expect(autoPaid.checked).toBe(false);
  });

  it('does NOT render the legacy three-checkbox cluster', () => {
    const src = readFileSync(
      resolve(__dirname, '../RecurringExpenses.tsx'),
      'utf-8',
    );
    // The old form had three separate <input type="checkbox"> for
    // auto_post / auto_paid / require_approval inside one flex row.
    // The new fieldset uses radios bound to GenerationBehavior.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    // Sanity: a `<input type="checkbox" ...form.auto_post... >` shape
    // should be gone.
    expect(code).not.toMatch(/checked=\{form\.auto_post\}/);
    expect(code).not.toMatch(/checked=\{form\.auto_paid\}/);
    expect(code).not.toMatch(/checked=\{form\.require_approval\}/);
  });
});

// ─── Payment-method options whitelist (PR-A2-FIX) ──────────────────

describe('RecurringExpenses — payment_method whitelist (PR-A2-FIX)', () => {
  // The DB enum `payment_method_code` values, verified live on prod
  // before this fix landed.  Updating this constant requires a
  // coordinated migration + BE whitelist + FE option change, so we
  // pin it as a regression guard.
  const DB_ENUM = [
    'cash',
    'card_visa',
    'card_mastercard',
    'card_meeza',
    'instapay',
    'vodafone_cash',
    'orange_cash',
    'bank_transfer',
    'credit',
    'other',
    'wallet',
  ];

  it('every exported FE option value exists in the DB enum', () => {
    for (const v of RECURRING_PAYMENT_METHOD_VALUES) {
      expect(DB_ENUM).toContain(v);
    }
  });

  it('does NOT export the bogus legacy "card" value', () => {
    expect(RECURRING_PAYMENT_METHOD_VALUES).not.toContain('card');
  });

  it('source-grep — RecurringExpenses.tsx has no `<option value="card">` and no `payment_method: \'card\'`', () => {
    const src = readFileSync(
      resolve(__dirname, '../RecurringExpenses.tsx'),
      'utf-8',
    );
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/value=["']card["']/);
    expect(code).not.toMatch(/payment_method:\s*['"]card['"]/);
  });

  it('form renders every option from the canonical list', async () => {
    listFixture = [];
    renderPage();
    fireEvent.click(await screen.findByTestId('recurring-new-template-btn'));
    const select = screen.getByTestId(
      'recurring-payment-method',
    ) as HTMLSelectElement;
    const optionValues = Array.from(select.options).map((o) => o.value);
    for (const o of RECURRING_PAYMENT_METHOD_OPTIONS) {
      expect(optionValues).toContain(o.value);
    }
    // And no leftover "card" entry.
    expect(optionValues).not.toContain('card');
  });

  it('selecting "بطاقة Visa" sets payment_method=card_visa (valid enum value)', async () => {
    listFixture = [];
    renderPage();
    fireEvent.click(await screen.findByTestId('recurring-new-template-btn'));
    fireEvent.change(screen.getByTestId('recurring-payment-method'), {
      target: { value: 'card_visa' },
    });
    // Cashbox row should disappear since card_visa is not cash.
    expect(screen.queryByTestId('recurring-cashbox-row')).toBeNull();
  });
});

// ─── Cashbox selector + payment-method gating (PR-A2) ──────────────

describe('RecurringExpenses — form cashbox field (PR-A2)', () => {
  it('cashbox row is visible by default (payment_method defaults to cash)', async () => {
    listFixture = [];
    renderPage();
    fireEvent.click(await screen.findByTestId('recurring-new-template-btn'));
    expect(screen.getByTestId('recurring-cashbox-row')).toBeInTheDocument();
    expect(screen.getByTestId('recurring-cashbox-select')).toBeInTheDocument();
    // Helper text present
    expect(screen.getByTestId('recurring-cashbox-helper').textContent).toMatch(
      /اختر الخزنة لأن المصروف سيتم دفعه نقديًا/,
    );
  });

  it('cashbox row is hidden when payment_method is non-cash (e.g. card_visa)', async () => {
    listFixture = [];
    renderPage();
    fireEvent.click(await screen.findByTestId('recurring-new-template-btn'));
    fireEvent.change(screen.getByTestId('recurring-payment-method'), {
      target: { value: 'card_visa' },
    });
    expect(screen.queryByTestId('recurring-cashbox-row')).toBeNull();
    expect(screen.queryByTestId('recurring-cashbox-select')).toBeNull();
  });

  it('switching back to cash re-shows the cashbox row', async () => {
    listFixture = [];
    renderPage();
    fireEvent.click(await screen.findByTestId('recurring-new-template-btn'));
    fireEvent.change(screen.getByTestId('recurring-payment-method'), {
      target: { value: 'instapay' },
    });
    expect(screen.queryByTestId('recurring-cashbox-row')).toBeNull();
    fireEvent.change(screen.getByTestId('recurring-payment-method'), {
      target: { value: 'cash' },
    });
    expect(screen.getByTestId('recurring-cashbox-row')).toBeInTheDocument();
  });

  it('Save button is disabled when payment_method=cash and cashbox is empty', async () => {
    listFixture = [];
    renderPage();
    fireEvent.click(await screen.findByTestId('recurring-new-template-btn'));
    // Fill the other required fields so the only blocker is the cashbox.
    fireEvent.change(screen.getByPlaceholderText('RENT-CAIRO-01'), {
      target: { value: 'TEST-CASH-NEG' },
    });
    fireEvent.change(screen.getAllByRole('textbox')[1]!, {
      target: { value: 'إيجار اختبار' },
    });
    const selects = screen.getAllByRole('combobox');
    // category select
    fireEvent.change(selects[0]!, { target: { value: 'cat-1' } });
    // warehouse select
    fireEvent.change(selects[1]!, { target: { value: 'wh-1' } });
    // Cashbox left empty — Save should still be disabled.
    const save = screen.getByTestId('recurring-save-btn') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    // Inline error visible.
    expect(screen.getByTestId('recurring-cashbox-error').textContent).toMatch(
      /الخزنة مطلوبة عند اختيار الدفع النقدي للمصروف الدوري/,
    );
  });

  it('Save button enables when payment_method=cash and a cashbox is picked', async () => {
    listFixture = [];
    renderPage();
    fireEvent.click(await screen.findByTestId('recurring-new-template-btn'));
    // Wait for category + warehouse + cashbox lists to populate.
    await waitFor(() => {
      const cb = screen.getByTestId('recurring-cashbox-select') as HTMLSelectElement;
      expect(Array.from(cb.options).find((o) => o.value === 'cb-MAIN')).toBeDefined();
    });
    // Fill code via placeholder, then name_ar via the only textbox
    // labelled "الاسم بالعربية".
    fireEvent.change(screen.getByPlaceholderText('RENT-CAIRO-01'), {
      target: { value: 'TEST-CASH-POS' },
    });
    fireEvent.change(screen.getAllByRole('textbox')[1]!, {
      target: { value: 'إيجار اختبار' },
    });
    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0]!, { target: { value: 'cat-1' } });
    fireEvent.change(selects[1]!, { target: { value: 'wh-1' } });
    fireEvent.change(screen.getByTestId('recurring-cashbox-select'), {
      target: { value: 'cb-MAIN' },
    });
    // React batches updates; assert in a waitFor to let the next tick
    // recompute the disabled predicate.
    await waitFor(() => {
      const save = screen.getByTestId('recurring-save-btn') as HTMLButtonElement;
      expect(save.disabled).toBe(false);
    });
    expect(screen.queryByTestId('recurring-cashbox-error')).toBeNull();
  });

  it('inactive cashboxes are filtered out of the dropdown', async () => {
    listFixture = [];
    renderPage();
    fireEvent.click(await screen.findByTestId('recurring-new-template-btn'));
    await waitFor(() => {
      const cb = screen.getByTestId('recurring-cashbox-select') as HTMLSelectElement;
      const values = Array.from(cb.options).map((o) => o.value);
      expect(values).toContain('cb-MAIN');
      expect(values).not.toContain('cb-OLD');
    });
  });

  it('warehouse field remains separate and labelled "المخزن"', async () => {
    listFixture = [];
    renderPage();
    fireEvent.click(await screen.findByTestId('recurring-new-template-btn'));
    // "المخزن" label still present (not collapsed with cashbox).
    expect(screen.getByText('المخزن')).toBeInTheDocument();
    // "الخزنة" label is for the cashbox row.
    expect(screen.getByText('الخزنة')).toBeInTheDocument();
  });
});

// ─── Date formatting integration (PR-A2) ───────────────────────────

describe('RecurringExpenses — Cairo date formatting (PR-A2)', () => {
  it('table cell renders human-readable Cairo date, NOT raw ISO', async () => {
    listFixture = [
      buildTemplate({
        id: 'tpl-ISO',
        next_run_date: '2026-05-10T21:00:00.000Z' as unknown as string,
      }),
    ];
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('recurring-table')).toBeInTheDocument(),
    );
    const badge = screen.getByTestId('recurring-due-badge');
    expect(badge.textContent).toMatch(/11\/05\/2026/);
    expect(badge.textContent).not.toMatch(/T\d{2}:/);
    expect(badge.textContent).not.toMatch(/Z/);
  });

  it('runs drawer renders scheduled_for as Cairo datetime with seconds', async () => {
    const tpl = buildTemplate({ id: 'tpl-RUN' });
    listFixture = [tpl];
    getFixture = {
      ...tpl,
      runs: [
        {
          id: 'run-1',
          recurring_id: 'tpl-RUN',
          expense_id: 'exp-1',
          expense_no: 'EXP-2026-0001',
          scheduled_for: '2026-05-10T21:00:00.000Z',
          generated_at: '2026-05-10T21:05:00.000Z',
          amount: 5000,
          status: 'generated',
        },
      ],
    };
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('recurring-table')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('recurring-history-tpl-RUN'));
    await waitFor(() =>
      expect(screen.getByTestId('recurring-history-drawer')).toBeInTheDocument(),
    );
    const stamp = await screen.findByTestId('recurring-run-scheduled');
    expect(stamp.textContent).toMatch(/11\/05\/2026/);
    expect(stamp.textContent).toMatch(/[صم]/); // Arabic AM/PM marker
    expect(stamp.textContent).not.toMatch(/T\d{2}:/);
  });

  it('source-grep — RecurringExpenses.tsx imports and uses the Cairo date helpers', () => {
    const src = readFileSync(
      resolve(__dirname, '../RecurringExpenses.tsx'),
      'utf-8',
    );
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    // Helpers imported from the shared util.
    expect(code).toMatch(
      /import\s*\{[^}]*fmtCairoDate[^}]*\}\s*from\s*['"]@\/lib\/dates['"]/,
    );
    // Both helpers actually called somewhere in the page.
    expect(code).toMatch(/fmtCairoDate\s*\(/);
    expect(code).toMatch(/fmtCairoDateTimeSeconds\s*\(/);
    // Forbid raw rendering of dates as JSX text children — i.e. the
    // pattern `>{x.next_run_date}<` or `>{run.scheduled_for}<`.
    // (Prop-passing like `date={r.next_run_date}` is fine because the
    // receiving component runs the value through the helper.)
    expect(code).not.toMatch(/>\s*\{\s*[a-zA-Z_]+\.next_run_date\s*\}\s*</);
    expect(code).not.toMatch(/>\s*\{\s*[a-zA-Z_]+\.scheduled_for\s*\}\s*</);
  });
});

// ─── Runs history drawer ────────────────────────────────────────────

describe('RecurringExpenses — runs history drawer (PR-A)', () => {
  it('clicking the history icon opens the drawer and renders mocked runs', async () => {
    const tpl = buildTemplate({ id: 'tpl-99', name_ar: 'إيجار محل' });
    listFixture = [tpl];
    getFixture = {
      ...tpl,
      runs: [
        {
          id: 'run-1',
          recurring_id: 'tpl-99',
          expense_id: 'exp-1',
          expense_no: 'EXP-2026-00012345',
          scheduled_for: '2026-05-01',
          generated_at: '2026-05-01T08:00:00Z',
          amount: 5000,
          status: 'generated',
        },
        {
          id: 'run-2',
          recurring_id: 'tpl-99',
          expense_id: null,
          expense_no: null,
          scheduled_for: '2026-04-01',
          generated_at: '2026-04-01T08:00:00Z',
          amount: 5000,
          status: 'failed',
          error_message: 'الفئة لا تحتوي على حساب محاسبي مرتبط.',
        },
      ],
    };
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('recurring-table')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('recurring-history-tpl-99'));

    await waitFor(() =>
      expect(screen.getByTestId('recurring-history-drawer')).toBeInTheDocument(),
    );
    const runs = await screen.findAllByTestId('recurring-history-run');
    expect(runs).toHaveLength(2);
    // First run shows the expense_no
    expect(runs[0]!.textContent).toMatch(/EXP-2026-00012345/);
    expect(runs[0]!.textContent).toMatch(/تم التوليد/);
    // Second run shows the failure reason
    expect(runs[1]!.textContent).toMatch(/فشل/);
    expect(runs[1]!.textContent).toMatch(/حساب محاسبي مرتبط/);
  });

  it('clicking the close button dismisses the drawer', async () => {
    const tpl = buildTemplate({ id: 'tpl-77' });
    listFixture = [tpl];
    getFixture = { ...tpl, runs: [] };
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('recurring-table')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('recurring-history-tpl-77'));
    await waitFor(() =>
      expect(screen.getByTestId('recurring-history-drawer')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('recurring-history-close'));
    await waitFor(() =>
      expect(screen.queryByTestId('recurring-history-drawer')).toBeNull(),
    );
  });

  it('empty runs list shows the "لم يُنفَّذ هذا القالب بعد" hint', async () => {
    const tpl = buildTemplate({ id: 'tpl-empty' });
    listFixture = [tpl];
    getFixture = { ...tpl, runs: [] };
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('recurring-table')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('recurring-history-tpl-empty'));
    await waitFor(() =>
      expect(screen.getByTestId('recurring-history-runs')).toBeInTheDocument(),
    );
    expect(screen.getByText(/لم يُنفَّذ هذا القالب بعد/)).toBeInTheDocument();
  });
});
