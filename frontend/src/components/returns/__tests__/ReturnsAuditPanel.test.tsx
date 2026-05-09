/**
 * ReturnsAuditPanel.test.tsx — Phase 1 read-only UI contract.
 *
 * Pins:
 *   1. Header renders title + read-only badge + Arabic subtitle.
 *   2. Admin-approval informational note is rendered.
 *   3. Loading state.
 *   4. Empty state ("لا توجد تعديلات مسجلة حتى الآن").
 *   5. Renders document_changes with before/after.
 *   6. Renders item_changes.
 *   7. Renders activity_logs entries.
 *   8. Renders amendments when (later) present.
 *   9. 403 → "لا توجد صلاحية لعرض سجل التعديلات".
 *  10. ZERO mutation surface — no PATCH/POST/DELETE in the
 *      component source.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';

import { ReturnsAuditPanel } from '@/components/returns/ReturnsAuditPanel';

vi.mock('@/api/returns.api', () => ({
  returnsApi: {
    getReturnAudit: vi.fn(),
    getExchangeAudit: vi.fn(),
  },
}));

import { returnsApi } from '@/api/returns.api';

function renderPanel(entity: 'return' | 'exchange', id = 'doc-1') {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ReturnsAuditPanel entity={entity} id={id} />
    </QueryClientProvider>,
  );
}

const empty = {
  document_type: 'return' as const,
  document_id: 'doc-1',
  document_changes: [],
  item_changes: [],
  activity: [],
  amendments: [],
};

const populated = {
  document_type: 'return' as const,
  document_id: 'doc-1',
  document_changes: [
    {
      id: 'ad-1',
      table_name: 'returns',
      record_id: 'doc-1',
      operation: 'U' as const,
      changed_by: 'u-1',
      changed_by_username: 'admin',
      changed_by_name: 'مدير النظام',
      old_data: { status: 'pending', total_refund: '100' },
      new_data: { status: 'approved', total_refund: '100' },
      changed_at: '2026-05-08T10:00:00Z',
    },
  ],
  item_changes: [
    {
      id: 'ad-2',
      table_name: 'return_items',
      record_id: 'ri-1',
      operation: 'I' as const,
      changed_by: 'u-1',
      changed_by_username: 'admin',
      changed_by_name: 'مدير النظام',
      old_data: null,
      new_data: { id: 'ri-1', return_id: 'doc-1', quantity: 2 },
      changed_at: '2026-05-08T09:55:00Z',
    },
  ],
  activity: [
    {
      id: 'act-1',
      user_id: 'u-1',
      username: 'admin',
      full_name: 'مدير النظام',
      action: 'void',
      entity: 'return',
      entity_id: 'doc-1',
      summary: 'تم إلغاء المرتجع',
      metadata: { reason: 'duplicate' },
      ip_address: '10.0.0.1',
      created_at: '2026-05-08T11:00:00Z',
    },
  ],
  amendments: [
    {
      id: 'am-1',
      amendment_no: 'AMD-RET-2026-000001',
      amendment_kind: 'price_override',
      reason_text: 'تعديل سعر بناء على موافقة الإدارة',
      delta_summary: { net_refund_delta: '-30.00' },
      created_by: 'u-1',
      created_by_name: 'مدير النظام',
      created_at: '2026-05-08T12:00:00Z',
    },
  ],
};

describe('<ReturnsAuditPanel />', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the title + read-only badge + Arabic subtitle', async () => {
    (returnsApi.getReturnAudit as any).mockResolvedValueOnce(empty);
    renderPanel('return');

    expect(screen.getByText('سجل التعديلات')).toBeInTheDocument();
    expect(screen.getByTestId('audit-readonly-badge').textContent).toBe(
      'قراءة فقط',
    );
    expect(
      screen.getByText('يعرض التغييرات المسجلة على المرتجع وبنوده'),
    ).toBeInTheDocument();
  });

  it('renders the admin-approval informational note', async () => {
    (returnsApi.getReturnAudit as any).mockResolvedValueOnce(empty);
    renderPanel('return');
    const note = screen.getByTestId('audit-admin-approval-note');
    expect(note.textContent).toMatch(
      /أي تعديل على مرتجع أو استبدال بعد الاعتماد أو الترحيل المالي سيُرسل كطلب تعديل وينتظر موافقة الأدمن/,
    );
  });

  it('shows loading state before data arrives', async () => {
    (returnsApi.getReturnAudit as any).mockReturnValueOnce(
      new Promise(() => undefined), // never resolves
    );
    renderPanel('return');
    expect(screen.getByTestId('audit-loading').textContent).toMatch(
      /جارٍ تحميل سجل التعديلات/,
    );
  });

  it('shows empty state when no entries exist', async () => {
    (returnsApi.getReturnAudit as any).mockResolvedValueOnce(empty);
    renderPanel('return');

    await waitFor(() =>
      expect(screen.getByTestId('audit-empty')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('audit-empty').textContent).toMatch(
      /لا توجد تعديلات مسجلة حتى الآن/,
    );
  });

  it('renders document changes with before/after', async () => {
    (returnsApi.getReturnAudit as any).mockResolvedValueOnce(populated);
    renderPanel('return');

    await waitFor(() =>
      expect(screen.getByTestId('audit-entries')).toBeInTheDocument(),
    );
    // The document change row is present.
    expect(
      screen.getByTestId('audit-change-ad-1'),
    ).toBeInTheDocument();
    // Before/after labels render.
    expect(screen.getAllByText('قبل التعديل').length).toBeGreaterThan(0);
    expect(screen.getAllByText('بعد التعديل').length).toBeGreaterThan(0);
    // The diff hides updated_at and shows the changed key (status).
    const docCard = screen.getByTestId('audit-change-ad-1');
    expect(docCard.textContent).toMatch(/status/);
    expect(docCard.textContent).toMatch(/pending/);
    expect(docCard.textContent).toMatch(/approved/);
  });

  it('renders item changes (INSERT row, no old_data)', async () => {
    (returnsApi.getReturnAudit as any).mockResolvedValueOnce(populated);
    renderPanel('return');
    await waitFor(() =>
      expect(screen.getByTestId('audit-change-ad-2')).toBeInTheDocument(),
    );
    const itemCard = screen.getByTestId('audit-change-ad-2');
    expect(itemCard.textContent).toMatch(/إضافة/);
    // The diff filters noisy fields (id / created_at / updated_at) and
    // surfaces business-relevant ones — return_id + quantity here.
    expect(itemCard.textContent).toMatch(/return_id/);
    expect(itemCard.textContent).toMatch(/quantity/);
  });

  it('renders activity_logs entries', async () => {
    (returnsApi.getReturnAudit as any).mockResolvedValueOnce(populated);
    renderPanel('return');
    await waitFor(() =>
      expect(screen.getByTestId('audit-activity-act-1')).toBeInTheDocument(),
    );
    const activityCard = screen.getByTestId('audit-activity-act-1');
    expect(activityCard.textContent).toMatch(/void/);
    expect(activityCard.textContent).toMatch(/تم إلغاء المرتجع/);
  });

  it('renders the literal "تم بواسطة:" prefix on every entry kind', async () => {
    (returnsApi.getReturnAudit as any).mockResolvedValueOnce(populated);
    renderPanel('return');
    await waitFor(() =>
      expect(screen.getByTestId('audit-entries')).toBeInTheDocument(),
    );

    // ChangeEntry (audit_logs document row)
    expect(
      screen.getByTestId('audit-change-ad-1').textContent,
    ).toMatch(/تم بواسطة:/);
    // ChangeEntry (audit_logs item row)
    expect(
      screen.getByTestId('audit-change-ad-2').textContent,
    ).toMatch(/تم بواسطة:/);
    // ActivityEntry
    expect(
      screen.getByTestId('audit-activity-act-1').textContent,
    ).toMatch(/تم بواسطة:/);
    // AmendmentEntry
    expect(
      screen.getByTestId('audit-amendment-am-1').textContent,
    ).toMatch(/تم بواسطة:/);
  });

  it('renders amendments (Phase 4 forward-compatible)', async () => {
    (returnsApi.getReturnAudit as any).mockResolvedValueOnce(populated);
    renderPanel('return');
    await waitFor(() =>
      expect(screen.getByTestId('audit-amendment-am-1')).toBeInTheDocument(),
    );
    const amCard = screen.getByTestId('audit-amendment-am-1');
    expect(amCard.textContent).toMatch(/AMD-RET-2026-000001/);
    expect(amCard.textContent).toMatch(/price_override/);
    expect(amCard.textContent).toMatch(/تعديل سعر بناء على موافقة الإدارة/);
  });

  it('renders 403 permission-denied state with the right Arabic copy', async () => {
    const err: any = new Error('Forbidden');
    err.response = { status: 403, data: { message: 'forbidden' } };
    (returnsApi.getReturnAudit as any).mockRejectedValueOnce(err);
    renderPanel('return');
    await waitFor(() =>
      expect(
        screen.getByTestId('audit-permission-denied'),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('audit-permission-denied').textContent,
    ).toMatch(/لا توجد صلاحية لعرض سجل التعديلات/);
  });

  it('uses the exchange endpoint when entity="exchange"', async () => {
    (returnsApi.getExchangeAudit as any).mockResolvedValueOnce({
      ...empty,
      document_type: 'exchange',
    });
    renderPanel('exchange', 'exch-1');
    await waitFor(() =>
      expect(returnsApi.getExchangeAudit).toHaveBeenCalledWith('exch-1'),
    );
    expect(returnsApi.getReturnAudit).not.toHaveBeenCalled();
    expect(
      screen.getByText('يعرض التغييرات المسجلة على الاستبدال وبنوده'),
    ).toBeInTheDocument();
  });
});

// ─── Source-grep — no mutation surface in the panel ───────────────

describe('ReturnsAuditPanel — read-only contract (source-grep)', () => {
  const src = readFileSync(
    'src/components/returns/ReturnsAuditPanel.tsx',
    'utf-8',
  );
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('has no useMutation / mutationFn / .mutate(', () => {
    expect(code).not.toMatch(/\buseMutation\b/);
    expect(code).not.toMatch(/\bmutationFn\b/);
    expect(code).not.toMatch(/\.mutate\(/);
  });

  it('does not call api.post / api.patch / api.delete / api.put', () => {
    expect(code).not.toMatch(/api\.post\(/);
    expect(code).not.toMatch(/api\.patch\(/);
    expect(code).not.toMatch(/api\.put\(/);
    expect(code).not.toMatch(/api\.delete\(/);
  });

  it('does not invoke any *Approve / *Edit / *Save / *Submit handlers', () => {
    expect(code).not.toMatch(/onApprove\(/);
    expect(code).not.toMatch(/onSubmitEdit\(/);
    expect(code).not.toMatch(/handleSave\(/);
    expect(code).not.toMatch(/handlePatch\(/);
    expect(code).not.toMatch(/handleDelete\(/);
  });
});
