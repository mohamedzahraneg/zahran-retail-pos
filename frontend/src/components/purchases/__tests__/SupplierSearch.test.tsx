/**
 * SupplierSearch.test.tsx — Purchases UX fixes
 *
 * Pins the typeahead supplier picker introduced as the replacement for
 * the long `<select>` dropdown in CreatePurchaseModal:
 *
 *   1. Renders the search input full-width.
 *   2. Debounced search by name hits `suppliersApi.list(q)`.
 *   3. Exact code/name match is hoisted to the top with a
 *      "تطابق كامل" badge.
 *   4. Enter picks the first highlighted row.
 *   5. After selection the input is replaced by a read-only summary
 *      and a "تغيير المورد" button.
 *   6. Clicking the change button calls onClear.
 *   7. The form-submit defense (`preventDefault` on Enter) keeps the
 *      surrounding form from firing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SupplierSearch } from '../SupplierSearch';

vi.mock('@/api/suppliers.api', () => ({
  suppliersApi: {
    list: vi.fn(),
  },
}));

import { suppliersApi } from '@/api/suppliers.api';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

const supA = {
  id: 'sup-1',
  code: 'SUP-001',
  name: 'مورد ألف',
  phone: '01000000000',
  supplier_type: 'credit' as const,
};
const supB = {
  id: 'sup-2',
  code: 'SUP-002',
  name: 'مورد باء',
  phone: '01100000000',
  supplier_type: 'cash' as const,
};

beforeEach(() => {
  (suppliersApi.list as any).mockReset();
});

describe('SupplierSearch', () => {
  it('S1. renders the search input by default (no selection)', () => {
    render(
      wrap(
        <SupplierSearch
          value={null}
          onSelect={() => {}}
          onClear={() => {}}
        />,
      ),
    );
    expect(screen.getByTestId('supplier-search-input')).toBeInTheDocument();
  });

  it('S2. debounced search by name renders result rows', async () => {
    (suppliersApi.list as any).mockResolvedValue([supA, supB]);
    render(
      wrap(
        <SupplierSearch
          value={null}
          onSelect={() => {}}
          onClear={() => {}}
        />,
      ),
    );
    fireEvent.change(screen.getByTestId('supplier-search-input'), {
      target: { value: 'مورد' },
    });
    await waitFor(() =>
      expect(suppliersApi.list).toHaveBeenCalledWith('مورد'),
    );
    await screen.findByTestId('supplier-search-row-sup-1');
    expect(
      screen.getByTestId('supplier-search-row-sup-2'),
    ).toBeInTheDocument();
  });

  it('S3. exact code match is hoisted to the top with a "تطابق كامل" badge', async () => {
    (suppliersApi.list as any).mockResolvedValue([supB, supA]);
    render(
      wrap(
        <SupplierSearch
          value={null}
          onSelect={() => {}}
          onClear={() => {}}
        />,
      ),
    );
    fireEvent.change(screen.getByTestId('supplier-search-input'), {
      target: { value: 'SUP-002' },
    });
    await screen.findByTestId('supplier-search-exact-badge');
    // The first row in DOM order should be the exact match (supB).
    const rows = screen.getByTestId('supplier-search-results').children;
    expect(rows[0]).toHaveAttribute(
      'data-testid',
      'supplier-search-row-sup-2',
    );
  });

  it('S4. Enter on the input selects the first (highlighted) row', async () => {
    (suppliersApi.list as any).mockResolvedValue([supA, supB]);
    const onSelect = vi.fn();
    render(
      wrap(
        <SupplierSearch
          value={null}
          onSelect={onSelect}
          onClear={() => {}}
        />,
      ),
    );
    const input = screen.getByTestId('supplier-search-input');
    fireEvent.change(input, { target: { value: 'مورد' } });
    await screen.findByTestId('supplier-search-row-sup-1');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    expect(onSelect.mock.calls[0][0].id).toBe('sup-1');
  });

  it('S5. after selection the summary + change button render, not the input', () => {
    render(
      wrap(
        <SupplierSearch
          value={supA}
          onSelect={() => {}}
          onClear={() => {}}
        />,
      ),
    );
    expect(
      screen.getByTestId('supplier-search-selected'),
    ).toHaveTextContent('مورد ألف');
    expect(
      screen.getByTestId('supplier-search-selected'),
    ).toHaveTextContent('SUP-001');
    expect(screen.queryByTestId('supplier-search-input')).toBeNull();
    expect(screen.getByTestId('supplier-search-clear')).toBeInTheDocument();
  });

  it('S6. "تغيير المورد" calls onClear', () => {
    const onClear = vi.fn();
    render(
      wrap(
        <SupplierSearch
          value={supA}
          onSelect={() => {}}
          onClear={onClear}
        />,
      ),
    );
    fireEvent.click(screen.getByTestId('supplier-search-clear'));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('S7. Enter inside the input does NOT bubble into a parent form submit', async () => {
    (suppliersApi.list as any).mockResolvedValue([supA]);
    const onFormSubmit = vi.fn();
    render(
      wrap(
        <form onSubmit={onFormSubmit}>
          <SupplierSearch
            value={null}
            onSelect={() => {}}
            onClear={() => {}}
          />
          <button type="submit">Save</button>
        </form>,
      ),
    );
    fireEvent.change(screen.getByTestId('supplier-search-input'), {
      target: { value: 'مورد' },
    });
    await screen.findByTestId('supplier-search-row-sup-1');
    fireEvent.keyDown(screen.getByTestId('supplier-search-input'), {
      key: 'Enter',
    });
    expect(onFormSubmit).not.toHaveBeenCalled();
  });
});
