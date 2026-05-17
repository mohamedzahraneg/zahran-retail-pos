/**
 * ApplyPricesModal.test.tsx — PR-PURCHASES-P3.2
 *
 * Pins the controlled apply-prices confirmation modal:
 *   · renders the rows table with old/new/diff/strategy
 *   · the confirm button sends the right payload to apply-prices
 *   · on success, parent gets a list of row indexes to clear
 *   · 403 surfaces the Arabic permission error and does NOT clear
 *     pending markers
 *   · clicking cancel never fires the API
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ApplyPricesModal,
  type ApplyPricesItem,
} from '../ApplyPricesModal';

const applyMock = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock('react-hot-toast', () => ({
  default: {
    success: (...args: any[]) => toastSuccess(...args),
    error: (...args: any[]) => toastError(...args),
  },
}));

vi.mock('@/api/products.api', async () => {
  const actual = await vi.importActual<any>('@/api/products.api');
  return {
    ...actual,
    productsApi: {
      applyVariantPrices: (body: any) => applyMock(body),
    },
  };
});

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

const ITEMS: ApplyPricesItem[] = [
  {
    row_index: 0,
    variant_id: 'v-1',
    display: 'صنف 1',
    current_selling_price: 100,
    new_selling_price: 145,
    strategy: 'recommended',
  },
  {
    row_index: 2,
    variant_id: 'v-2',
    display: 'صنف 2',
    current_selling_price: 200,
    new_selling_price: 220,
    strategy: 'high_margin',
  },
];

beforeEach(() => {
  applyMock.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
});

describe('ApplyPricesModal — P3.2', () => {
  it('renders the rows table with old / new / diff / strategy', () => {
    render(
      wrap(
        <ApplyPricesModal
          open
          items={ITEMS}
          onClose={() => {}}
          onApplied={() => {}}
        />,
      ),
    );
    expect(screen.getByTestId('apply-prices-modal')).toBeInTheDocument();
    expect(screen.getByTestId('apply-prices-disclaimer')).toHaveTextContent(
      'لن يتم تعديل الفاتورة الحالية أو المخزون أو القيود المحاسبية.',
    );
    expect(screen.getByTestId('apply-prices-row-v-1')).toHaveTextContent('صنف 1');
    expect(screen.getByTestId('apply-prices-row-v-1')).toHaveTextContent('موصى به');
    expect(screen.getByTestId('apply-prices-row-v-2')).toHaveTextContent('هامش عالي');
  });

  it('clicking confirm sends only {variant_id, new_selling_price} per item', async () => {
    applyMock.mockResolvedValue({
      updated: 2,
      skipped: 0,
      items: ITEMS.map((it) => ({
        variant_id: it.variant_id,
        old_selling_price: it.current_selling_price!,
        new_selling_price: it.new_selling_price,
        history_id: `hist-${it.variant_id}`,
        skipped: false,
      })),
    });
    const onApplied = vi.fn();
    const onClose = vi.fn();
    render(
      wrap(
        <ApplyPricesModal
          open
          items={ITEMS}
          sourcePurchaseId="pur-abc"
          onClose={onClose}
          onApplied={onApplied}
        />,
      ),
    );
    fireEvent.click(screen.getByTestId('apply-prices-confirm'));
    await waitFor(() => expect(applyMock).toHaveBeenCalledTimes(1));
    const body = applyMock.mock.calls[0][0];
    expect(body.source_purchase_id).toBe('pur-abc');
    expect(body.items).toEqual([
      { variant_id: 'v-1', new_selling_price: 145 },
      { variant_id: 'v-2', new_selling_price: 220 },
    ]);
    expect(body.items[0]).not.toHaveProperty('strategy');
    expect(body.items[0]).not.toHaveProperty('current_selling_price');
    await waitFor(() => expect(onApplied).toHaveBeenCalledWith([0, 2]));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('403 surfaces Arabic permission error and does NOT call onApplied', async () => {
    applyMock.mockRejectedValue({
      response: { status: 403, data: {} },
    });
    const onApplied = vi.fn();
    render(
      wrap(
        <ApplyPricesModal
          open
          items={ITEMS}
          onClose={() => {}}
          onApplied={onApplied}
        />,
      ),
    );
    fireEvent.click(screen.getByTestId('apply-prices-confirm'));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError.mock.calls[0][0]).toBe(
      'ليس لديك صلاحية تحديث أسعار البيع.',
    );
    expect(onApplied).not.toHaveBeenCalled();
  });

  it('cancel button never fires the API', () => {
    const onClose = vi.fn();
    render(
      wrap(
        <ApplyPricesModal
          open
          items={ITEMS}
          onClose={onClose}
          onApplied={() => {}}
        />,
      ),
    );
    const cancelButtons = screen.getAllByText('إلغاء');
    fireEvent.click(cancelButtons[0]);
    expect(applyMock).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closed (open=false) renders nothing', () => {
    const { container } = render(
      wrap(
        <ApplyPricesModal
          open={false}
          items={ITEMS}
          onClose={() => {}}
          onApplied={() => {}}
        />,
      ),
    );
    expect(container.firstChild).toBeNull();
  });
});
