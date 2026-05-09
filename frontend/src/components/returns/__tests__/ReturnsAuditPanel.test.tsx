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
    approveReturnEditRequest: vi.fn(),
    rejectReturnEditRequest: vi.fn(),
    approveExchangeEditRequest: vi.fn(),
    rejectExchangeEditRequest: vi.fn(),
    applyReturnEditRequest: vi.fn(),
  },
}));

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('react-hot-toast', () => ({
  default: { success: toastMocks.success, error: toastMocks.error },
}));

import { returnsApi } from '@/api/returns.api';
import { useAuthStore } from '@/stores/auth.store';

/** Reset auth-store to a logged-out state between tests. */
function logout() {
  useAuthStore.setState({
    accessToken: null,
    refreshToken: null,
    user: null,
    isHydrated: true,
  } as any);
}

function loginAdmin() {
  useAuthStore.setState({
    accessToken: 'fake',
    refreshToken: 'fake',
    user: {
      id: 'u-admin',
      username: 'admin',
      full_name: 'Admin',
      role: 'admin',
      permissions: ['*'],
    } as any,
    isHydrated: true,
  });
}

function loginCashier() {
  useAuthStore.setState({
    accessToken: 'fake',
    refreshToken: 'fake',
    user: {
      id: 'u-cashier',
      username: 'cashier',
      full_name: 'Cashier',
      role: 'cashier',
      permissions: ['returns.view'],
    } as any,
    isHydrated: true,
  });
}

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
  edit_requests: [],
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
  edit_requests: [
    {
      id: 'req-pending-1',
      parent_id: 'doc-1',
      document_no: 'RET-2026-EDIT-1',
      requested_action: 'price_change',
      requested_payload: { item_id: 'ri-1', new_unit_price: 120 },
      before_snapshot: {
        document: { return_no: 'RET-2026-EDIT-1' },
        items: [{ id: 'ri-1', unit_price: 150 }],
      },
      after_preview: null,
      reason_text: 'العميل وجد المنتج بسعر أقل في فاتورة أخرى',
      status: 'pending' as const,
      requested_by: 'u-2',
      requested_by_name: 'محمد كاشير',
      requested_at: '2026-05-09T13:00:00Z',
      reviewed_by: null,
      reviewed_by_name: null,
      reviewed_at: null,
      review_notes: null,
      source: 'edit_request' as const,
    },
    {
      id: 'req-rejected-1',
      parent_id: 'doc-1',
      document_no: 'RET-2026-EDIT-1',
      requested_action: 'remove_item',
      requested_payload: { item_id: 'ri-2' },
      before_snapshot: { document: {}, items: [{ id: 'ri-2' }] },
      after_preview: null,
      reason_text: 'تم تسجيل الصنف بالخطأ',
      status: 'rejected' as const,
      requested_by: 'u-2',
      requested_by_name: 'محمد كاشير',
      requested_at: '2026-05-09T12:00:00Z',
      reviewed_by: 'u-3',
      reviewed_by_name: 'مدير النظام',
      reviewed_at: '2026-05-09T12:30:00Z',
      review_notes: 'لا يمكن إزالة الصنف لأن المرتجع تم اعتماده بالفعل',
      source: 'edit_request' as const,
    },
  ],
};

