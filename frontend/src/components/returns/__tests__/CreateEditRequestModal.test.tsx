/**
 * CreateEditRequestModal.test.tsx — Phase 1 create-only contract.
 *
 * Pins:
 *   1. Modal renders title, warning banner, and three input fields.
 *   2. requested_action select exposes the 7 allowlisted Arabic options.
 *   3. Submit is disabled until reason ≥ 5 chars AND payload parses
 *      to a JSON object.
 *   4. Invalid payload (array / scalar / null / not-JSON) shows the
 *      Arabic error and keeps submit disabled.
 *   5. Short reason (< 5 chars) shows the Arabic error and keeps
 *      submit disabled.
 *   6. Successful submit (entity=return) calls
 *      `returnsApi.createReturnEditRequest` with the typed body, fires
 *      the success toast, invalidates the audit query, calls onSuccess,
 *      then closes via onClose.
 *   7. Successful submit (entity=exchange) hits the exchange wrapper
 *      instead — and never touches the return wrapper.
 *   8. BE-thrown error surfaces via toast.error with the BE message.
 *   9. ZERO mutation surface beyond the create endpoint — source-grep
 *      forbids any api.put / api.patch / api.delete / approve / reject
 *      / amendment / apply call from this component.
 *  10. Cancel button calls onClose without firing any API call.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  render,
  screen,
  waitFor,
  fireEvent,
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
  },
}));

import { returnsApi } from '@/api/returns.api';

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
});

// ─── UI shape ──────────────────────────────────────────────────────

describe('CreateEditRequestModal — UI shape', () => {
  it('renders the title, document subtitle, and warning banner', () => {
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

  it('exposes all 7 allowlisted requested_action options in Arabic', () => {
    renderModal();
    const select = screen.getByTestId(
      'create-edit-request-action',
    ) as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual([
      'update_header',
      'update_item',
      'remove_item',
      'replace_item',
      'price_change',
      'quantity_change',
      'reason_change',
    ]);
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toEqual([
      'تحديث بيانات عامة',
      'تعديل بند',
      'حذف بند',
      'استبدال منتج',
      'تعديل سعر',
      'تعديل كمية',
      'تعديل السبب',
    ]);
  });

  it('renders payload + reason fields and submit/cancel buttons', () => {
    renderModal();
    expect(
      screen.getByTestId('create-edit-request-payload'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('create-edit-request-reason'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('create-edit-request-submit'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('create-edit-request-cancel'),
    ).toBeInTheDocument();
  });
});

// ─── Validation gating ─────────────────────────────────────────────

describe('CreateEditRequestModal — validation', () => {
  it('disables submit until both fields are valid', async () => {
    renderModal();
    const submit = screen.getByTestId(
      'create-edit-request-submit',
    ) as HTMLButtonElement;
    expect(submit).toBeDisabled();

    // Valid payload only — still disabled (reason missing)
    fireEvent.change(
      screen.getByTestId('create-edit-request-payload'),
      { target: { value: '{"field":"unit_price","new_value":150}' } },
    );
    expect(submit).toBeDisabled();

    // Add a reason ≥ 5 chars → enabled
    fireEvent.change(
      screen.getByTestId('create-edit-request-reason'),
      { target: { value: 'سبب التعديل' } },
    );
    await waitFor(() => expect(submit).not.toBeDisabled());
  });

  it('rejects invalid JSON payloads with the Arabic error', () => {
    renderModal();
    const payload = screen.getByTestId('create-edit-request-payload');

    // Not JSON
    fireEvent.change(payload, { target: { value: 'not json' } });
    expect(
      screen.getByTestId('create-edit-request-payload-error').textContent,
    ).toMatch(/صيغة تفاصيل التعديل غير صحيحة/);

    // Array
    fireEvent.change(payload, { target: { value: '[1,2,3]' } });
    expect(
      screen.getByTestId('create-edit-request-payload-error'),
    ).toBeInTheDocument();

    // Scalar
    fireEvent.change(payload, { target: { value: '"hello"' } });
    expect(
      screen.getByTestId('create-edit-request-payload-error'),
    ).toBeInTheDocument();

    // null
    fireEvent.change(payload, { target: { value: 'null' } });
    expect(
      screen.getByTestId('create-edit-request-payload-error'),
    ).toBeInTheDocument();

    // Valid object → error disappears
    fireEvent.change(payload, { target: { value: '{"k":"v"}' } });
    expect(
      screen.queryByTestId('create-edit-request-payload-error'),
    ).not.toBeInTheDocument();
  });

  it('shows the Arabic short-reason error when reason length < 5', () => {
    renderModal();
    fireEvent.change(
      screen.getByTestId('create-edit-request-reason'),
      { target: { value: 'abc' } },
    );
    expect(
      screen.getByTestId('create-edit-request-reason-error').textContent,
    ).toMatch(/سبب طلب التعديل مطلوب ولا يقل عن 5 أحرف/);

    fireEvent.change(
      screen.getByTestId('create-edit-request-reason'),
      { target: { value: 'سبب كافٍ' } },
    );
    expect(
      screen.queryByTestId('create-edit-request-reason-error'),
    ).not.toBeInTheDocument();
  });
});

// ─── Submit happy path ────────────────────────────────────────────

describe('CreateEditRequestModal — submit', () => {
  it('calls createReturnEditRequest with the typed body when entity="return"', async () => {
    (returnsApi.createReturnEditRequest as any).mockResolvedValueOnce({
      id: 'er-1',
      parent_id: 'ret-1',
      document_no: 'RET-2026-000001',
      requested_action: 'price_change',
      requested_payload: { field: 'unit_price', new_value: 150 },
      before_snapshot: {},
      after_preview: null,
      reason_text: 'سعر صحيح',
      status: 'pending',
      requested_by: 'u-1',
      requested_by_name: 'مدير النظام',
      requested_at: '2026-05-09T08:00:00Z',
      reviewed_by: null,
      reviewed_by_name: null,
      reviewed_at: null,
      review_notes: null,
      source: 'edit_request',
    });

    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { onClose, onSuccess } = renderModal({
      entity: 'return',
      parentId: 'ret-1',
      qc,
    });

    fireEvent.change(
      screen.getByTestId('create-edit-request-action'),
      { target: { value: 'price_change' } },
    );
    fireEvent.change(
      screen.getByTestId('create-edit-request-payload'),
      {
        target: {
          value: '{"field":"unit_price","new_value":150}',
        },
      },
    );
    fireEvent.change(
      screen.getByTestId('create-edit-request-reason'),
      { target: { value: 'سعر صحيح' } },
    );

    fireEvent.click(screen.getByTestId('create-edit-request-submit'));

    await waitFor(() =>
      expect(returnsApi.createReturnEditRequest).toHaveBeenCalledTimes(1),
    );
    expect(returnsApi.createReturnEditRequest).toHaveBeenCalledWith(
      'ret-1',
      {
        requested_action: 'price_change',
        requested_payload: { field: 'unit_price', new_value: 150 },
        reason_text: 'سعر صحيح',
      },
    );
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

  it('hits the exchange wrapper when entity="exchange"', async () => {
    (returnsApi.createExchangeEditRequest as any).mockResolvedValueOnce({
      id: 'er-2',
      parent_id: 'exch-9',
      document_no: 'EXC-2026-000003',
      requested_action: 'remove_item',
      requested_payload: { item_id: 'i-1' },
      before_snapshot: {},
      after_preview: null,
      reason_text: 'العميل غيّر رأيه',
      status: 'pending',
      requested_by: 'u-1',
      requested_by_name: 'مدير النظام',
      requested_at: '2026-05-09T08:00:00Z',
      reviewed_by: null,
      reviewed_by_name: null,
      reviewed_at: null,
      review_notes: null,
      source: 'edit_request',
    });

    renderModal({
      entity: 'exchange',
      parentId: 'exch-9',
      documentNo: 'EXC-2026-000003',
    });

    fireEvent.change(
      screen.getByTestId('create-edit-request-action'),
      { target: { value: 'remove_item' } },
    );
    fireEvent.change(
      screen.getByTestId('create-edit-request-payload'),
      { target: { value: '{"item_id":"i-1"}' } },
    );
    fireEvent.change(
      screen.getByTestId('create-edit-request-reason'),
      { target: { value: 'العميل غيّر رأيه' } },
    );

    fireEvent.click(screen.getByTestId('create-edit-request-submit'));

    await waitFor(() =>
      expect(returnsApi.createExchangeEditRequest).toHaveBeenCalledTimes(1),
    );
    expect(returnsApi.createExchangeEditRequest).toHaveBeenCalledWith(
      'exch-9',
      {
        requested_action: 'remove_item',
        requested_payload: { item_id: 'i-1' },
        reason_text: 'العميل غيّر رأيه',
      },
    );
    expect(returnsApi.createReturnEditRequest).not.toHaveBeenCalled();
  });

  it('surfaces the BE error message via toast.error', async () => {
    (returnsApi.createReturnEditRequest as any).mockRejectedValueOnce({
      response: { data: { message: 'صلاحيتك غير كافية' } },
    });
    renderModal({ entity: 'return', parentId: 'ret-1' });

    fireEvent.change(
      screen.getByTestId('create-edit-request-payload'),
      { target: { value: '{"field":"x","new_value":1}' } },
    );
    fireEvent.change(
      screen.getByTestId('create-edit-request-reason'),
      { target: { value: 'سبب كافٍ' } },
    );
    fireEvent.click(screen.getByTestId('create-edit-request-submit'));

    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith('صلاحيتك غير كافية'),
    );
    expect(toastMocks.success).not.toHaveBeenCalled();
  });

  it('falls back to a generic Arabic error when BE returns no message', async () => {
    (returnsApi.createReturnEditRequest as any).mockRejectedValueOnce(
      new Error(''),
    );
    renderModal({ entity: 'return', parentId: 'ret-1' });

    fireEvent.change(
      screen.getByTestId('create-edit-request-payload'),
      { target: { value: '{"a":1}' } },
    );
    fireEvent.change(
      screen.getByTestId('create-edit-request-reason'),
      { target: { value: 'سبب كافٍ' } },
    );
    fireEvent.click(screen.getByTestId('create-edit-request-submit'));

    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith(
        'تعذّر إرسال طلب التعديل',
      ),
    );
  });
});

// ─── Cancel ────────────────────────────────────────────────────────

describe('CreateEditRequestModal — cancel', () => {
  it('calls onClose without firing any API call', () => {
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

  it('uses ONLY createReturnEditRequest / createExchangeEditRequest', () => {
    const apiCalls = code.match(/returnsApi\.\w+/g) ?? [];
    const allowed = new Set([
      'returnsApi.createReturnEditRequest',
      'returnsApi.createExchangeEditRequest',
    ]);
    for (const call of apiCalls) {
      expect(allowed.has(call)).toBe(true);
    }
  });
});
