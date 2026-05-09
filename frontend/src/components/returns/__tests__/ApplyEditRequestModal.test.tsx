/**
 * ApplyEditRequestModal.test.tsx — Phase 2A admin-apply UI.
 *
 * Pins:
 *   1. Modal renders the strong-warning banner + summary + diff.
 *   2. Confirm button is disabled until the user types EXACTLY
 *      "تطبيق التعديل" into the verification input.
 *   3. Confirm calls ONLY `returnsApi.applyReturnEditRequest` with the
 *      typed body (notes optional, omitted when empty).
 *   4. Success → toast + invalidates `['audit', 'return', id]` AND
 *      `['return', id]` AND `['returns']` so the parent page totals
 *      refresh — never `applyExchangeEditRequest` (which doesn't
 *      exist on the wrapper) and never approve/reject endpoints.
 *   5. BE error → toast.error with BE message; no close.
 *   6. Cancel button closes without firing any API call.
 *   7. entity='exchange' renders the "قيد الإعداد" content and the
 *      apply confirm button is gone (defense in depth).
 *   8. Source-grep:
 *      · No PATCH/PUT/DELETE direct.
 *      · Only `returnsApi.applyReturnEditRequest` called.
 *      · No exchange apply call from the modal.
 *      · No JE/CT/SM literals or reverse/replay/amendment terms.
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

import { ApplyEditRequestModal } from '@/components/returns/ApplyEditRequestModal';

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('react-hot-toast', () => ({
  default: { success: toastMocks.success, error: toastMocks.error },
}));

vi.mock('@/api/returns.api', () => ({
  returnsApi: {
    applyReturnEditRequest: vi.fn(),
    // Other wrappers exist on the real module but are deliberately
    // NOT exposed via this mock — if the modal references them by
    // mistake, the test will throw a clear "is not a function" error.
  },
}));

import { returnsApi } from '@/api/returns.api';

const APPROVED_REQUEST = {
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
  status: 'approved' as const,
  requested_by: 'u-2',
  requested_by_name: 'محمد كاشير',
  requested_at: '2026-05-09T13:00:00Z',
  reviewed_by: 'u-3',
  reviewed_by_name: 'مدير النظام',
  reviewed_at: '2026-05-09T13:30:00Z',
  review_notes: null,
  applied_at: null,
  applied_by: null,
  applied_by_name: null,
  apply_journal_entry_ids: null,
  apply_cashbox_transaction_ids: null,
  apply_stock_movement_ids: null,
  apply_summary: null,
  source: 'edit_request' as const,
};

function renderModal(
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
      <ApplyEditRequestModal
        entity={overrides.entity ?? 'return'}
        parentId={overrides.parentId ?? 'ret-1'}
        request={APPROVED_REQUEST as any}
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

// ─── Render shape ─────────────────────────────────────────────────

describe('ApplyEditRequestModal — render', () => {
  it('renders the strong-warning banner + request summary + diff + notes + phrase guard', () => {
    renderModal();
    expect(screen.getByTestId('apply-edit-request-modal')).toBeInTheDocument();
    expect(screen.getByText('تطبيق طلب التعديل')).toBeInTheDocument();
    expect(screen.getByText(/RET-2026-000001/)).toBeInTheDocument();

    // Strong-warning banner.
    expect(
      screen.getByTestId('apply-edit-request-warning').textContent,
    ).toMatch(
      /سيتم تعديل المرتجع فعليًا وتسجيل الأثر المخزني والمحاسبي\. لا يمكن تنفيذ هذه الخطوة مرتين/,
    );
    // Summary block.
    const summary = screen.getByTestId('apply-edit-request-summary');
    expect(summary.textContent).toMatch(/تعديل سعر/);
    expect(summary.textContent).toMatch(/العميل اعترض على السعر/);
    // Notes input + phrase guard input + confirm + cancel.
    expect(
      screen.getByTestId('apply-edit-request-notes'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('apply-edit-request-confirm-phrase'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('apply-edit-request-confirm'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('apply-edit-request-cancel'),
    ).toBeInTheDocument();
  });
});

// ─── Phrase guard ────────────────────────────────────────────────

describe('ApplyEditRequestModal — confirmation phrase guard', () => {
  it('keeps the confirm button disabled until the exact phrase is typed', () => {
    renderModal();
    const confirm = screen.getByTestId(
      'apply-edit-request-confirm',
    ) as HTMLButtonElement;
    expect(confirm).toBeDisabled();

    // Wrong / partial phrase → still disabled.
    fireEvent.change(
      screen.getByTestId('apply-edit-request-confirm-phrase'),
      { target: { value: 'تطبيق' } },
    );
    expect(confirm).toBeDisabled();

    fireEvent.change(
      screen.getByTestId('apply-edit-request-confirm-phrase'),
      { target: { value: 'تطبيق التعدي' } },
    );
    expect(confirm).toBeDisabled();

    // Exact phrase → enabled.
    fireEvent.change(
      screen.getByTestId('apply-edit-request-confirm-phrase'),
      { target: { value: 'تطبيق التعديل' } },
    );
    expect(confirm).not.toBeDisabled();
  });

  it('attempting to click confirm before the phrase is typed fires no API call', () => {
    renderModal();
    fireEvent.click(screen.getByTestId('apply-edit-request-confirm'));
    expect(returnsApi.applyReturnEditRequest).not.toHaveBeenCalled();
  });
});

// ─── Submit happy path ────────────────────────────────────────────

describe('ApplyEditRequestModal — confirm', () => {
  it('calls applyReturnEditRequest only, fires success toast, and invalidates the right query keys', async () => {
    (returnsApi.applyReturnEditRequest as any).mockResolvedValueOnce({
      ...APPROVED_REQUEST,
      applied_at: '2026-05-09T14:00:00Z',
      applied_by: 'u-3',
    });
    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { onClose, onSuccess } = renderModal({ qc });

    fireEvent.change(screen.getByTestId('apply-edit-request-notes'), {
      target: { value: 'تم التطبيق بعد المراجعة' },
    });
    fireEvent.change(
      screen.getByTestId('apply-edit-request-confirm-phrase'),
      { target: { value: 'تطبيق التعديل' } },
    );
    fireEvent.click(screen.getByTestId('apply-edit-request-confirm'));

    await waitFor(() =>
      expect(returnsApi.applyReturnEditRequest).toHaveBeenCalledTimes(1),
    );
    expect(returnsApi.applyReturnEditRequest).toHaveBeenCalledWith(
      'ret-1',
      'er-1',
      { notes: 'تم التطبيق بعد المراجعة' },
    );

    await waitFor(() =>
      expect(toastMocks.success).toHaveBeenCalledWith(
        'تم تطبيق طلب التعديل بنجاح',
      ),
    );
    // All three query keys invalidated.
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['audit', 'return', 'ret-1'],
      }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['return', 'ret-1'],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['returns'],
    });
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('omits notes from the body when the textarea is empty', async () => {
    (returnsApi.applyReturnEditRequest as any).mockResolvedValueOnce({});
    renderModal();
    fireEvent.change(
      screen.getByTestId('apply-edit-request-confirm-phrase'),
      { target: { value: 'تطبيق التعديل' } },
    );
    fireEvent.click(screen.getByTestId('apply-edit-request-confirm'));
    await waitFor(() =>
      expect(returnsApi.applyReturnEditRequest).toHaveBeenCalledTimes(1),
    );
    const [, , body] = (returnsApi.applyReturnEditRequest as any).mock
      .calls[0];
    expect(body).toEqual({});
  });

  it('surfaces BE error and does not close', async () => {
    (returnsApi.applyReturnEditRequest as any).mockRejectedValueOnce({
      response: { data: { message: 'تعذّر عكس قيد المرتجع' } },
    });
    const { onClose } = renderModal();
    fireEvent.change(
      screen.getByTestId('apply-edit-request-confirm-phrase'),
      { target: { value: 'تطبيق التعديل' } },
    );
    fireEvent.click(screen.getByTestId('apply-edit-request-confirm'));
    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith(
        'تعذّر عكس قيد المرتجع',
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('cancel button closes without firing any API call', () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByTestId('apply-edit-request-cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(returnsApi.applyReturnEditRequest).not.toHaveBeenCalled();
  });
});

// ─── Exchange defense in depth ────────────────────────────────────

describe('ApplyEditRequestModal — entity="exchange"', () => {
  it('renders the "قيد الإعداد" content and offers no confirm button', () => {
    renderModal({ entity: 'exchange' });
    expect(
      screen.getByTestId('apply-edit-request-not-supported').textContent,
    ).toMatch(/تطبيق تعديلات الاستبدال قيد الإعداد/);
    // No confirm button — only a close button.
    expect(
      screen.queryByTestId('apply-edit-request-confirm'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('apply-edit-request-confirm-phrase'),
    ).not.toBeInTheDocument();
  });

  it('does not call any API even if a regression bypasses the parent gate', () => {
    renderModal({ entity: 'exchange' });
    expect(returnsApi.applyReturnEditRequest).not.toHaveBeenCalled();
  });
});

// ─── Source-grep — strict apply-only contract ─────────────────────

describe('ApplyEditRequestModal — strict-contract source-grep', () => {
  const src = readFileSync(
    'src/components/returns/ApplyEditRequestModal.tsx',
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

  it('does not call api.post directly (uses the returnsApi wrapper only)', () => {
    expect(code).not.toMatch(/api\.post\(/);
  });

  it('only API surface is applyReturnEditRequest', () => {
    const calls = code.match(/returnsApi\.\w+/g) ?? [];
    for (const call of calls) {
      expect(call).toBe('returnsApi.applyReturnEditRequest');
    }
  });

  it('does not invoke any approve / reject / amendment / reverse / replay path', () => {
    expect(code).not.toMatch(/approveReturnEditRequest/);
    expect(code).not.toMatch(/rejectReturnEditRequest/);
    expect(code).not.toMatch(/applyExchangeEditRequest/);
    expect(code).not.toMatch(/Amendment/i);
    expect(code).not.toMatch(/\breverse\b/i);
    expect(code).not.toMatch(/\breplay\b/i);
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
