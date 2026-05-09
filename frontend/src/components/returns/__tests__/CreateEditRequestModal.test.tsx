/**
 * CreateEditRequestModal.test.tsx — Phase 2 guided UI contract.
 *
 * The user should NEVER need to write JSON by hand.  These tests pin
 * that the new line-builder UI behaves correctly and that the payload
 * the modal POSTs is the strongly-shaped `kind: 'line_changes'` body.
 *
 * Pins:
 *   1. Modal renders title + warning banner; NO `requested_action`
 *      select picker; NO raw-JSON `requested_payload` textarea.
 *   2. Existing items render under "البنود الحالية".
 *   3. Editing a line price drives the live "ملخص التعديل" preview.
 *   4. Marking a line for removal moves it under "بند محذوف" in the
 *      preview and keeps a one-click "تراجع عن الحذف" affordance.
 *   5. Adding a new line via the form pushes it under "بند مضاف".
 *   6. Submit is gated on both (a) at least one effective change AND
 *      (b) a reason ≥ 5 chars; short reason still shows the Arabic
 *      validation error.
 *   7. Submit (return) calls `createReturnEditRequest` with the
 *      structured payload — `kind: 'line_changes'`, lines arrays,
 *      summary totals — never the exchange wrapper.
 *   8. Submit (exchange) hits the exchange wrapper after fetching the
 *      detail through `getExchange`.
 *   9. The derived `requested_action` is `price_change` when only one
 *      line's price changed, `remove_item` when only one line was
 *      removed, `update_item` for mixed/multi-line edits.
 *  10. BE error → Arabic toast.error, no close.
 *  11. Cancel calls onClose, fires zero API calls.
 *  12. Source-grep contract: zero api.put / api.patch / api.delete /
 *      approve / reject / apply references in the new component.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  render,
  screen,
  waitFor,
  fireEvent,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';

import { CreateEditRequestModal } from '@/components/returns/CreateEditRequestModal';

// ── Mocks ──────────────────────────────────────────────────────────

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('react-hot-toast', () => ({
  default: {
    success: toastMocks.success,
    error: toastMocks.error,
  },
}));

vi.mock('@/api/returns.api', () => ({
  returnsApi: {
    createReturnEditRequest: vi.fn(),
    createExchangeEditRequest: vi.fn(),
    get: vi.fn(),
    getExchange: vi.fn(),
  },
}));

vi.mock('@/api/products.api', () => ({
  productsApi: {
    byBarcode: vi.fn(),
  },
}));

import { returnsApi } from '@/api/returns.api';
import { productsApi } from '@/api/products.api';

// ── Fixtures ───────────────────────────────────────────────────────

const RETURN_FIXTURE = {
  id: 'ret-1',
  return_no: 'RET-2026-000001',
  status: 'pending',
  reason: 'defective',
  reason_details: null,
  notes: null,
  refund_method: 'cash',
  warehouse_id: 'wh-1',
  warehouse_name: 'المخزن الرئيسي',
  invoice_no: 'INV-001',
  invoice_date: '2026-05-01T00:00:00Z',
  customer_name: 'عميل تجريبي',
  customer_phone: null,
  total_refund: '450',
  restocking_fee: '0',
  net_refund: '450',
  requested_at: '2026-05-09T08:00:00Z',
  approved_at: null,
  refunded_at: null,
  rejected_at: null,
  original_invoice_id: 'inv-1',
  customer_id: null,
  items_count: 1,
  units_count: 1,
  requested_by_name: 'مدير النظام',
  approved_by_name: null,
  refunded_by_name: null,
  items: [
    {
      id: 'ri-1',
      original_invoice_item_id: 'oii-1',
      variant_id: 'var-1',
      product_name: 'تيشيرت أزرق',
      sku: 'SKU-AAA',
      color: 'أزرق',
      size: 'L',
      quantity: 1,
      unit_price: '450',
      refund_amount: '450',
      condition: 'resellable',
      back_to_stock: true,
      notes: null,
    },
    {
      id: 'ri-2',
      original_invoice_item_id: 'oii-2',
      variant_id: 'var-2',
      product_name: 'بنطلون أسود',
      sku: 'SKU-BBB',
      color: 'أسود',
      size: 'M',
      quantity: 2,
      unit_price: '300',
      refund_amount: '600',
      condition: 'resellable',
      back_to_stock: true,
      notes: null,
    },
  ],
} as any;

const EXCHANGE_FIXTURE = {
  id: 'exch-1',
  exchange_no: 'EXC-2026-000003',
  status: 'completed',
  returned_value: '450',
  new_items_value: '500',
  price_difference: '50',
  reason: null,
  reason_details: null,
  notes: null,
  refund_method: null,
  payment_method: 'cash',
  original_invoice_no: 'INV-007',
  new_invoice_no: 'INV-007-X',
  customer_name: null,
  created_at: '2026-05-09T08:00:00Z',
  completed_at: '2026-05-09T08:30:00Z',
  items: [
    {
      id: 'ei-1',
      exchange_id: 'exch-1',
      variant_id: 'var-9',
      kind: 'returned',
      quantity: 1,
      unit_price: '450',
      product_name: 'حذاء قديم',
      sku: 'SKU-OLD',
      color: 'بني',
      size: '42',
      notes: null,
    },
    {
      id: 'ei-2',
      exchange_id: 'exch-1',
      variant_id: 'var-10',
      kind: 'new',
      quantity: 1,
      unit_price: '500',
      product_name: 'حذاء جديد',
      sku: 'SKU-NEW',
      color: 'أسود',
      size: '42',
      notes: null,
    },
  ],
} as any;

// ── Helpers ────────────────────────────────────────────────────────

function renderModal(
  overrides: Partial<{
    entity: 'return' | 'exchange';
    parentId: string;
    documentNo: string | null;
    onClose: () => void;
    onSuccess: () => void;
    qc: QueryClient;
  }> = {},
) {
  const qc =
    overrides.qc ??
    new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
  const onClose = overrides.onClose ?? vi.fn();
  const onSuccess = overrides.onSuccess ?? vi.fn();
  const utils = render(
    <QueryClientProvider client={qc}>
      <CreateEditRequestModal
        entity={overrides.entity ?? 'return'}
        parentId={overrides.parentId ?? 'ret-1'}
        documentNo={overrides.documentNo ?? 'RET-2026-000001'}
        onClose={onClose}
        onSuccess={onSuccess}
      />
    </QueryClientProvider>,
  );
  return { ...utils, qc, onClose, onSuccess };
}

beforeEach(() => {
  vi.clearAllMocks();
  (returnsApi.get as any).mockResolvedValue(RETURN_FIXTURE);
  (returnsApi.getExchange as any).mockResolvedValue(EXCHANGE_FIXTURE);
});

// ─── UI shape ──────────────────────────────────────────────────────

describe('CreateEditRequestModal — guided-UI shape', () => {
  it('renders title + subtitle + warning banner', async () => {
    renderModal({ documentNo: 'RET-2026-000007' });
    expect(
      screen.getByTestId('create-edit-request-modal'),
    ).toBeInTheDocument();
    expect(screen.getByText('إنشاء طلب تعديل')).toBeInTheDocument();
    expect(screen.getByText(/RET-2026-000007/)).toBeInTheDocument();
    expect(
      screen.getByTestId('create-edit-request-warning').textContent,
    ).toMatch(
      /هذا الطلب لا يغيّر المرتجع أو الاستبدال الآن. سيتم إرساله للمراجعة وينتظر موافقة الأدمن/,
    );
  });

  it('exposes NO `requested_action` select picker (auto-derived)', async () => {
    renderModal();
    await waitFor(() =>
      expect(screen.getByTestId('er-existing-lines')).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId('create-edit-request-action'),
    ).not.toBeInTheDocument();
  });

  it('exposes NO raw-JSON requested_payload textarea (no JSON for users)', async () => {
    renderModal();
    await waitFor(() =>
      expect(screen.getByTestId('er-existing-lines')).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId('create-edit-request-payload'),
    ).not.toBeInTheDocument();
    // The reason textarea is the ONLY textarea kept.
    const textareas = screen.getAllByRole('textbox');
    const reasonTextarea = screen.getByTestId('create-edit-request-reason');
    expect(textareas).toContain(reasonTextarea);
  });

  it('renders existing items under "البنود الحالية"', async () => {
    renderModal();
    expect(await screen.findByText('البنود الحالية')).toBeInTheDocument();
    const ri1 = await screen.findByTestId('er-existing-line-ri-1');
    expect(ri1).toHaveTextContent('تيشيرت أزرق');
    expect(ri1).toHaveTextContent('SKU-AAA');
    const ri2 = screen.getByTestId('er-existing-line-ri-2');
    expect(ri2).toHaveTextContent('بنطلون أسود');
  });
});

// ─── Editing a line ───────────────────────────────────────────────

describe('CreateEditRequestModal — line editor', () => {
  it('lets the user change a line price and reflects it in the live diff', async () => {
    renderModal();
    fireEvent.click(
      await screen.findByTestId('er-existing-line-ri-1-edit'),
    );
    const priceInput = await screen.findByTestId('er-line-editor-price');
    fireEvent.change(priceInput, { target: { value: '400' } });

    // Live preview shows the updated row.
    await waitFor(() =>
      expect(screen.getByTestId('er-diff')).toBeInTheDocument(),
    );
    const updatedRows = screen.getAllByTestId('er-diff-updated-row');
    expect(updatedRows).toHaveLength(1);
    expect(updatedRows[0]).toHaveTextContent('السعر');
    expect(updatedRows[0]).toHaveTextContent('400');
  });

  it('marking a line for removal places it under "بند محذوف" with an undo affordance', async () => {
    renderModal();
    fireEvent.click(
      await screen.findByTestId('er-existing-line-ri-2-remove'),
    );
    await waitFor(() =>
      expect(screen.getByTestId('er-diff-removed-row')).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('er-existing-line-ri-2-undo'),
    ).toBeInTheDocument();
    // Undo restores: removed row disappears.
    fireEvent.click(screen.getByTestId('er-existing-line-ri-2-undo'));
    await waitFor(() =>
      expect(
        screen.queryByTestId('er-diff-removed-row'),
      ).not.toBeInTheDocument(),
    );
  });

  it('adding a new line via the gated lookup flow pushes it under "بند مضاف"', async () => {
    (productsApi.byBarcode as any).mockResolvedValue({
      product: { name_ar: 'منتج جديد' },
      variant: {
        id: 'var-resolved-1',
        sku: 'SKU-NEW-1',
        selling_price: '125',
      },
    });
    renderModal();
    await screen.findByTestId('er-existing-line-ri-1');

    // Form is hidden by default; toggle button is visible.
    expect(
      screen.queryByTestId('er-add-line-form'),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('er-add-line-toggle'));

    // Form renders.  SKU lookup is required first.
    expect(screen.getByTestId('er-add-line-form')).toBeInTheDocument();
    fireEvent.change(
      screen.getByTestId('er-add-line-lookup-sku-input'),
      { target: { value: 'SKU-NEW-1' } },
    );
    fireEvent.click(screen.getByTestId('er-add-line-lookup-search'));

    // Resolved → success card visible, qty/price inputs render.
    await waitFor(() =>
      expect(
        screen.getByTestId('er-add-line-lookup-resolved'),
      ).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByTestId('er-add-line-quantity'), {
      target: { value: '2' },
    });
    // Suggested price was pre-filled from variant.selling_price.

    fireEvent.click(screen.getByTestId('er-add-line-submit'));

    await waitFor(() =>
      expect(screen.getByTestId('er-diff-added-row')).toBeInTheDocument(),
    );
    const added = screen.getByTestId('er-diff-added-row');
    expect(added).toHaveTextContent('منتج جديد');
    expect(added).toHaveTextContent('SKU-NEW-1');
    // Drafts list under the form shows the same line.
    const drafts = screen.getByTestId('er-add-line-drafts');
    expect(within(drafts).getByText('منتج جديد')).toBeInTheDocument();
    // Form is closed again after a successful add.
    expect(
      screen.queryByTestId('er-add-line-form'),
    ).not.toBeInTheDocument();
  });
});

// ─── Product-lookup gating on add-new-line flow ────────────────────

describe('CreateEditRequestModal — add-new-line product lookup', () => {
  it('does NOT show the add-line form on modal open (button-gated)', async () => {
    renderModal();
    await screen.findByTestId('er-existing-line-ri-1');
    // The toggle button is visible.
    expect(screen.getByTestId('er-add-line-toggle')).toHaveTextContent(
      'إضافة منتج جديد لطلب التعديل',
    );
    // The form itself is NOT mounted.
    expect(
      screen.queryByTestId('er-add-line-form'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('er-add-line-lookup-sku-input'),
    ).not.toBeInTheDocument();
  });

  it('clicking the toggle button shows the form with the SKU lookup input', async () => {
    renderModal();
    fireEvent.click(await screen.findByTestId('er-add-line-toggle'));
    expect(screen.getByTestId('er-add-line-form')).toBeInTheDocument();
    expect(
      screen.getByTestId('er-add-line-lookup-sku-input'),
    ).toBeInTheDocument();
    // Toggle button is gone while the form is open.
    expect(
      screen.queryByTestId('er-add-line-toggle'),
    ).not.toBeInTheDocument();
  });

  it('cancel button hides the form, clears the draft, and re-shows the toggle', async () => {
    (productsApi.byBarcode as any).mockResolvedValue({
      product: { name_ar: 'منتج' },
      variant: { id: 'v-1', sku: 'X' },
    });
    renderModal();
    fireEvent.click(await screen.findByTestId('er-add-line-toggle'));
    fireEvent.change(
      screen.getByTestId('er-add-line-lookup-sku-input'),
      { target: { value: 'X' } },
    );
    fireEvent.click(screen.getByTestId('er-add-line-lookup-search'));
    await waitFor(() =>
      expect(
        screen.getByTestId('er-add-line-lookup-resolved'),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId('er-add-line-cancel'));
    expect(
      screen.queryByTestId('er-add-line-form'),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('er-add-line-toggle')).toBeInTheDocument();

    // Re-opening the form starts fresh: no resolved card, no draft.
    fireEvent.click(screen.getByTestId('er-add-line-toggle'));
    expect(
      screen.queryByTestId('er-add-line-lookup-resolved'),
    ).not.toBeInTheDocument();
    expect(
      (
        screen.getByTestId(
          'er-add-line-lookup-sku-input',
        ) as HTMLInputElement
      ).value,
    ).toBe('');
  });

  it('empty SKU blocks adding and shows "كود المنتج مطلوب"', async () => {
    renderModal();
    fireEvent.click(await screen.findByTestId('er-add-line-toggle'));
    fireEvent.click(screen.getByTestId('er-add-line-lookup-search'));
    expect(
      screen.getByTestId('er-add-line-lookup-error-empty').textContent,
    ).toMatch(/كود المنتج مطلوب/);
    expect(productsApi.byBarcode).not.toHaveBeenCalled();
    // No qty/price/notes/Add controls until resolved.
    expect(
      screen.queryByTestId('er-add-line-quantity'),
    ).not.toBeInTheDocument();
  });

  it('unknown SKU blocks adding and shows "كود المنتج غير موجود في قاعدة البيانات"', async () => {
    (productsApi.byBarcode as any).mockRejectedValueOnce(
      new Error('not found'),
    );
    renderModal();
    fireEvent.click(await screen.findByTestId('er-add-line-toggle'));
    fireEvent.change(
      screen.getByTestId('er-add-line-lookup-sku-input'),
      { target: { value: 'FAKE-SKU' } },
    );
    fireEvent.click(screen.getByTestId('er-add-line-lookup-search'));

    await waitFor(() =>
      expect(
        screen.getByTestId('er-add-line-lookup-error-not-found').textContent,
      ).toMatch(/كود المنتج غير موجود في قاعدة البيانات/),
    );
    // Add button stays disabled while no variant is resolved, so a
    // misclick can't push a fake row through.
    expect(
      screen.getByTestId('er-add-line-submit') as HTMLButtonElement,
    ).toBeDisabled();
    expect(
      screen.queryByTestId('er-diff-added-row'),
    ).not.toBeInTheDocument();
  });

  it('known SKU resolves the product and enables the Add button', async () => {
    (productsApi.byBarcode as any).mockResolvedValueOnce({
      product: { name_ar: 'منتج موجود', base_price: 200 },
      variant: { id: 'var-9', sku: 'SKU-OK', selling_price: '250' },
    });
    renderModal();
    fireEvent.click(await screen.findByTestId('er-add-line-toggle'));
    fireEvent.change(
      screen.getByTestId('er-add-line-lookup-sku-input'),
      { target: { value: 'SKU-OK' } },
    );
    fireEvent.click(screen.getByTestId('er-add-line-lookup-search'));

    const resolved = await screen.findByTestId(
      'er-add-line-lookup-resolved',
    );
    expect(resolved.textContent).toMatch(/تم العثور على المنتج/);
    expect(resolved.textContent).toMatch(/منتج موجود/);
    const submit = screen.getByTestId(
      'er-add-line-submit',
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
  });

  it('submitted payload includes the resolved variant_id + canonical SKU/name (no fakes possible)', async () => {
    (productsApi.byBarcode as any).mockResolvedValueOnce({
      product: { name_ar: 'منتج محسوم' },
      variant: { id: 'var-final', sku: 'SKU-CANON', selling_price: '99' },
    });
    (returnsApi.createReturnEditRequest as any).mockResolvedValue({ id: 'er' });
    renderModal();

    // Add the new line via the lookup flow.
    fireEvent.click(await screen.findByTestId('er-add-line-toggle'));
    fireEvent.change(
      screen.getByTestId('er-add-line-lookup-sku-input'),
      { target: { value: 'SKU-CANON' } },
    );
    fireEvent.click(screen.getByTestId('er-add-line-lookup-search'));
    await screen.findByTestId('er-add-line-lookup-resolved');
    fireEvent.click(screen.getByTestId('er-add-line-submit'));

    fireEvent.change(screen.getByTestId('create-edit-request-reason'), {
      target: { value: 'إضافة منتج بعد التحقق' },
    });
    await waitFor(() =>
      expect(
        (
          screen.getByTestId(
            'create-edit-request-submit',
          ) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByTestId('create-edit-request-submit'));

    await waitFor(() =>
      expect(returnsApi.createReturnEditRequest).toHaveBeenCalledTimes(1),
    );
    const [, body] = (returnsApi.createReturnEditRequest as any).mock
      .calls[0];
    expect(body.requested_payload.lines.added).toHaveLength(1);
    const addedLine = body.requested_payload.lines.added[0];
    expect(addedLine.variant_id).toBe('var-final');
    expect(addedLine.sku).toBe('SKU-CANON');
    expect(addedLine.name).toBe('منتج محسوم');
    // Defense in depth: requested_payload never carries an added line
    // with a null/empty variant_id, no matter what the user typed.
    for (const line of body.requested_payload.lines.added) {
      expect(line.variant_id).toBeTruthy();
      expect(typeof line.variant_id).toBe('string');
    }
  });
});

// ─── Product-replacement on existing line ──────────────────────────

describe('CreateEditRequestModal — replace product on existing line', () => {
  it('blocks replacement when the new SKU is unknown (no variant_id swap)', async () => {
    (productsApi.byBarcode as any).mockRejectedValueOnce(
      new Error('not found'),
    );
    renderModal();
    fireEvent.click(
      await screen.findByTestId('er-existing-line-ri-1-edit'),
    );
    fireEvent.click(
      screen.getByTestId('er-line-editor-ri-1-change-product'),
    );
    fireEvent.change(
      screen.getByTestId('er-line-editor-ri-1-lookup-sku-input'),
      { target: { value: 'BAD-SKU' } },
    );
    fireEvent.click(
      screen.getByTestId('er-line-editor-ri-1-lookup-search'),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId(
          'er-line-editor-ri-1-lookup-error-not-found',
        ).textContent,
      ).toMatch(/كود المنتج الجديد غير موجود/),
    );
    // Live diff still shows the original product identity (no swap
    // happened) — so no updated row exists for ri-1 yet.
    expect(
      screen.queryByTestId('er-diff-updated-row'),
    ).not.toBeInTheDocument();
  });

  it('updates after.variant_id when the new SKU is known', async () => {
    (productsApi.byBarcode as any).mockResolvedValueOnce({
      product: { name_ar: 'منتج بديل' },
      variant: {
        id: 'var-replacement',
        sku: 'SKU-REPL',
        selling_price: '600',
      },
    });
    (returnsApi.createReturnEditRequest as any).mockResolvedValue({ id: 'er' });
    renderModal();

    fireEvent.click(
      await screen.findByTestId('er-existing-line-ri-1-edit'),
    );
    fireEvent.click(
      screen.getByTestId('er-line-editor-ri-1-change-product'),
    );
    fireEvent.change(
      screen.getByTestId('er-line-editor-ri-1-lookup-sku-input'),
      { target: { value: 'SKU-REPL' } },
    );
    fireEvent.click(
      screen.getByTestId('er-line-editor-ri-1-lookup-search'),
    );
    await screen.findByTestId('er-line-editor-ri-1-lookup-resolved');

    // Snapshot updated → live diff shows the replacement.
    await waitFor(() =>
      expect(screen.getByTestId('er-diff-updated-row')).toBeInTheDocument(),
    );
    const updated = screen.getByTestId('er-diff-updated-row');
    expect(updated.textContent).toMatch(/منتج بديل/);
    expect(updated.textContent).toMatch(/SKU-REPL/);

    // Submit and confirm the payload carries the new variant_id.
    fireEvent.change(screen.getByTestId('create-edit-request-reason'), {
      target: { value: 'استبدال المنتج' },
    });
    await waitFor(() =>
      expect(
        (
          screen.getByTestId(
            'create-edit-request-submit',
          ) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByTestId('create-edit-request-submit'));
    await waitFor(() =>
      expect(returnsApi.createReturnEditRequest).toHaveBeenCalledTimes(1),
    );
    const [, body] = (returnsApi.createReturnEditRequest as any).mock
      .calls[0];
    const updatedLine = body.requested_payload.lines.updated[0];
    expect(updatedLine.before.variant_id).toBe('var-1');
    expect(updatedLine.after.variant_id).toBe('var-replacement');
    expect(updatedLine.after.sku).toBe('SKU-REPL');
    expect(updatedLine.after.name).toBe('منتج بديل');
  });
});

// ─── Submit gating ────────────────────────────────────────────────

describe('CreateEditRequestModal — submit gating', () => {
  it('keeps submit disabled when there are zero effective changes', async () => {
    renderModal();
    await screen.findByTestId('er-existing-line-ri-1');
    const submit = screen.getByTestId(
      'create-edit-request-submit',
    ) as HTMLButtonElement;
    expect(submit).toBeDisabled();
    // Even with a reason, no changes → still disabled.
    fireEvent.change(screen.getByTestId('create-edit-request-reason'), {
      target: { value: 'سبب كافٍ' },
    });
    expect(submit).toBeDisabled();
  });

  it('shows the Arabic short-reason error when reason length < 5', async () => {
    renderModal();
    fireEvent.change(
      await screen.findByTestId('create-edit-request-reason'),
      { target: { value: 'abc' } },
    );
    expect(
      screen.getByTestId('create-edit-request-reason-error').textContent,
    ).toMatch(/سبب طلب التعديل مطلوب ولا يقل عن 5 أحرف/);
  });
});

// ─── Submit happy path ────────────────────────────────────────────

describe('CreateEditRequestModal — submit (return)', () => {
  it('posts a structured `kind:line_changes` payload with derived price_change action', async () => {
    (productsApi.byBarcode as any).mockResolvedValue({
      product: { name_ar: 'منتج بحث' },
      variant: { id: 'resolved-var', sku: 'SKU-AAA' },
    });
    (returnsApi.createReturnEditRequest as any).mockResolvedValue({
      id: 'er-1',
    });
    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { onClose, onSuccess } = renderModal({ qc });

    // Edit ri-1 price 450 → 400 (single dimension on a single line).
    fireEvent.click(
      await screen.findByTestId('er-existing-line-ri-1-edit'),
    );
    fireEvent.change(await screen.findByTestId('er-line-editor-price'), {
      target: { value: '400' },
    });
    fireEvent.change(screen.getByTestId('create-edit-request-reason'), {
      target: { value: 'العميل اعترض على السعر' },
    });

    await waitFor(() =>
      expect(
        (screen.getByTestId(
          'create-edit-request-submit',
        ) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByTestId('create-edit-request-submit'));

    await waitFor(() =>
      expect(returnsApi.createReturnEditRequest).toHaveBeenCalledTimes(1),
    );
    const [calledId, calledBody] = (
      returnsApi.createReturnEditRequest as any
    ).mock.calls[0];
    expect(calledId).toBe('ret-1');
    expect(calledBody.requested_action).toBe('price_change');
    expect(calledBody.reason_text).toBe('العميل اعترض على السعر');
    expect(calledBody.requested_payload.kind).toBe('line_changes');
    expect(calledBody.requested_payload.lines.updated).toHaveLength(1);
    expect(calledBody.requested_payload.lines.updated[0].item_id).toBe(
      'ri-1',
    );
    expect(
      calledBody.requested_payload.lines.updated[0].before.unit_price,
    ).toBe(450);
    expect(
      calledBody.requested_payload.lines.updated[0].after.unit_price,
    ).toBe(400);
    expect(calledBody.requested_payload.lines.removed).toEqual([]);
    expect(calledBody.requested_payload.lines.added).toEqual([]);
    expect(calledBody.requested_payload.summary.old_total).toBe(1050);
    expect(calledBody.requested_payload.summary.new_total).toBe(1000);
    expect(calledBody.requested_payload.summary.delta).toBe(-50);

    expect(returnsApi.createExchangeEditRequest).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(toastMocks.success).toHaveBeenCalledWith(
        'تم إرسال طلب التعديل وينتظر موافقة الأدمن',
      ),
    );
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['audit', 'return', 'ret-1'],
      }),
    );
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('derives requested_action=remove_item when a single line is removed', async () => {
    (returnsApi.createReturnEditRequest as any).mockResolvedValue({
      id: 'er-2',
    });
    renderModal();
    fireEvent.click(
      await screen.findByTestId('er-existing-line-ri-1-remove'),
    );
    fireEvent.change(screen.getByTestId('create-edit-request-reason'), {
      target: { value: 'لا يحتاج البند الأول' },
    });
    await waitFor(() =>
      expect(
        (screen.getByTestId(
          'create-edit-request-submit',
        ) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByTestId('create-edit-request-submit'));

    await waitFor(() =>
      expect(returnsApi.createReturnEditRequest).toHaveBeenCalledTimes(1),
    );
    const [, body] = (returnsApi.createReturnEditRequest as any).mock
      .calls[0];
    expect(body.requested_action).toBe('remove_item');
    expect(body.requested_payload.lines.removed).toHaveLength(1);
    expect(body.requested_payload.lines.removed[0].item_id).toBe('ri-1');
  });

  it('derives requested_action=update_item for mixed multi-line edits', async () => {
    (returnsApi.createReturnEditRequest as any).mockResolvedValue({
      id: 'er-3',
    });
    renderModal();
    // Edit ri-1 quantity AND remove ri-2 → multiple changes.
    fireEvent.click(
      await screen.findByTestId('er-existing-line-ri-1-edit'),
    );
    fireEvent.change(await screen.findByTestId('er-line-editor-quantity'), {
      target: { value: '3' },
    });
    fireEvent.click(screen.getByTestId('er-existing-line-ri-2-remove'));
    fireEvent.change(screen.getByTestId('create-edit-request-reason'), {
      target: { value: 'تعديل متعدد على البنود' },
    });
    await waitFor(() =>
      expect(
        (screen.getByTestId(
          'create-edit-request-submit',
        ) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByTestId('create-edit-request-submit'));

    await waitFor(() =>
      expect(returnsApi.createReturnEditRequest).toHaveBeenCalledTimes(1),
    );
    const [, body] = (returnsApi.createReturnEditRequest as any).mock
      .calls[0];
    expect(body.requested_action).toBe('update_item');
  });
});

describe('CreateEditRequestModal — submit (exchange)', () => {
  it('hits the exchange wrapper after fetching detail via getExchange', async () => {
    (returnsApi.createExchangeEditRequest as any).mockResolvedValue({
      id: 'er-4',
    });
    renderModal({
      entity: 'exchange',
      parentId: 'exch-1',
      documentNo: 'EXC-2026-000003',
    });
    // The modal queries getExchange to load items.
    await waitFor(() =>
      expect(returnsApi.getExchange).toHaveBeenCalledWith('exch-1'),
    );
    expect(returnsApi.get).not.toHaveBeenCalled();

    fireEvent.click(
      await screen.findByTestId('er-existing-line-ei-1-remove'),
    );
    fireEvent.change(screen.getByTestId('create-edit-request-reason'), {
      target: { value: 'لا يلزم رد هذا البند' },
    });
    await waitFor(() =>
      expect(
        (screen.getByTestId(
          'create-edit-request-submit',
        ) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByTestId('create-edit-request-submit'));

    await waitFor(() =>
      expect(returnsApi.createExchangeEditRequest).toHaveBeenCalledTimes(1),
    );
    expect(returnsApi.createReturnEditRequest).not.toHaveBeenCalled();
  });
});

// ─── Error + cancel ───────────────────────────────────────────────

describe('CreateEditRequestModal — error + cancel', () => {
  it('surfaces BE error message via toast.error and does not close', async () => {
    (returnsApi.createReturnEditRequest as any).mockRejectedValueOnce({
      response: { data: { message: 'صلاحيتك غير كافية' } },
    });
    const { onClose } = renderModal();
    fireEvent.click(
      await screen.findByTestId('er-existing-line-ri-1-remove'),
    );
    fireEvent.change(screen.getByTestId('create-edit-request-reason'), {
      target: { value: 'محاولة' },
    });
    await waitFor(() =>
      expect(
        (screen.getByTestId(
          'create-edit-request-submit',
        ) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByTestId('create-edit-request-submit'));
    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith('صلاحيتك غير كافية'),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('cancel button calls onClose without firing any API call', () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByTestId('create-edit-request-cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(returnsApi.createReturnEditRequest).not.toHaveBeenCalled();
    expect(returnsApi.createExchangeEditRequest).not.toHaveBeenCalled();
  });
});

// ─── Source-grep — strict create-only contract ─────────────────────

describe('CreateEditRequestModal — create-only contract (source-grep)', () => {
  const src = readFileSync(
    'src/components/returns/CreateEditRequestModal.tsx',
    'utf-8',
  );
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('does not call api.put / api.patch / api.delete', () => {
    expect(code).not.toMatch(/api\.put\(/);
    expect(code).not.toMatch(/api\.patch\(/);
    expect(code).not.toMatch(/api\.delete\(/);
  });

  it('does not invoke approve / reject / amendment / apply endpoints', () => {
    expect(code).not.toMatch(/approveEditRequest/);
    expect(code).not.toMatch(/rejectEditRequest/);
    expect(code).not.toMatch(/applyEditRequest/);
    expect(code).not.toMatch(/Amendment/i);
  });

  it('only mutation surface is createReturnEditRequest / createExchangeEditRequest', () => {
    // returnsApi.X usages observed in the component — restrict to the
    // allowed read + create methods.
    const allowed = new Set([
      'returnsApi.get',
      'returnsApi.getExchange',
      'returnsApi.createReturnEditRequest',
      'returnsApi.createExchangeEditRequest',
    ]);
    const calls = code.match(/returnsApi\.\w+/g) ?? [];
    for (const call of calls) {
      expect(allowed.has(call)).toBe(true);
    }
  });
});

// ─── Source-grep — ProductLookupInput is GET-only ─────────────────

describe('ProductLookupInput — GET-only contract (source-grep)', () => {
  const src = readFileSync(
    'src/components/returns/edit-request/productLookup.tsx',
    'utf-8',
  );
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('does not call api.put / api.patch / api.delete / api.post', () => {
    expect(code).not.toMatch(/api\.put\(/);
    expect(code).not.toMatch(/api\.patch\(/);
    expect(code).not.toMatch(/api\.delete\(/);
    expect(code).not.toMatch(/api\.post\(/);
  });

  it('only product API used is byBarcode (GET)', () => {
    const calls = code.match(/productsApi\.\w+/g) ?? [];
    for (const call of calls) {
      expect(call).toBe('productsApi.byBarcode');
    }
  });

  it('does not invoke any return / exchange / edit-request mutation', () => {
    expect(code).not.toMatch(/returnsApi/);
    expect(code).not.toMatch(/createReturnEditRequest/);
    expect(code).not.toMatch(/createExchangeEditRequest/);
    expect(code).not.toMatch(/approveEditRequest/);
    expect(code).not.toMatch(/rejectEditRequest/);
    expect(code).not.toMatch(/applyEditRequest/);
  });
});
