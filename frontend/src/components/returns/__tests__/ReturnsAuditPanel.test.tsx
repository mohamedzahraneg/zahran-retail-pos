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
    expect(card.textContent).toMatch(/الحالة قبل/);
    expect(card.textContent).toMatch(/approved/);
    expect(card.textContent).toMatch(/الحالة بعد/);
    expect(card.textContent).toMatch(/refunded/);
    expect(card.textContent).toMatch(/refund_return/);
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