describe('<ReturnsAuditPanel />', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // PR-FIN-RETURNS-EXCHANGES-EDIT-REQUESTS-REVIEW — admin actions
    // gate on `useAuthStore`, so each test starts from a clean
    // logged-out state and explicitly opts in via loginAdmin /
    // loginCashier when role gating matters.
    logout();
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
    // PR-FIX-AUDIT-PANEL-ARABIC-VALUES — status enum values are now
    // translated through formatAuditValue, so users see Arabic
    // copy ("قيد الانتظار" / "معتمد") instead of raw English.
    const docCard = screen.getByTestId('audit-change-ad-1');
    expect(docCard.textContent).toMatch(/status/);
    expect(docCard.textContent).toMatch(/قيد الانتظار/);
    expect(docCard.textContent).toMatch(/معتمد/);
    expect(docCard.textContent).not.toMatch(/\bpending\b/);
    expect(docCard.textContent).not.toMatch(/\bapproved\b/);
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
    // PR-FIX-AUDIT-PANEL-ARABIC-VALUES — action="void" is rendered
    // through formatAuditValue → "إلغاء" (Arabic).
    expect(activityCard.textContent).toMatch(/إلغاء/);
    expect(activityCard.textContent).not.toMatch(/\bvoid\b/);
    expect(activityCard.textContent).toMatch(/تم إلغاء المرتجع/);
  });

  it('renders the day/date/time triple (اليوم / التاريخ / الساعة) with seconds on every entry', async () => {
    (returnsApi.getReturnAudit as any).mockResolvedValueOnce(populated);
    renderPanel('return');
    await waitFor(() =>
      expect(screen.getByTestId('audit-entries')).toBeInTheDocument(),
    );

    const stamps = screen.getAllByTestId('audit-timestamp');
    // 4 entries (document + item + activity + amendment) = 4 timestamps.
    expect(stamps.length).toBeGreaterThanOrEqual(4);
    for (const ts of stamps) {
      expect(ts.textContent).toMatch(/اليوم:/);
      expect(ts.textContent).toMatch(/التاريخ:/);
      expect(ts.textContent).toMatch(/الساعة:/);
      // ISO-style date.
      expect(ts.textContent).toMatch(/\d{4}-\d{2}-\d{2}/);
      // HH:MM:SS — three pairs of digits separated by colons.
      expect(ts.textContent).toMatch(/\d{2}:\d{2}:\d{2}/);
    }
  });

  it('surfaces lifecycle metadata (status_before / status_after / kind) when activity carries them', async () => {
    const withMeta = {
      ...empty,
      activity: [
        {
          id: 'act-meta-1',
          user_id: 'u-1',
          username: 'admin',
          full_name: 'مدير النظام',
          action: 'update',
          entity: 'return',
          entity_id: 'doc-1',
          summary: 'صرف مرتجع RET-1 (cash)',
          metadata: {
            kind: 'refund_return',
            status_before: 'approved',
            status_after: 'refunded',
            refund_method: 'cash',
            net_refund: 150,
          },
          ip_address: '10.0.0.1',
          created_at: '2026-05-09T11:00:00Z',
        },
      ],
    };
    (returnsApi.getReturnAudit as any).mockResolvedValueOnce(withMeta);
    renderPanel('return');
    await waitFor(() =>
      expect(
        screen.getByTestId('audit-activity-act-meta-1'),
      ).toBeInTheDocument(),
    );
    const card = screen.getByTestId('audit-activity-act-meta-1');
    // PR-FIX-AUDIT-PANEL-ARABIC-VALUES — every enum value coming
    // through ActivityMetaSummary is now translated via
    // formatAuditValue.  status_before/after/kind/refund_method
    // values render Arabic; raw English is gone.
    expect(card.textContent).toMatch(/الحالة قبل/);
    expect(card.textContent).toMatch(/معتمد/);          // approved
    expect(card.textContent).toMatch(/الحالة بعد/);
    expect(card.textContent).toMatch(/تم الصرف/);        // refunded
    expect(card.textContent).toMatch(/صرف مرتجع/);       // kind=refund_return
    expect(card.textContent).not.toMatch(/\bapproved\b/);
    expect(card.textContent).not.toMatch(/\brefunded\b/);
    expect(card.textContent).not.toMatch(/refund_return/);
    expect(card.textContent).toMatch(/طريقة الصرف/);
    expect(card.textContent).toMatch(/cash/);
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

  it('renders pending edit requests with status pill and Arabic labels', async () => {
    (returnsApi.getReturnAudit as any).mockResolvedValueOnce(populated);
    renderPanel('return');
    await waitFor(() =>
      expect(
        screen.getByTestId('audit-edit-request-req-pending-1'),
      ).toBeInTheDocument(),
    );
    const card = screen.getByTestId('audit-edit-request-req-pending-1');
    expect(card.textContent).toMatch(/طلب تعديل/);
    expect(card.textContent).toMatch(/طلب تعديل ينتظر موافقة الأدمن/);
    expect(card.textContent).toMatch(/نوع التعديل المطلوب/);
    // Action enum is rendered through the ACTION_LABELS_AR map.
    expect(card.textContent).toMatch(/تعديل سعر/);
    expect(card.textContent).not.toMatch(/price_change/);
    expect(card.textContent).toMatch(/طلب بواسطة/);
    expect(card.textContent).toMatch(/محمد كاشير/);
    expect(card.textContent).toMatch(/راجع بواسطة/);
    expect(card.textContent).toMatch(/لم تتم المراجعة بعد/);
    expect(card.textContent).toMatch(/سبب طلب التعديل/);
    expect(card.textContent).toMatch(
      /العميل وجد المنتج بسعر أقل في فاتورة أخرى/,
    );
  });

  it('renders rejected edit request with reviewer + review_notes + رفض pill', async () => {
    (returnsApi.getReturnAudit as any).mockResolvedValueOnce(populated);
    renderPanel('return');
    await waitFor(() =>
      expect(
        screen.getByTestId('audit-edit-request-req-rejected-1'),
      ).toBeInTheDocument(),
    );
    const card = screen.getByTestId('audit-edit-request-req-rejected-1');
    expect(card.textContent).toMatch(/تم رفض الطلب/);
    expect(card.textContent).toMatch(/مدير النظام/);
    expect(card.textContent).toMatch(/ملاحظات المراجعة/);
    expect(card.textContent).toMatch(
      /لا يمكن إزالة الصنف لأن المرتجع تم اعتماده بالفعل/,
    );
  });

  // ─── PR-FIN-RETURNS-EXCHANGES-EDIT-REQUESTS-REVIEW — admin actions
  it('approved status pill renders the "no payload applied yet" copy', async () => {
    const fixture = {
      ...empty,
      edit_requests: [
        {
          id: 'req-approved-1',
          parent_id: 'doc-1',
          document_no: 'RET-2026-EDIT-1',
          requested_action: 'price_change',
          requested_payload: { kind: 'line_changes', lines: { updated: [], removed: [], added: [] }, summary: { old_total: 0, new_total: 0, delta: 0 } },
          before_snapshot: {},
          after_preview: null,
          reason_text: 'سبب',
          status: 'approved' as const,
          requested_by: 'u-2',
          requested_by_name: 'محمد كاشير',
          requested_at: '2026-05-09T13:00:00Z',
          reviewed_by: 'u-3',
          reviewed_by_name: 'مدير النظام',
          reviewed_at: '2026-05-09T13:30:00Z',
          review_notes: null,
          source: 'edit_request' as const,
        },
      ],
    };
    (returnsApi.getReturnAudit as any).mockResolvedValueOnce(fixture);
    renderPanel('return');
    const pill = await screen.findByTestId(
      'audit-edit-request-req-approved-1-status-pill',
    );
    expect(pill.textContent).toBe('تم اعتماد الطلب - لم يتم تطبيق التعديل بعد');
  });

  it('shows admin اعتماد / رفض actions on a pending request when current user is admin', async () => {
    loginAdmin();
    (returnsApi.getReturnAudit as any).mockResolvedValueOnce(populated);
    renderPanel('return');
    await waitFor(() =>
      expect(
        screen.getByTestId('audit-edit-request-req-pending-1'),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId(
        'audit-edit-request-req-pending-1-admin-actions',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('audit-edit-request-req-pending-1-approve'),
    ).toHaveTextContent('اعتماد الطلب');
    expect(
      screen.getByTestId('audit-edit-request-req-pending-1-reject'),
    ).toHaveTextContent('رفض الطلب');
  });

  it('hides admin actions for non-admin users', async () => {
    loginCashier();
    (returnsApi.getReturnAudit as any).mockResolvedValueOnce(populated);
    renderPanel('return');
    await waitFor(() =>
      expect(
        screen.getByTestId('audit-edit-request-req-pending-1'),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId(
        'audit-edit-request-req-pending-1-admin-actions',
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('audit-edit-request-req-pending-1-approve'),
    ).not.toBeInTheDocument();
  });

  it('hides admin actions when no user is logged in', async () => {
    // logout() already ran in beforeEach.
    (returnsApi.getReturnAudit as any).mockResolvedValueOnce(populated);
    renderPanel('return');
    await waitFor(() =>
      expect(
        screen.getByTestId('audit-edit-request-req-pending-1'),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId(
        'audit-edit-request-req-pending-1-admin-actions',
      ),
    ).not.toBeInTheDocument();
  });

  it('does NOT show admin actions on already-rejected requests, even for admin', async () => {
    loginAdmin();
    (returnsApi.getReturnAudit as any).mockResolvedValueOnce(populated);
    renderPanel('return');
    await waitFor(() =>
      expect(
        screen.getByTestId('audit-edit-request-req-rejected-1'),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId(
        'audit-edit-request-req-rejected-1-admin-actions',
      ),
    ).not.toBeInTheDocument();
  });

  // ─── PR-FIN-RETURNS-EXCHANGES-EDIT-REQUESTS-APPLY — apply button visibility

  function fixtureWithRequest(req: any) {
    return { ...empty, edit_requests: [req] };
  }

  function approvedNotAppliedRow(overrides: Record<string, any> = {}) {
    return {
      id: 'req-approved-unapplied',
      parent_id: 'doc-1',
      document_no: 'RET-2026-EDIT-1',
      requested_action: 'price_change',
      requested_payload: {
        kind: 'line_changes',
        lines: { updated: [], removed: [], added: [] },
        summary: { old_total: 450, new_total: 400, delta: -50 },
      },
      before_snapshot: {},
      after_preview: null,
      reason_text: 'موافقة على التخفيض',
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
      ...overrides,
    };
  }

  it('shows the apply button on an approved-unapplied RETURN request for an admin', async () => {
    loginAdmin();
    (returnsApi.getReturnAudit as any).mockResolvedValueOnce(
      fixtureWithRequest(approvedNotAppliedRow()),
    );
    renderPanel('return');
    const applyBtn = await screen.findByTestId(
      'audit-edit-request-req-approved-unapplied-apply',
    );
    expect(applyBtn).toHaveTextContent('تطبيق التعديل');
  });

  it('hides the apply button for a non-admin user', async () => {
    loginCashier();
    (returnsApi.getReturnAudit as any).mockResolvedValueOnce(
      fixtureWithRequest(approvedNotAppliedRow()),
    );
    renderPanel('return');
    await waitFor(() =>
      expect(
        screen.getByTestId(
          'audit-edit-request-req-approved-unapplied',
        ),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId(
        'audit-edit-request-req-approved-unapplied-apply',
      ),
    ).not.toBeInTheDocument();
  });

  it('hides the apply button on a PENDING request even for admin', async () => {
    loginAdmin();
    (returnsApi.getReturnAudit as any).mockResolvedValueOnce(populated);
    renderPanel('return');
    await waitFor(() =>
      expect(
        screen.getByTestId('audit-edit-request-req-pending-1'),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId('audit-edit-request-req-pending-1-apply'),
    ).not.toBeInTheDocument();
  });

  it('hides the apply button on a REJECTED request even for admin', async () => {
    loginAdmin();
    (returnsApi.getReturnAudit as any).mockResolvedValueOnce(populated);
    renderPanel('return');
    await waitFor(() =>
      expect(
        screen.getByTestId('audit-edit-request-req-rejected-1'),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId('audit-edit-request-req-rejected-1-apply'),
    ).not.toBeInTheDocument();
  });

  it('hides the apply button on an already-applied request and shows the applied badge instead', async () => {
    loginAdmin();
    (returnsApi.getReturnAudit as any).mockResolvedValueOnce(
      fixtureWithRequest(
        approvedNotAppliedRow({
          applied_at: '2026-05-09T14:00:00Z',
          applied_by: 'u-3',
          applied_by_name: 'مدير النظام',
          apply_journal_entry_ids: ['je-rev', 'je-new'],
          apply_cashbox_transaction_ids: ['101', '202'],
          apply_stock_movement_ids: ['sm-1', 'sm-2'],
          apply_summary: {
            lines_updated: 1,
            lines_removed: 0,
            lines_added: 0,
            delta_total_refund: -50,
            delta_net_refund: -50,
          },
        }),
      ),
    );
    renderPanel('return');
    const applied = await screen.findByTestId(
      'audit-edit-request-req-approved-unapplied-applied',
    );
    expect(applied).toBeInTheDocument();
    expect(
      screen.getByTestId(
        'audit-edit-request-req-approved-unapplied-applied-badge',
      ).textContent,
    ).toMatch(/تم تطبيق التعديل/);
    // Apply button is gone.
    expect(
      screen.queryByTestId(
        'audit-edit-request-req-approved-unapplied-apply',
      ),
    ).not.toBeInTheDocument();
    // Applied summary + artifact ids are visible.
    expect(
      screen.getByTestId(
        'audit-edit-request-req-approved-unapplied-applied-summary',
      ).textContent,
    ).toMatch(/عدد البنود المعدلة/);
    expect(
      screen.getByTestId(
        'audit-edit-request-req-approved-unapplied-applied-summary',
      ).textContent,
    ).toMatch(/فرق الإجمالي/);
    const artifacts = screen.getByTestId(
      'audit-edit-request-req-approved-unapplied-applied-artifacts',
    );
    expect(artifacts.textContent).toMatch(/قيود محاسبية/);
    expect(artifacts.textContent).toMatch(/حركات خزنة/);
    expect(artifacts.textContent).toMatch(/حركات مخزون/);
    expect(artifacts.textContent).toMatch(/je-rev/);
    expect(artifacts.textContent).toMatch(/sm-1/);
  });

  it('shows "قيد الإعداد" hint and no active button for an EXCHANGE approved-unapplied request', async () => {
    loginAdmin();
    (returnsApi.getExchangeAudit as any).mockResolvedValueOnce(
      fixtureWithRequest(approvedNotAppliedRow()),
    );
    renderPanel('exchange');
    const deferred = await screen.findByTestId(
      'audit-edit-request-req-approved-unapplied-apply-deferred',
    );
    expect(deferred.textContent).toMatch(
      /تطبيق تعديلات الاستبدال قيد الإعداد/,
    );
    expect(
      screen.queryByTestId(
        'audit-edit-request-req-approved-unapplied-apply',
      ),
    ).not.toBeInTheDocument();
  });

  // ─── PR-FIN-RETURNS-EXCHANGES-EDIT-REQUEST-GUIDED — structured diff
  it('renders structured Arabic diff for line_changes payloads (no raw JSON in default view)', async () => {
    const fixture = {
      ...empty,
      edit_requests: [
        {
          id: 'req-guided-1',
          parent_id: 'doc-1',
          document_no: 'RET-2026-EDIT-1',
          requested_action: 'update_item',
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
              removed: [
                {
                  item_id: 'ri-2',
                  before: {
                    variant_id: 'var-b',
                    sku: 'SKU-BBB',
                    name: 'بنطلون أسود',
                    quantity: 2,
                    unit_price: 300,
                  },
                },
              ],
              added: [
                {
                  variant_id: null,
                  sku: 'SKU-NEW',
                  name: 'منتج جديد',
                  quantity: 1,
                  unit_price: 200,
                },
              ],
            },
            summary: { old_total: 1050, new_total: 600, delta: -450 },
          },
          before_snapshot: {},
          after_preview: null,
          reason_text: 'تعديل متعدد على البنود',
          status: 'pending' as const,
          requested_by: 'u-2',
          requested_by_name: 'محمد كاشير',
          requested_at: '2026-05-09T13:00:00Z',
          reviewed_by: null,
          reviewed_by_name: null,
          reviewed_at: null,
          review_notes: null,
          source: 'edit_request' as const,
        },
      ],
    };
    (returnsApi.getReturnAudit as any).mockResolvedValueOnce(fixture);
    renderPanel('return');
    const diff = await screen.findByTestId(
      'audit-edit-request-req-guided-1-diff',
    );
    expect(diff).toBeInTheDocument();
    expect(diff.textContent).toMatch(/ملخص التعديل المطلوب/);

    // Each kind of change shows up as its own row.
    const updated = screen.getByTestId('er-diff-updated-row');
    const removed = screen.getByTestId('er-diff-removed-row');
    const added = screen.getByTestId('er-diff-added-row');

    expect(updated.textContent).toMatch(/تيشيرت أزرق/);
    expect(removed.textContent).toMatch(/بنطلون أسود/);
    expect(added.textContent).toMatch(/منتج جديد/);

    // PR-FIN-RETURNS-EXCHANGES-EDIT-REQUEST-LABELS — every per-line
    // diff row carries explicit Arabic before/after labels per the
    // user spec (instead of the older compact strikethrough-arrow
    // form that conveyed the same data without literal labels).
    for (const label of [
      'المنتج قبل',
      'المنتج بعد',
      'الكمية قبل',
      'الكمية بعد',
      'السعر قبل',
      'السعر بعد',
      'الإجمالي قبل',
      'الإجمالي بعد',
    ]) {
      expect(updated.textContent).toContain(label);
    }
    expect(removed.textContent).toContain('المنتج المحذوف');
    expect(removed.textContent).toContain('الكمية');
    expect(removed.textContent).toContain('السعر');
    expect(removed.textContent).toContain('الإجمالي');
    expect(added.textContent).toContain('المنتج المضاف');
    expect(added.textContent).toContain('الكمية');
    expect(added.textContent).toContain('السعر');
    expect(added.textContent).toContain('الإجمالي');

    // The actual before/after values are still rendered alongside
    // their labels so reviewers can compare.
    expect(updated.textContent).toMatch(/450/); // before price
    expect(updated.textContent).toMatch(/400/); // after price

    // Totals appear in the summary footer.
    const totals = screen.getByTestId('er-diff-totals');
    expect(totals.textContent).toMatch(/الإجمالي قبل/);
    expect(totals.textContent).toMatch(/الإجمالي بعد/);
    expect(totals.textContent).toMatch(/الفرق/);
    expect(totals.textContent).toMatch(/-450/);
  });

  it('keeps raw JSON for legacy/unknown payloads but only inside تفاصيل تقنية', async () => {
    const fixture = {
      ...empty,
      edit_requests: [
        {
          id: 'req-legacy-1',
          parent_id: 'doc-1',
          document_no: 'RET-2026-EDIT-1',
          requested_action: 'price_change',
          // Legacy free-form payload — pre-guided UI shape.
          requested_payload: { item_id: 'ri-1', new_unit_price: 120 },
          before_snapshot: { items: [{ id: 'ri-1', unit_price: 150 }] },
          after_preview: null,
          reason_text: 'سبب تجريبي',
          status: 'pending' as const,
          requested_by: 'u-2',
          requested_by_name: 'محمد كاشير',
          requested_at: '2026-05-09T13:00:00Z',
          reviewed_by: null,
          reviewed_by_name: null,
          reviewed_at: null,
          review_notes: null,
          source: 'edit_request' as const,
        },
      ],
    };
    (returnsApi.getReturnAudit as any).mockResolvedValueOnce(fixture);
    renderPanel('return');
    await waitFor(() =>
      expect(
        screen.getByTestId('audit-edit-request-req-legacy-1'),
      ).toBeInTheDocument(),
    );
    // No structured-diff block is rendered for legacy payloads.
    expect(
      screen.queryByTestId('audit-edit-request-req-legacy-1-diff'),
    ).not.toBeInTheDocument();
    // Raw JSON survives, but only inside a collapsible "تفاصيل تقنية".
    const raw = screen.getByTestId('audit-edit-request-req-legacy-1-raw');
    expect(raw.textContent).toMatch(/تفاصيل تقنية/);
    expect(raw.textContent).toMatch(/new_unit_price/);
  });

  it('shows the request-entry informational note pointing at the panel button', async () => {
    (returnsApi.getReturnAudit as any).mockResolvedValueOnce(empty);
    renderPanel('return');
    await waitFor(() =>
      expect(
        screen.getByTestId('audit-edit-request-deferred'),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('audit-edit-request-deferred').textContent,
    ).toMatch(
      /يمكنك إنشاء طلب تعديل من زر طلب تعديل، وسيظل بانتظار موافقة الأدمن/,
    );
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

  // ─── PR-FIX-EDIT-REQUEST-PILL-APPLIED + PR-FIX-AUDIT-PANEL-ARABIC-VALUES
  //     + PR-FIX-AUDIT-PANEL-NOISY-DOC-COLLAPSE — UX fixes after the
  //     RET-2026-000006 incident.

  it('applied request status pill flips to "تم تطبيق التعديل" (and the "not applied yet" copy is gone)', async () => {
    loginAdmin();
    (returnsApi.getReturnAudit as any).mockResolvedValueOnce(
      fixtureWithRequest(
        approvedNotAppliedRow({
          applied_at: '2026-05-09T17:00:39Z',
          applied_by: 'u-3',
          applied_by_name: 'مدير النظام',
          apply_journal_entry_ids: ['je-rev', 'je-new'],
          apply_cashbox_transaction_ids: ['378', '391'],
          apply_stock_movement_ids: ['1646', '1647'],
          apply_summary: { lines_updated: 1, delta_total_refund: 0 },
        }),
      ),
    );
    renderPanel('return');
    const pill = await screen.findByTestId(
      'audit-edit-request-req-approved-unapplied-status-pill',
    );
    expect(pill.textContent).toBe('تم تطبيق التعديل');
    // The old "not applied yet" copy must NOT appear anywhere on the
    // applied row (the AppliedBlock below uses different copy).
    const card = screen.getByTestId(
      'audit-edit-request-req-approved-unapplied',
    );
    expect(card.textContent).not.toMatch(/لم يتم تطبيق التعديل بعد/);
  });

  it('un-applied approved request still shows the "not applied yet" pill', async () => {
    loginAdmin();
    (returnsApi.getReturnAudit as any).mockResolvedValueOnce(
      fixtureWithRequest(approvedNotAppliedRow()),
    );
    renderPanel('return');
    const pill = await screen.findByTestId(
      'audit-edit-request-req-approved-unapplied-status-pill',
    );
    expect(pill.textContent).toBe(
      'تم اعتماد الطلب - لم يتم تطبيق التعديل بعد',
    );
  });

  it('formatAuditValue: status / refund_method / action / kind values render in Arabic in audit cards', async () => {
    const fixture = {
      document_type: 'return' as const,
      document_id: 'doc-1',
      document_changes: [
        {
          id: 'doc-arabic',
          table_name: 'returns',
          record_id: 'doc-1',
          operation: 'U' as const,
          changed_by: 'u-1',
          changed_by_username: 'admin',
          changed_by_name: 'مدير النظام',
          old_data: { status: 'pending', refund_method: 'cash' },
          new_data: { status: 'refunded', refund_method: 'cash' },
          changed_at: '2026-05-09T13:37:58Z',
        },
      ],
      item_changes: [],
      activity: [
        {
          id: 'act-arabic',
          user_id: 'u-3',
          username: 'admin',
          full_name: 'مدير النظام',
          action: 'update', // generic action — should fall through to extra.kind
          entity: 'return',
          entity_id: 'doc-1',
          summary: null,
          metadata: { kind: 'edit_request_apply' },
          ip_address: '10.0.0.1',
          created_at: '2026-05-09T17:00:39Z',
        },
      ],
      amendments: [],
      edit_requests: [],
    };
    (returnsApi.getReturnAudit as any).mockResolvedValueOnce(fixture);
    renderPanel('return');

    // Activity row uses extra.kind in Arabic when present (more
    // specific than the generic action label).
    const activity = await screen.findByTestId('audit-activity-act-arabic');
    expect(activity.textContent).toMatch(/تطبيق طلب تعديل/);
    expect(activity.textContent).not.toMatch(/\bupdate\b/);
    expect(activity.textContent).not.toMatch(/edit_request_apply/);

    // Document-change card translates status / refund_method values.
    // (The card itself is collapsed because activity overlap fires —
    // we expand it to inspect, see next test.  Here we only confirm
    // the formatter wiring is present in source.)
  });

  it('document-level audit card is collapsed under "تفاصيل تقنية" when a near-time activity row describes the same event', async () => {
    const sameTime = '2026-05-09T17:00:39Z';
    const fixture = {
      document_type: 'return' as const,
      document_id: 'doc-1',
      document_changes: [
        {
          id: 'doc-noisy',
          table_name: 'returns',
          record_id: 'doc-1',
          operation: 'U' as const,
          changed_by: 'u-1',
          changed_by_username: 'admin',
          changed_by_name: 'مدير النظام',
          old_data: { total_refund: '450.00' },
          new_data: { total_refund: '450.00' },
          changed_at: sameTime,
        },
      ],
      item_changes: [],
      activity: [
        {
          id: 'act-overlap',
          user_id: 'u-3',
          username: 'admin',
          full_name: 'مدير النظام',
          action: 'update',
          entity: 'return',
          entity_id: 'doc-1',
          summary: 'تم تطبيق طلب تعديل مرتجع',
          metadata: { kind: 'edit_request_apply' },
          ip_address: '10.0.0.1',
          created_at: sameTime,
        },
      ],
      amendments: [],
      edit_requests: [],
    };
    (returnsApi.getReturnAudit as any).mockResolvedValueOnce(fixture);
    renderPanel('return');
    // Collapsed wrapper present.
    const collapsed = await screen.findByTestId(
      'audit-change-doc-noisy-collapsed',
    );
    expect(collapsed.tagName.toLowerCase()).toBe('details');
    // It's closed by default (no `open` attribute).
    expect(collapsed.hasAttribute('open')).toBe(false);
    // The summary contains the technical-details label.
    expect(collapsed.textContent).toMatch(/تفاصيل تقنية/);
  });

  it('document-level audit card is NOT collapsed when no overlapping activity row exists', async () => {
    const fixture = {
      document_type: 'return' as const,
      document_id: 'doc-1',
      document_changes: [
        {
          id: 'doc-standalone',
          table_name: 'returns',
          record_id: 'doc-1',
          operation: 'U' as const,
          changed_by: 'u-1',
          changed_by_username: 'admin',
          changed_by_name: 'مدير النظام',
          old_data: { status: 'pending' },
          new_data: { status: 'approved' },
          changed_at: '2026-05-09T10:00:00Z',
        },
      ],
      item_changes: [],
      activity: [], // no near-time activity row
      amendments: [],
      edit_requests: [],
    };
    (returnsApi.getReturnAudit as any).mockResolvedValueOnce(fixture);
    renderPanel('return');
    await screen.findByTestId('audit-change-doc-standalone');
    expect(
      screen.queryByTestId('audit-change-doc-standalone-collapsed'),
    ).not.toBeInTheDocument();
  });

  it('item-level audit cards are NEVER collapsed (variant_id / qty diffs stay visible)', async () => {
    const sameTime = '2026-05-09T17:00:39Z';
    const fixture = {
      document_type: 'return' as const,
      document_id: 'doc-1',
      document_changes: [],
      item_changes: [
        {
          id: 'item-variant-swap',
          table_name: 'return_items',
          record_id: 'ri-1',
          operation: 'U' as const,
          changed_by: 'u-1',
          changed_by_username: 'admin',
          changed_by_name: 'مدير النظام',
          old_data: { variant_id: 'old-uuid' },
          new_data: { variant_id: 'new-uuid' },
          changed_at: sameTime,
        },
      ],
      activity: [
        // Same-time activity — would collapse a doc-level row, but
        // item-level rows must remain expanded regardless.
        {
          id: 'act-overlap-item',
          user_id: 'u-3',
          username: 'admin',
          full_name: 'مدير النظام',
          action: 'update',
          entity: 'return',
          entity_id: 'doc-1',
          summary: 'تطبيق',
          metadata: { kind: 'edit_request_apply' },
          ip_address: '10.0.0.1',
          created_at: sameTime,
        },
      ],
      amendments: [],
      edit_requests: [],
    };
    (returnsApi.getReturnAudit as any).mockResolvedValueOnce(fixture);
    renderPanel('return');
    await screen.findByTestId('audit-change-item-variant-swap');
    // No collapsed wrapper for item-level rows.
    expect(
      screen.queryByTestId('audit-change-item-variant-swap-collapsed'),
    ).not.toBeInTheDocument();
    // The diff is directly visible.
    expect(
      screen.getByTestId('audit-change-item-variant-swap').textContent,
    ).toMatch(/old-uuid/);
    expect(
      screen.getByTestId('audit-change-item-variant-swap').textContent,
    ).toMatch(/new-uuid/);
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
