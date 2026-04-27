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
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MyRequestsCard } from '../MyRequestsCard';
import type { EmployeeRequest } from '@/api/employees.api';

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
    expect(await screen.findByText('قيد المراجعة')).toBeInTheDocument();
  });

  it('renders approved advance with "موافق عليه" + "بانتظار الصرف" subtext', async () => {
    renderWithClient([{ ...baseAdvance, status: 'approved' }]);
    expect(await screen.findByText('موافق عليه')).toBeInTheDocument();
    expect(
      screen.getByText(/بانتظار الصرف من قِبَل المحاسبة/),
    ).toBeInTheDocument();
  });

  it('renders disbursed advance with "تم الصرف" green chip and NO "بانتظار" subtext', async () => {
    renderWithClient([{ ...baseAdvance, status: 'disbursed' }]);
    expect(await screen.findByText('تم الصرف')).toBeInTheDocument();
    // The "بانتظار الصرف" hint must NOT appear once the request is
    // disbursed — the green badge IS the disbursed signal.
    expect(
      screen.queryByText(/بانتظار الصرف من قِبَل المحاسبة/),
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
    expect(await screen.findByText('مرفوض')).toBeInTheDocument();
    expect(screen.getByText(/سبب الرفض: مكرر/)).toBeInTheDocument();
  });

  it('renders cancelled advance with slate tone "ملغي"', async () => {
    renderWithClient([{ ...baseAdvance, status: 'cancelled' }]);
    expect(await screen.findByText('ملغي')).toBeInTheDocument();
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
    // Two "تم الصرف" chips should both render under the advance section.
    const disbursedChips = await screen.findAllByText('تم الصرف');
    expect(disbursedChips.length).toBe(2);
    expect(screen.getByText(/طلبات السلف/)).toBeInTheDocument();
  });
});
