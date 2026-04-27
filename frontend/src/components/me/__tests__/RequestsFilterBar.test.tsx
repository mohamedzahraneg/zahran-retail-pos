/**
 * RequestsFilterBar.test.tsx — PR-ESS-2C-2
 *
 * Pins the controlled-component contract for the filter strip shared
 * between MyRequestsCard and ApprovalsAuditTab. The bar is purely
 * presentational — it reflects whatever `filters` the parent passes
 * and forwards every change through `onChange`. Asserts:
 *
 *   1. Default state (empty filters) shows "الكل" and "كل الأنواع"
 *      as active selections.
 *   2. Clicking a status tab emits the correct status key (and resets
 *      offset so pagination doesn't drift to a non-existent page).
 *   3. Selecting a kind emits the correct kind key.
 *   4. Picking "all" status / kind clears the field rather than
 *      sending the literal string "all" to the backend.
 *   5. The "مسح التصفية" reset button only appears when at least one
 *      filter is active and clears every filter.
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { RequestsFilterBar } from '../RequestsFilterBar';
import type { RequestFilters } from '@/api/employees.api';

describe('<RequestsFilterBar />', () => {
  it('with empty filters, "الكل" status tab is active and clear-button is hidden', () => {
    render(<RequestsFilterBar filters={{}} onChange={() => undefined} />);
    const allTab = screen.getByTestId('requests-filter-bar-status-all');
    expect(allTab.getAttribute('aria-pressed')).toBe('true');
    // Clear button only appears when at least one filter is set.
    expect(screen.queryByTestId('requests-filter-bar-clear')).toBeNull();
  });

  it('clicking a status tab emits the corresponding status key and clears offset', () => {
    const onChange = vi.fn();
    render(
      <RequestsFilterBar
        filters={{ offset: 50 }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('requests-filter-bar-status-disbursed'));
    expect(onChange).toHaveBeenCalledWith({
      offset: undefined,
      status: 'disbursed',
    });
  });

  it('clicking the "الكل" tab clears the status filter (not "all" literal)', () => {
    const onChange = vi.fn();
    render(
      <RequestsFilterBar
        filters={{ status: 'pending' }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('requests-filter-bar-status-all'));
    expect(onChange).toHaveBeenCalledWith({
      status: undefined,
      offset: undefined,
    });
  });

  it('changing the kind dropdown emits the matching key', () => {
    const onChange = vi.fn();
    render(<RequestsFilterBar filters={{}} onChange={onChange} />);
    const select = screen.getByTestId('requests-filter-bar-kind') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'leave' } });
    expect(onChange).toHaveBeenCalledWith({
      kind: 'leave',
      offset: undefined,
    });
  });

  it('selecting "كل الأنواع" clears the kind filter', () => {
    const onChange = vi.fn();
    render(
      <RequestsFilterBar
        filters={{ kind: 'advance_request' }}
        onChange={onChange}
      />,
    );
    const select = screen.getByTestId('requests-filter-bar-kind') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'all' } });
    expect(onChange).toHaveBeenCalledWith({
      kind: undefined,
      offset: undefined,
    });
  });

  it('with any filter active, "مسح التصفية" appears and clears every filter', () => {
    const onChange = vi.fn();
    const initial: RequestFilters = {
      kind: 'leave',
      status: 'rejected',
      from: '2026-04-01',
      to: '2026-04-30',
      offset: 25,
      limit: 50,
    };
    render(<RequestsFilterBar filters={initial} onChange={onChange} />);
    const clear = screen.getByTestId('requests-filter-bar-clear');
    fireEvent.click(clear);
    expect(onChange).toHaveBeenCalledWith({
      kind: undefined,
      status: undefined,
      from: undefined,
      to: undefined,
      offset: undefined,
      // limit is preserved (page-size choice survives clearing filters).
      limit: 50,
    });
  });

  it('honors a custom testIdPrefix so multiple bars on one page don\'t collide', () => {
    render(
      <RequestsFilterBar
        filters={{}}
        onChange={() => undefined}
        testIdPrefix="my-requests-filter"
      />,
    );
    expect(
      screen.getByTestId('my-requests-filter-status-all'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('my-requests-filter-kind')).toBeInTheDocument();
  });
});
