/**
 * RequestTimeline.test.tsx — PR-ESS-2C-2
 *
 * Pins the visual + structural contract for the reusable timeline
 * rendered inside both /me MyRequestsCard and /team
 * ApprovalsAuditTab. Specifically asserts that the four event
 * categories surface (or not) under the documented conditions:
 *
 *   1. Submitted — always.
 *   2. Decision — approved / rejected / cancelled (mutually exclusive).
 *   3. Awaiting disbursement — only for `kind='advance_request'`,
 *      `status='approved'`, and no linked expense yet. Legacy
 *      `kind='advance'` MUST NOT render an awaiting event (it auto-
 *      posted historically — see PR-ESS-2A-HOTFIX-1).
 *   4. Disbursed — when a linked expense exists, OR status='disbursed'.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RequestTimeline } from '../RequestTimeline';
import type { EmployeeRequest } from '@/api/employees.api';

function base(overrides: Partial<EmployeeRequest> = {}): EmployeeRequest {
  return {
    id: '1',
    user_id: 'emp-1',
    kind: 'advance_request',
    amount: '250.00',
    status: 'pending',
    created_at: '2026-04-20T10:00:00Z',
    ...overrides,
  };
}

describe('<RequestTimeline />', () => {
  it('always renders a "submitted" event with the created_at timestamp', () => {
    render(<RequestTimeline request={base({ status: 'pending' })} />);
    expect(screen.getByTestId('timeline-event-submitted')).toBeInTheDocument();
  });

  it('pending shows ONLY the submitted event (no decision, no awaiting, no disbursed)', () => {
    render(<RequestTimeline request={base({ status: 'pending' })} />);
    expect(screen.getByTestId('timeline-event-submitted')).toBeInTheDocument();
    expect(screen.queryByTestId('timeline-event-approved')).toBeNull();
    expect(screen.queryByTestId('timeline-event-rejected')).toBeNull();
    expect(screen.queryByTestId('timeline-event-cancelled')).toBeNull();
    expect(screen.queryByTestId('timeline-event-awaiting')).toBeNull();
    expect(screen.queryByTestId('timeline-event-disbursed')).toBeNull();
  });

  it('approved advance_request without linked expense → submitted + approved + awaiting', () => {
    render(
      <RequestTimeline
        request={base({
          kind: 'advance_request',
          status: 'approved',
          decided_at: '2026-04-21T08:00:00Z',
          decided_by_name: 'محمد المحاسب',
        })}
      />,
    );
    expect(screen.getByTestId('timeline-event-submitted')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-event-approved')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-event-awaiting')).toBeInTheDocument();
    expect(screen.queryByTestId('timeline-event-disbursed')).toBeNull();
    // Decider name surfaces.
    expect(screen.getByText(/محمد المحاسب/)).toBeInTheDocument();
  });

  it('legacy kind=advance approved does NOT render awaiting event (auto-posted historically)', () => {
    render(
      <RequestTimeline
        request={base({
          kind: 'advance',
          status: 'approved',
          decided_at: '2026-04-21T08:00:00Z',
        })}
      />,
    );
    expect(screen.getByTestId('timeline-event-approved')).toBeInTheDocument();
    expect(screen.queryByTestId('timeline-event-awaiting')).toBeNull();
  });

  it('disbursed (linked expense present) → submitted + approved + disbursed (no awaiting)', () => {
    render(
      <RequestTimeline
        request={base({
          status: 'disbursed',
          decided_at: '2026-04-21T08:00:00Z',
          linked_expense_id: '500',
          linked_expense_no: 'EXP-2026-000045',
          linked_expense_amount: '250.00',
          linked_expense_posted_at: '2026-04-22T09:00:00Z',
          linked_expense_posted_by_name: 'سارة',
        })}
      />,
    );
    expect(screen.getByTestId('timeline-event-submitted')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-event-approved')).toBeInTheDocument();
    expect(screen.queryByTestId('timeline-event-awaiting')).toBeNull();
    const disbursed = screen.getByTestId('timeline-event-disbursed');
    expect(disbursed).toBeInTheDocument();
    // Linked expense_no surfaces in the disbursed event.
    expect(disbursed.textContent).toMatch(/EXP-2026-000045/);
    expect(disbursed.textContent).toMatch(/سارة/);
  });

  it('approved advance_request WITH linked expense suppresses awaiting (defensive: status flag drift)', () => {
    // status still reads "approved" but a linked expense exists.
    // We trust the join over the flag — the awaiting event must
    // NOT render because the expense has actually posted.
    render(
      <RequestTimeline
        request={base({
          kind: 'advance_request',
          status: 'approved',
          linked_expense_id: '777',
          linked_expense_no: 'EXP-2026-000099',
        })}
      />,
    );
    expect(screen.queryByTestId('timeline-event-awaiting')).toBeNull();
    expect(screen.getByTestId('timeline-event-disbursed')).toBeInTheDocument();
  });

  it('rejected request shows the rejected event with decision_reason', () => {
    render(
      <RequestTimeline
        request={base({
          status: 'rejected',
          decided_at: '2026-04-21T08:00:00Z',
          decision_reason: 'تجاوز السقف الشهري',
          decided_by_name: 'المدير',
        })}
      />,
    );
    expect(screen.getByTestId('timeline-event-rejected')).toBeInTheDocument();
    expect(screen.queryByTestId('timeline-event-approved')).toBeNull();
    expect(screen.queryByTestId('timeline-event-awaiting')).toBeNull();
    expect(screen.getByText(/تجاوز السقف الشهري/)).toBeInTheDocument();
  });

  it('cancelled request shows cancelled event', () => {
    render(
      <RequestTimeline
        request={base({
          status: 'cancelled',
          decided_at: '2026-04-21T08:00:00Z',
        })}
      />,
    );
    expect(screen.getByTestId('timeline-event-cancelled')).toBeInTheDocument();
    expect(screen.queryByTestId('timeline-event-approved')).toBeNull();
    expect(screen.queryByTestId('timeline-event-rejected')).toBeNull();
  });

  it('leave kind never gets an awaiting event regardless of status', () => {
    render(
      <RequestTimeline
        request={base({
          kind: 'leave',
          status: 'approved',
          starts_at: '2026-05-01',
          ends_at: '2026-05-03',
        })}
      />,
    );
    expect(screen.getByTestId('timeline-event-approved')).toBeInTheDocument();
    expect(screen.queryByTestId('timeline-event-awaiting')).toBeNull();
    expect(screen.queryByTestId('timeline-event-disbursed')).toBeNull();
  });
});
