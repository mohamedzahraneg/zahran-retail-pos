/**
 * LandedCostsSection.test.tsx — PR-PURCHASES-P2.2
 *
 * Pins the controlled-component contract of LandedCostsSection:
 *   · Empty state messaging when there are no items.
 *   · Add-row callback shape (sort_order auto-assigned).
 *   · Capitalize toggle keeps allocation method dropdown reachable.
 *   · Allocation method dropdown surfaces Arabic labels.
 *   · Manual allocation mismatch surfaces the Arabic error.
 *   · Remove row recomputes sort_order.
 *
 * The component is purely controlled; we exercise it as a thin wrapper
 * with a parent that holds the row state.
 */
import { describe, it, expect } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  LandedCostsSection,
  type LandedCostsSectionLine,
} from '../LandedCostsSection';
import {
  createEmptyExtraCostRow,
  type ExtraCostRow,
} from '../landedCostState';

interface HarnessProps {
  initialRows?: ExtraCostRow[];
  lines?: LandedCostsSectionLine[];
  errors?: Record<number, string>;
  capitalizedTotal?: number;
  nonCapitalizedTotal?: number;
}

function Harness({
  initialRows = [],
  lines = [],
  errors = {},
  capitalizedTotal = 0,
  nonCapitalizedTotal = 0,
}: HarnessProps) {
  const [rows, setRows] = useState<ExtraCostRow[]>(initialRows);
  return (
    <>
      <LandedCostsSection
        rows={rows}
        lines={lines}
        capitalizedTotal={capitalizedTotal}
        nonCapitalizedTotal={nonCapitalizedTotal}
        errors={errors}
        onChange={setRows}
      />
      <pre data-testid="harness-state">{JSON.stringify(rows)}</pre>
    </>
  );
}

const ONE_LINE: LandedCostsSectionLine[] = [
  { variant_id: 'v1', display: 'صنف 1', quantity: 4, base_unit_cost: 50 },
];
const TWO_LINES: LandedCostsSectionLine[] = [
  ...ONE_LINE,
  { variant_id: 'v2', display: 'صنف 2', quantity: 6, base_unit_cost: 100 },
];

describe('LandedCostsSection — empty state', () => {
  it('disables add button and shows empty hint when no items', () => {
    render(<Harness />);
    const addBtn = screen.getByTestId('landed-costs-add-row');
    expect(addBtn).toBeDisabled();
    expect(screen.getByTestId('landed-costs-empty-hint')).toBeInTheDocument();
  });
});

describe('LandedCostsSection — add + edit', () => {
  it('add button is enabled with at least one line and appends a defaulted row', () => {
    render(<Harness lines={ONE_LINE} />);
    const addBtn = screen.getByTestId('landed-costs-add-row');
    expect(addBtn).not.toBeDisabled();
    fireEvent.click(addBtn);
    expect(screen.getByTestId('landed-cost-row-0')).toBeInTheDocument();
    const state = JSON.parse(
      screen.getByTestId('harness-state').textContent || '[]',
    );
    expect(state).toHaveLength(1);
    expect(state[0].cost_type).toBe('transport');
    expect(state[0].allocation_method).toBe('by_value');
    expect(state[0].capitalize_to_inventory).toBe(true);
    expect(state[0].sort_order).toBe(0);
  });

  it('typing into the amount field bubbles up via onChange', () => {
    render(
      <Harness
        lines={ONE_LINE}
        initialRows={[createEmptyExtraCostRow()]}
      />,
    );
    const amountInput = screen.getByTestId('landed-cost-amount-0');
    fireEvent.change(amountInput, { target: { value: '125.5' } });
    const state = JSON.parse(
      screen.getByTestId('harness-state').textContent || '[]',
    );
    expect(state[0].amount).toBe(125.5);
  });
});

describe('LandedCostsSection — capitalize toggle', () => {
  it('toggling capitalize off hides the allocation method dropdown', () => {
    render(
      <Harness
        lines={ONE_LINE}
        initialRows={[createEmptyExtraCostRow()]}
      />,
    );
    expect(screen.getByTestId('landed-cost-method-0')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('landed-cost-capitalize-0'));
    expect(screen.queryByTestId('landed-cost-method-0')).toBeNull();
  });
});

describe('LandedCostsSection — allocation method', () => {
  it('renders the three Arabic-labeled method options', () => {
    render(
      <Harness
        lines={ONE_LINE}
        initialRows={[createEmptyExtraCostRow()]}
      />,
    );
    const select = screen.getByTestId('landed-cost-method-0') as HTMLSelectElement;
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toEqual(
      expect.arrayContaining(['حسب قيمة المنتجات', 'حسب الكمية', 'يدوي']),
    );
  });

  it('switching to manual surfaces the per-variant sub-table', () => {
    render(
      <Harness
        lines={TWO_LINES}
        initialRows={[createEmptyExtraCostRow()]}
      />,
    );
    const select = screen.getByTestId('landed-cost-method-0');
    fireEvent.change(select, { target: { value: 'manual' } });
    expect(screen.getByTestId('landed-cost-manual-0')).toBeInTheDocument();
    expect(
      screen.getByTestId('landed-cost-manual-input-0-v1'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('landed-cost-manual-input-0-v2'),
    ).toBeInTheDocument();
  });
});

describe('LandedCostsSection — error surfacing', () => {
  it('renders the Arabic error string for the indexed row', () => {
    const initialRow: ExtraCostRow = {
      ...createEmptyExtraCostRow(),
      amount: 80,
      allocation_method: 'manual',
      manual_allocations: [{ variant_id: 'v1', amount: 70 }],
    };
    render(
      <Harness
        lines={ONE_LINE}
        initialRows={[initialRow]}
        errors={{
          0: 'إجمالي التوزيع اليدوي للمصاريف يجب أن يساوي قيمة المصروف.',
        }}
      />,
    );
    const errBox = screen.getByTestId('landed-cost-error-0');
    expect(errBox).toHaveTextContent(
      'إجمالي التوزيع اليدوي للمصاريف يجب أن يساوي قيمة المصروف.',
    );
  });
});

describe('LandedCostsSection — remove row', () => {
  it('clicking remove drops the row and reindexes sort_order', () => {
    const r1 = { ...createEmptyExtraCostRow(), label: 'first' };
    const r2 = { ...createEmptyExtraCostRow(), label: 'second' };
    render(<Harness lines={ONE_LINE} initialRows={[r1, r2]} />);
    expect(screen.getByTestId('landed-cost-row-0')).toBeInTheDocument();
    expect(screen.getByTestId('landed-cost-row-1')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('landed-cost-remove-0'));
    const state = JSON.parse(
      screen.getByTestId('harness-state').textContent || '[]',
    );
    expect(state).toHaveLength(1);
    expect(state[0].label).toBe('second');
    expect(state[0].sort_order).toBe(0);
  });
});
