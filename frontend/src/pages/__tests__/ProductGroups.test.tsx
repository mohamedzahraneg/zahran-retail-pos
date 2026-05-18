/**
 * ProductGroups.test.tsx — PR-P9.1a
 *
 * Pins the manual product-groups page UX:
 *   1. List renders with member_count.
 *   2. Create modal validates name_ar.
 *   3. Edit/save calls update.
 *   4. Deactivate (soft-delete) calls remove + confirms.
 *   5. Add-variant search calls productsApi.list({ q }).
 *   6. Selecting a variant + confirm fires addVariants with variant_ids.
 *   7. Remove member fires removeVariant.
 *   8. Defensive: no apply/mutation calls to prices, cost, purchases, POS.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ProductGroups from '../ProductGroups';

const listMock = vi.fn();
const getMock = vi.fn();
const createMock = vi.fn();
const updateMock = vi.fn();
const removeMock = vi.fn();
const addVariantsMock = vi.fn();
const removeVariantMock = vi.fn();

const productsListMock = vi.fn();
const productsGetMock = vi.fn();

// Defensive mutation spies — must remain at zero throughout.
const applyPricesMock = vi.fn();
const smartApplyMock = vi.fn();
const costApplyMock = vi.fn();
const productPatchMock = vi.fn();
const variantPatchMock = vi.fn();
const purchaseCreateMock = vi.fn();
const purchasePatchMock = vi.fn();
const purchasePayMock = vi.fn();
const posCreateMock = vi.fn();
const journalCreateMock = vi.fn();

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

const realConfirm = window.confirm;
beforeEach(() => {
  window.confirm = vi.fn().mockReturnValue(true);
});
afterEach(() => {
  window.confirm = realConfirm;
});

vi.mock('@/api/productGroups.api', async () => {
  const actual = await vi.importActual<any>('@/api/productGroups.api');
  return {
    ...actual,
    productGroupsApi: {
      list: (p: any) => listMock(p),
      get: (id: string) => getMock(id),
      create: (b: any) => createMock(b),
      update: (id: string, b: any) => updateMock(id, b),
      remove: (id: string) => removeMock(id),
      addVariants: (id: string, b: any) => addVariantsMock(id, b),
      removeVariant: (id: string, v: string) => removeVariantMock(id, v),
    },
  };
});

vi.mock('@/api/products.api', async () => {
  const actual = await vi.importActual<any>('@/api/products.api');
  return {
    ...actual,
    productsApi: {
      ...((actual as any).productsApi ?? {}),
      list: (p: any) => productsListMock(p),
      get: (id: string) => productsGetMock(id),
      // Defensive spies on the apply surfaces.
      applyVariantPrices: (b: any) => applyPricesMock(b),
      smartPricingApply: (b: any) => smartApplyMock(b),
      costAdjustmentApply: (b: any) => costApplyMock(b),
      update: (id: string, b: any) => productPatchMock(id, b),
      updateVariant: (id: string, b: any) => variantPatchMock(id, b),
    },
  };
});

vi.mock('@/api/purchases.api', () => ({
  purchasesApi: {
    create: (b: any) => purchaseCreateMock(b),
    edit: (id: string, b: any) => purchasePatchMock(id, b),
    pay: (id: string, b: any) => purchasePayMock(id, b),
  },
}));

vi.mock('@/api/pos.api', () => ({
  posApi: {
    createSale: (b: any) => posCreateMock(b),
  },
}));

vi.mock('@/api/accounting.api', () => ({
  accountingApi: {
    createJournalEntry: (b: any) => journalCreateMock(b),
  },
}));

const GROUPS = [
  {
    id: 'g1',
    name_ar: 'مجموعة الصيف',
    name_en: 'Summer',
    description: 'تخفيضات الصيف',
    color: '#22c55e',
    is_active: true,
    created_at: '2026-05-18T00:00:00Z',
    updated_at: '2026-05-18T00:00:00Z',
    member_count: 2,
  },
];

const GROUP_DETAIL = {
  ...GROUPS[0],
  members: [
    {
      variant_id: 'v1',
      added_at: '2026-05-18T00:00:00Z',
      sku: 'A-1',
      barcode: null,
      current_cost_price: '50.00',
      current_selling_price: '100.00',
      variant_is_active: true,
      product_id: 'p1',
      product_name: 'صنف ألف',
      color_name: 'أحمر',
      size_label: '40',
      stock_on_hand: 5,
    },
  ],
};

beforeEach(() => {
  listMock.mockReset();
  getMock.mockReset();
  createMock.mockReset();
  updateMock.mockReset();
  removeMock.mockReset();
  addVariantsMock.mockReset();
  removeVariantMock.mockReset();
  productsListMock.mockReset();
  productsGetMock.mockReset();
  applyPricesMock.mockReset();
  smartApplyMock.mockReset();
  costApplyMock.mockReset();
  productPatchMock.mockReset();
  variantPatchMock.mockReset();
  purchaseCreateMock.mockReset();
  purchasePatchMock.mockReset();
  purchasePayMock.mockReset();
  posCreateMock.mockReset();
  journalCreateMock.mockReset();
  listMock.mockResolvedValue(GROUPS);
  getMock.mockResolvedValue(GROUP_DETAIL);
  createMock.mockResolvedValue({ ...GROUPS[0], id: 'g-new' });
  updateMock.mockResolvedValue(GROUPS[0]);
  removeMock.mockResolvedValue({ deactivated: true, id: 'g1' });
  addVariantsMock.mockResolvedValue({
    group_id: 'g1',
    requested: 1,
    added: 1,
    skipped: 0,
    member_count: 3,
  });
  removeVariantMock.mockResolvedValue({
    group_id: 'g1',
    variant_id: 'v1',
    removed: true,
    member_count: 1,
  });
});

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ProductGroups />
    </QueryClientProvider>,
  );
}

describe('ProductGroups — P9.1a', () => {
  it('1. list renders with member_count', async () => {
    renderPage();
    await screen.findByTestId('product-group-row-g1');
    expect(screen.getByText('مجموعة الصيف')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(listMock).toHaveBeenCalledWith(
      expect.objectContaining({ is_active: true }),
    );
  });

  it('2. create modal validates name_ar (save disabled until non-blank)', async () => {
    renderPage();
    await screen.findByTestId('product-group-row-g1');
    fireEvent.click(screen.getByTestId('product-groups-new'));
    await screen.findByTestId('product-group-form-modal');
    const save = screen.getByTestId('product-group-save');
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByTestId('product-group-name-ar'), {
      target: { value: 'مجموعة جديدة' },
    });
    expect(save).not.toBeDisabled();
    fireEvent.click(save);
    await waitFor(() => expect(createMock).toHaveBeenCalled());
    expect(createMock.mock.calls[0][0].name_ar).toBe('مجموعة جديدة');
  });

  it('3. edit modal calls update with the changed fields', async () => {
    renderPage();
    await screen.findByTestId('product-group-row-g1');
    fireEvent.click(screen.getByTestId('product-group-edit-g1'));
    await screen.findByTestId('product-group-form-modal');
    // Detail is fetched + preloads inputs after the useMemo init pass.
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    const nameInput = screen.getByTestId('product-group-name-ar');
    fireEvent.change(nameInput, { target: { value: 'مجموعة الصيف 2' } });
    fireEvent.click(screen.getByTestId('product-group-save'));
    await waitFor(() => expect(updateMock).toHaveBeenCalled());
    const [id, body] = updateMock.mock.calls[0];
    expect(id).toBe('g1');
    expect(body.name_ar).toBe('مجموعة الصيف 2');
  });

  it('4. deactivate (soft-delete) confirms then calls remove', async () => {
    renderPage();
    await screen.findByTestId('product-group-row-g1');
    fireEvent.click(screen.getByTestId('product-group-deactivate-g1'));
    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith('g1'));
  });

  it('5. variant search calls productsApi.list({ q }) at >= 2 chars', async () => {
    productsListMock.mockResolvedValueOnce({ data: [], meta: {} });
    renderPage();
    await screen.findByTestId('product-group-row-g1');
    fireEvent.click(screen.getByTestId('product-group-toggle-g1'));
    const search = await screen.findByTestId('product-group-add-search');
    fireEvent.change(search, { target: { value: 'ab' } });
    await waitFor(() =>
      expect(productsListMock).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'ab' }),
      ),
    );
  });

  it('6. selecting a variant and confirming fires addVariants with variant_ids', async () => {
    productsListMock.mockResolvedValueOnce({
      data: [
        {
          id: 'p2',
          name_ar: 'صنف باء',
          variants_count: 1,
        },
      ],
      meta: {},
    });
    productsGetMock.mockResolvedValueOnce({
      id: 'p2',
      name_ar: 'صنف باء',
      variants: [
        { id: 'v-new', product_id: 'p2', sku: 'B-1', color: 'أزرق', size: '42' },
      ],
    });
    renderPage();
    await screen.findByTestId('product-group-row-g1');
    fireEvent.click(screen.getByTestId('product-group-toggle-g1'));
    await screen.findByTestId('product-group-add-search');
    fireEvent.change(screen.getByTestId('product-group-add-search'), {
      target: { value: 'باء' },
    });
    await waitFor(() => expect(productsListMock).toHaveBeenCalled());
    fireEvent.click(await screen.findByTestId('product-group-product-p2'));
    await waitFor(() => expect(productsGetMock).toHaveBeenCalledWith('p2'));
    fireEvent.click(
      await screen.findByTestId('product-group-variant-toggle-v-new'),
    );
    fireEvent.click(await screen.findByTestId('product-group-add-confirm'));
    await waitFor(() =>
      expect(addVariantsMock).toHaveBeenCalledWith('g1', {
        variant_ids: ['v-new'],
      }),
    );
  });

  it('7. remove member fires removeVariant', async () => {
    renderPage();
    await screen.findByTestId('product-group-row-g1');
    fireEvent.click(screen.getByTestId('product-group-toggle-g1'));
    await screen.findByTestId('product-group-member-v1');
    fireEvent.click(screen.getByTestId('product-group-member-remove-v1'));
    await waitFor(() =>
      expect(removeVariantMock).toHaveBeenCalledWith('g1', 'v1'),
    );
  });

  it('8. defensive: no apply / mutation endpoints fire for the whole UX', async () => {
    productsListMock.mockResolvedValueOnce({
      data: [{ id: 'p2', name_ar: 'باء', variants_count: 1 }],
      meta: {},
    });
    productsGetMock.mockResolvedValueOnce({
      id: 'p2',
      variants: [{ id: 'v-new', product_id: 'p2', sku: 'B-1' }],
    });
    renderPage();
    await screen.findByTestId('product-group-row-g1');
    // Exercise: create + open + search + select + add + remove.
    fireEvent.click(screen.getByTestId('product-groups-new'));
    await screen.findByTestId('product-group-form-modal');
    fireEvent.change(screen.getByTestId('product-group-name-ar'), {
      target: { value: 'X' },
    });
    fireEvent.click(screen.getByTestId('product-group-save'));
    await waitFor(() => expect(createMock).toHaveBeenCalled());

    // Defensive spies stay at zero throughout.
    expect(applyPricesMock).not.toHaveBeenCalled();
    expect(smartApplyMock).not.toHaveBeenCalled();
    expect(costApplyMock).not.toHaveBeenCalled();
    expect(productPatchMock).not.toHaveBeenCalled();
    expect(variantPatchMock).not.toHaveBeenCalled();
    expect(purchaseCreateMock).not.toHaveBeenCalled();
    expect(purchasePatchMock).not.toHaveBeenCalled();
    expect(purchasePayMock).not.toHaveBeenCalled();
    expect(posCreateMock).not.toHaveBeenCalled();
    expect(journalCreateMock).not.toHaveBeenCalled();
  });
});
