/**
 * MyRequestsCard.test.tsx — PR-ESS-2B
 *
 * Pins the visual contract for the new `'disbursed'` status. The card
 * must render:
 *   · pending          → amber "قيد المراجعة"
 *   · approved (advance) → emerald "موافق عليه" + amber subtext
 *                          "بانتظار الصرف من قِبَل المحاسبة"
 *   · disbursed (advance) → strong-emerald "تم الصرف" + NO "بانتظار"
 *                            subtext (the request has actually been
 *                            paid out via the canonical Daily Expense
 *                            path; PR-ESS-2B's status flip).
 *   · rejected         → rose "مرفوض" + decision_reason
 *   · cancelled        → slate "ملغي"
 */

import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MyRequestsCard } from '../MyRequestsCard';
import type { EmployeeRequest } from '@/api/employees.api';

/**
 * Helper — wait for a row to render and return the row element so
 * that subsequent text queries are scoped to the row only. Necessary
 * after PR-ESS-2C-2 because the filter bar above the rows reuses the
 * same Arabic status labels (الكل / قيد المراجعة / موافق عليه / تم
 * الصرف / مرفوض / ملغي), so a global findByText would match the
 * filter tab instead of the row chip.
 */
async function findRow(): Promise<HTMLElement> {
  return await screen.findByTestId('request-row');
}

// Stub the API module: we want MyRequestsCard to render a fixed
// list without hitting the network. Vitest hoists vi.mock calls
// before the import above.
import { vi } from 'vitest';

vi.mock('@/api/employees.api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    employeesApi: {
      myRequests: vi.fn(async () => fixtures),
    },
  };
});

let fixtures: EmployeeRequest[] = [];

function renderWithClient(rows: EmployeeRequest[]) {
  fixtures = rows;
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MyRequestsCard />
    </QueryClientProvider>,
  );
}

const baseAdvance: EmployeeRequest = {
  id: '101',
  user_id: 'emp-1',
  kind: 'advance_request',
  amount: '250.00',
  status: 'pending',
  reason: 'ظرف عاجل',
  created_at: '2026-04-27T10:00:00Z',
};

describe('<MyRequestsCard /> — PR-ESS-2B disbursed status', () => {
  it('renders pending advance with "قيد المراجعة" amber chip', async () => {
    renderWithClient([{ ...baseAdvance, status: 'pending' }]);
    const row = await findRow();
    expect(within(row).getByText('قيد المراجعة')).toBeInTheDocument();
  });

  it('renders approved advance with "موافق عليه" + "بانتظار الصرف" subtext', async () => {
    renderWithClient([{ ...baseAdvance, status: 'approved' }]);
    const row = await findRow();
    expect(within(row).getByText('موافق عليه')).toBeInTheDocument();
    expect(
      within(row).getByText(/بانتظار الصرف من قِبَل المحاسبة/),
    ).toBeInTheDocument();
  });

  it('renders disbursed advance with "تم الصرف" green chip and NO "بانتظار" subtext', async () => {
    renderWithClient([{ ...baseAdvance, status: 'disbursed' }]);
    const row = await findRow();
    expect(within(row).getByText('تم الصرف')).toBeInTheDocument();
    // The "بانتظار الصرف" hint must NOT appear once the request is
    // disbursed — the green badge IS the disbursed signal.
    expect(
      within(row).queryByText(/بانتظار الصرف من قِبَل المحاسبة/),
    ).toBeNull();
  });

  it('renders rejected advance with rose tone and decision_reason', async () => {
    renderWithClient([
      {
        ...baseAdvance,
        status: 'rejected',
        decision_reason: 'مكرر',
      },
    ]);
    const row = await findRow();
    expect(within(row).getByText('مرفوض')).toBeInTheDocument();
    expect(within(row).getByText(/سبب الرفض: مكرر/)).toBeInTheDocument();
  });

  it('renders cancelled advance with slate tone "ملغي"', async () => {
    renderWithClient([{ ...baseAdvance, status: 'cancelled' }]);
    const row = await findRow();
    expect(within(row).getByText('ملغي')).toBeInTheDocument();
  });

  // PR-ESS-2C-1 — numeric request_no display + fallback ────────────
  it('displays request_no (numeric, no prefix) on every row when present', async () => {
    renderWithClient([
      {
        ...baseAdvance,
        id: '101',
        request_no: 1003,
        status: 'approved',
      },
    ]);
    const noEl = await screen.findByTestId('request-row-no');
    expect(noEl.textContent).toMatch(/رقم الطلب:\s*1003/);
    // The technical id (101) must NOT appear in the user-facing row no.
    expect(noEl.textContent).not.toContain('101');
  });

  it('falls back to id when request_no is missing (deploy-window cache)', async () => {
    renderWithClient([
      {
        ...baseAdvance,
        id: '99',
        // request_no intentionally omitted to simulate a stale row
        status: 'pending',
      },
    ]);
    const noEl = await screen.findByTestId('request-row-no');
    expect(noEl.textContent).toMatch(/رقم الطلب:\s*99/);
  });

  it('does NOT prefix the displayed request_no with REQ- / ADV- / LV-', async () => {
    renderWithClient([
      { ...baseAdvance, id: '202', request_no: 1010, status: 'disbursed' },
    ]);
    const noEl = await screen.findByTestId('request-row-no');
    // Spec: digits only.
    expect(noEl.textContent).not.toMatch(/REQ|ADV|LV|OT/);
    expect(noEl.textContent).toMatch(/^\s*رقم الطلب:\s*1010\s*$/);
  });

  it('groups legacy kind=advance under the same "طلبات السلف" section as advance_request (display continuity)', async () => {
    renderWithClient([
      {
        ...baseAdvance,
        id: '90',
        kind: 'advance', // legacy
        status: 'disbursed',
      },
      {
        ...baseAdvance,
        id: '91',
        kind: 'advance_request', // new
        status: 'disbursed',
      },
    ]);
    // Two "تم الصرف" status chips should render — one per row.
    // Scoped to row testid so the filter bar's "تم الصرف" tab
    // doesn't inflate the count.
    const rows = await screen.findAllByTestId('request-row');
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(within(row).getByText('تم الصرف')).toBeInTheDocument();
    }
    expect(screen.getByText(/طلبات السلف/)).toBeInTheDocument();
  });
});
