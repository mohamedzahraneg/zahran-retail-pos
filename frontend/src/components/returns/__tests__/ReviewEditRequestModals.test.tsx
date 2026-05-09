/**
 * ReviewEditRequestModals.test.tsx — admin approve/reject status-only.
 *
 * Pins:
 *   1. Approve modal opens with the "no payload applied" warning copy.
 *   2. Approve confirm calls `approveReturnEditRequest` ONLY (never
 *      apply / amendment / reject endpoints) with the optional review
 *      notes when provided.
 *   3. Approve success → toast + invalidates `['audit', entity, id]`
 *      + closes modal.
 *   4. Approve modal hits the exchange wrapper when entity='exchange'.
 *   5. Reject modal blocks confirm until review_notes ≥ 5 chars and
 *      shows "سبب الرفض مطلوب ولا يقل عن 5 أحرف".
 *   6. Reject confirm calls `rejectReturnEditRequest` with the typed
 *      review_notes; success toast + invalidate + close.
 *   7. Reject modal hits the exchange wrapper for entity='exchange'.
 *   8. BE error → toast.error with BE message, no close.
 *   9. Cancel button calls onClose without firing any API call.
 *  10. Source-grep: no PATCH/PUT/DELETE; no apply/amendment endpoints;
 *      only the four allowed review wrappers callable from the file.
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

import {
  ApproveEditRequestModal,
  RejectEditRequestModal,
} from '@/components/returns/ReviewEditRequestModals';

// ── Mocks ──────────────────────────────────────────────────────────

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('react-hot-toast', () => ({
  default: { success: toastMocks.success, error: toastMocks.error },
}));

vi.mock('@/api/returns.api', () => ({
  returnsApi: {
    approveReturnEditRequest: vi.fn(),
    rejectReturnEditRequest: vi.fn(),
    approveExchangeEditRequest: vi.fn(),
    rejectExchangeEditRequest: vi.fn(),
  },
}));

import { returnsApi } from '@/api/returns.api';

// ── Fixture ────────────────────────────────────────────────────────

const PENDING_REQUEST = {
  id: 'er-1',
  parent_id: 'ret-1',
  document_no: 'RET-2026-000001',
  requested_action: 'price_change',
  requested_payload: {
    kind: 'line_changes',
    lines: {
      updated: [
        {
          item_id: 'ri-1',
          before: {
            variant_id: 'var-a',
            sku: 'SKU-AAA',
            name: 'تيشيرت أزرق',
            quantity: 1,
            unit_price: 450,
          },
          after: {
            variant_id: 'var-a',
            sku: 'SKU-AAA',
            name: 'تيشيرت أزرق',
            quantity: 1,
            unit_price: 400,
          },
        },
      ],
      removed: [],
      added: [],
    },
    summary: { old_total: 450, new_total: 400, delta: -50 },
  },
  before_snapshot: {},
  after_preview: null,
  reason_text: 'العميل اعترض على السعر',
  status: 'pending' as const,
  requested_by: 'u-2',
  requested_by_name: 'محمد كاشير',
  requested_at: '2026-05-09T13:00:00Z',
  reviewed_by: null,
  reviewed_by_name: null,
  reviewed_at: null,
  review_notes: null,
  source: 'edit_request' as const,
};

// ── Helpers ────────────────────────────────────────────────────────

function renderApprove(
  overrides: Partial<{
    entity: 'return' | 'exchange';
    parentId: string;
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
      <ApproveEditRequestModal
        entity={overrides.entity ?? 'return'}
        parentId={overrides.parentId ?? 'ret-1'}
        request={PENDING_REQUEST as any}
        onClose={onClose}
        onSuccess={onSuccess}
      />
    </QueryClientProvider>,
  );
  return { ...utils, qc, onClose, onSuccess };
}

function renderReject(
  overrides: Partial<{
    entity: 'return' | 'exchange';
    parentId: string;
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
      <RejectEditRequestModal
        entity={overrides.entity ?? 'return'}
        parentId={overrides.parentId ?? 'ret-1'}
        request={PENDING_REQUEST as any}
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

// ─── Approve modal ────────────────────────────────────────────────

describe('ApproveEditRequestModal', () => {
  it('renders summary + the "no payload applied" warning + optional notes field', () => {
    renderApprove();
    expect(
      screen.getByTestId('approve-edit-request-modal'),
    ).toBeInTheDocument();
    expect(screen.getByText('اعتماد طلب التعديل')).toBeInTheDocument();
    expect(screen.getByText(/RET-2026-000001/)).toBeInTheDocument();
    expect(
      screen.getByTestId('approve-edit-request-warning').textContent,
    ).toMatch(
      /اعتماد الطلب لا يطبق التعديل على المرتجع أو الاستبدال الآن. سيتم تغيير حالة الطلب فقط/,
    );
    // Summary block carries the requested action + reason.
    const summary = screen.getByTestId('review-request-summary');
    expect(summary.textContent).toMatch(/تعديل سعر/);
    expect(summary.textContent).toMatch(/العميل اعترض على السعر/);
    // Notes field is present (optional).
    expect(
      screen.getByTestId('approve-edit-request-notes'),
    ).toBeInTheDocument();
  });

  it('confirm calls approveReturnEditRequest with optional review_notes and never an apply endpoint', async () => {
    (returnsApi.approveReturnEditRequest as any).mockResolvedValueOnce({
      ...PENDING_REQUEST,
      status: 'approved',
    });
    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { onClose, onSuccess } = renderApprove({ qc });

    fireEvent.change(screen.getByTestId('approve-edit-request-notes'), {
      target: { value: 'موافق' },
    });
    fireEvent.click(screen.getByTestId('approve-edit-request-confirm'));

    await waitFor(() =>
      expect(returnsApi.approveReturnEditRequest).toHaveBeenCalledTimes(1),
    );
    expect(returnsApi.approveReturnEditRequest).toHaveBeenCalledWith(
      'ret-1',
      'er-1',
      { review_notes: 'موافق' },
    );
    // Must never touch the exchange wrapper or any reject path.
    expect(returnsApi.approveExchangeEditRequest).not.toHaveBeenCalled();
    expect(returnsApi.rejectReturnEditRequest).not.toHaveBeenCalled();
    expect(returnsApi.rejectExchangeEditRequest).not.toHaveBeenCalled();

    await waitFor(() =>
      expect(toastMocks.success).toHaveBeenCalledWith(
        'تم اعتماد طلب التعديل. لم يتم تطبيق التعديل بعد.',
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

  it('omits review_notes from the body when the textarea is empty', async () => {
    (returnsApi.approveReturnEditRequest as any).mockResolvedValueOnce({});
    renderApprove();
    fireEvent.click(screen.getByTestId('approve-edit-request-confirm'));
    await waitFor(() =>
      expect(returnsApi.approveReturnEditRequest).toHaveBeenCalledTimes(1),
    );
    const [, , body] = (returnsApi.approveReturnEditRequest as any).mock
      .calls[0];
    expect(body).toEqual({});
  });

  it('hits the exchange wrapper when entity="exchange"', async () => {
    (returnsApi.approveExchangeEditRequest as any).mockResolvedValueOnce({});
    renderApprove({ entity: 'exchange', parentId: 'exch-1' });
    fireEvent.click(screen.getByTestId('approve-edit-request-confirm'));
    await waitFor(() =>
      expect(returnsApi.approveExchangeEditRequest).toHaveBeenCalledWith(
        'exch-1',
        'er-1',
        {},
      ),
    );
    expect(returnsApi.approveReturnEditRequest).not.toHaveBeenCalled();
  });

  it('surfaces BE error and does not close', async () => {
    (returnsApi.approveReturnEditRequest as any).mockRejectedValueOnce({
      response: { data: { message: 'صلاحيتك غير كافية' } },
    });
    const { onClose } = renderApprove();
    fireEvent.click(screen.getByTestId('approve-edit-request-confirm'));
    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith('صلاحيتك غير كافية'),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('cancel calls onClose without firing any API call', () => {
    const { onClose } = renderApprove();
    fireEvent.click(screen.getByTestId('approve-edit-request-cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(returnsApi.approveReturnEditRequest).not.toHaveBeenCalled();
    expect(returnsApi.approveExchangeEditRequest).not.toHaveBeenCalled();
  });
});

// ─── Reject modal ─────────────────────────────────────────────────

describe('RejectEditRequestModal', () => {
  it('renders the request summary + required reason textarea', () => {
    renderReject();
    expect(
      screen.getByTestId('reject-edit-request-modal'),
    ).toBeInTheDocument();
    expect(screen.getByText('رفض طلب التعديل')).toBeInTheDocument();
    expect(
      screen.getByTestId('reject-edit-request-notes'),
    ).toBeInTheDocument();
  });

  it('blocks confirm until review_notes ≥ 5 chars and shows the Arabic error', () => {
    renderReject();
    const confirm = screen.getByTestId(
      'reject-edit-request-confirm',
    ) as HTMLButtonElement;
    expect(confirm).toBeDisabled();

    // Short reason → still disabled, error visible.
    fireEvent.change(screen.getByTestId('reject-edit-request-notes'), {
      target: { value: 'abc' },
    });
    expect(confirm).toBeDisabled();
    expect(
      screen.getByTestId('reject-edit-request-notes-error').textContent,
    ).toMatch(/سبب الرفض مطلوب ولا يقل عن 5 أحرف/);

    // Long enough → enabled.
    fireEvent.change(screen.getByTestId('reject-edit-request-notes'), {
      target: { value: 'سبب كافٍ للرفض' },
    });
    expect(confirm).not.toBeDisabled();
    expect(
      screen.queryByTestId('reject-edit-request-notes-error'),
    ).not.toBeInTheDocument();
  });

  it('confirm calls rejectReturnEditRequest with review_notes, fires success toast, invalidates + closes', async () => {
    (returnsApi.rejectReturnEditRequest as any).mockResolvedValueOnce({
      ...PENDING_REQUEST,
      status: 'rejected',
    });
    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { onClose, onSuccess } = renderReject({ qc });

    fireEvent.change(screen.getByTestId('reject-edit-request-notes'), {
      target: { value: 'لا توجد صلاحية للموافقة على هذا التغيير' },
    });
    fireEvent.click(screen.getByTestId('reject-edit-request-confirm'));

    await waitFor(() =>
      expect(returnsApi.rejectReturnEditRequest).toHaveBeenCalledTimes(1),
    );
    expect(returnsApi.rejectReturnEditRequest).toHaveBeenCalledWith(
      'ret-1',
      'er-1',
      { review_notes: 'لا توجد صلاحية للموافقة على هذا التغيير' },
    );
    expect(returnsApi.approveReturnEditRequest).not.toHaveBeenCalled();
    expect(returnsApi.rejectExchangeEditRequest).not.toHaveBeenCalled();

    await waitFor(() =>
      expect(toastMocks.success).toHaveBeenCalledWith(
        'تم رفض طلب التعديل',
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
    (returnsApi.rejectExchangeEditRequest as any).mockResolvedValueOnce({});
    renderReject({ entity: 'exchange', parentId: 'exch-1' });
    fireEvent.change(screen.getByTestId('reject-edit-request-notes'), {
      target: { value: 'سبب كافٍ' },
    });
    fireEvent.click(screen.getByTestId('reject-edit-request-confirm'));
    await waitFor(() =>
      expect(returnsApi.rejectExchangeEditRequest).toHaveBeenCalledWith(
        'exch-1',
        'er-1',
        { review_notes: 'سبب كافٍ' },
      ),
    );
    expect(returnsApi.rejectReturnEditRequest).not.toHaveBeenCalled();
  });

  it('surfaces BE error and does not close', async () => {
    (returnsApi.rejectReturnEditRequest as any).mockRejectedValueOnce({
      response: { data: { message: 'فشل بالخادم' } },
    });
    const { onClose } = renderReject();
    fireEvent.change(screen.getByTestId('reject-edit-request-notes'), {
      target: { value: 'سبب كافٍ' },
    });
    fireEvent.click(screen.getByTestId('reject-edit-request-confirm'));
    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith('فشل بالخادم'),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('cancel calls onClose without firing any API call', () => {
    const { onClose } = renderReject();
    fireEvent.click(screen.getByTestId('reject-edit-request-cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(returnsApi.rejectReturnEditRequest).not.toHaveBeenCalled();
    expect(returnsApi.rejectExchangeEditRequest).not.toHaveBeenCalled();
  });
});

// ─── Source-grep — strict status-only contract ─────────────────────

describe('ReviewEditRequestModals — status-only contract (source-grep)', () => {
  const src = readFileSync(
    'src/components/returns/ReviewEditRequestModals.tsx',
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

  it('does not call api.post directly (uses returnsApi wrappers only)', () => {
    expect(code).not.toMatch(/api\.post\(/);
  });

  it('does not invoke any apply / amendment / reverse / replay endpoints', () => {
    expect(code).not.toMatch(/applyEditRequest/);
    expect(code).not.toMatch(/Amendment/i);
    expect(code).not.toMatch(/\breverse\b/i);
    expect(code).not.toMatch(/\breplay\b/i);
  });

  it('only API surface is the four review wrappers (approve/reject × return/exchange)', () => {
    const allowed = new Set([
      'returnsApi.approveReturnEditRequest',
      'returnsApi.rejectReturnEditRequest',
      'returnsApi.approveExchangeEditRequest',
      'returnsApi.rejectExchangeEditRequest',
    ]);
    const calls = code.match(/returnsApi\.\w+/g) ?? [];
    for (const call of calls) {
      expect(allowed.has(call)).toBe(true);
    }
  });

  it('does not touch JE / CT / SM / accounting / financial-engine surfaces', () => {
    expect(code).not.toMatch(/AccountingPostingService/);
    expect(code).not.toMatch(/FinancialEngineService/);
    expect(code).not.toMatch(/journal_entries/);
    expect(code).not.toMatch(/journal_lines/);
    expect(code).not.toMatch(/cashbox_transactions/);
    expect(code).not.toMatch(/stock_movements/);
    expect(code).not.toMatch(/accounting_only/);
  });
});
