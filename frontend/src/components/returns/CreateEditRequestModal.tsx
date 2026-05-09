/**
 * CreateEditRequestModal — Phase 2 guided UI.
 *
 * Strict scope (unchanged from Phase 1):
 *   · Calls ONLY `returnsApi.createReturnEditRequest` /
 *     `createExchangeEditRequest` (POST).  No PATCH/PUT/DELETE.
 *   · Does NOT call approve / reject / amendment / apply endpoints.
 *   · Does NOT touch returns / return_items / exchanges /
 *     exchange_items / journal_entries / journal_lines /
 *     cashbox_transactions / stock_movements.
 *   · A successful submit invalidates the audit query so the existing
 *     audit panel refetches and shows the new request inline.
 *
 * What changed vs Phase 1
 *   · The raw `requested_payload` JSON textarea is GONE.  The user now
 *     edits a typed line-builder UI: existing lines render with
 *     edit/remove actions, plus an "add new line" form, plus optional
 *     header (reason / refund_method / notes) edits.
 *   · The `requested_action` is auto-derived from the diff (see
 *     `edit-request/payload.ts`) — no select picker.  The user just
 *     sees a chip showing what action will be filed.
 *   · A live "ملخص التعديل المطلوب" preview renders the same Arabic
 *     diff the audit panel will display once the request is filed.
 *
 * Product picker
 *   No reusable ProductPicker exists in this codebase yet.  As a safe
 *   structured-text fallback (explicitly authorized in the spec) the
 *   user types a SKU/name and we call `productsApi.byBarcode(sku)` on
 *   submit-time to resolve `variant_id` + the canonical name + a
 *   suggested unit_price.  If the lookup fails, the typed SKU + name
 *   still go into the request as best-effort metadata for the admin
 *   reviewer.  This avoids any read of customer-private fields and
 *   never mutates a product.
 */
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  AlertTriangle,
  Info,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  XCircle,
} from 'lucide-react';
import {
  returnsApi,
  type CreateEditRequestBody,
  type ExchangeDetails,
  type ExchangeItemDetail,
  type ItemSnapshot,
  type LineChangesPayload,
  type PaymentMethod,
  type ReturnDetails,
  type ReturnItem,
  type ReturnReason,
} from '@/api/returns.api';
import { productsApi } from '@/api/products.api';
import {
  buildPayload,
  deriveAction,
  type BuilderState,
} from './edit-request/payload';
import { LineChangesDiff, payloadCounts } from './edit-request/diff';

// ── Constants (Arabic copy, label maps) ────────────────────────────

const REASON_OPTIONS: Array<{ value: ReturnReason; label: string }> = [
  { value: 'defective', label: 'منتج معيب' },
  { value: 'wrong_size', label: 'مقاس غير مناسب' },
  { value: 'wrong_color', label: 'لون غير مناسب' },
  { value: 'customer_changed_mind', label: 'غيّر رأيه' },
  { value: 'not_as_described', label: 'غير مطابق للوصف' },
  { value: 'other', label: 'أخرى' },
];

const REFUND_METHOD_OPTIONS: Array<{ value: PaymentMethod; label: string }> = [
  { value: 'cash', label: 'كاش' },
  { value: 'card', label: 'بطاقة' },
  { value: 'instapay', label: 'انستا باي' },
  { value: 'bank_transfer', label: 'تحويل بنكي' },
];

const ACTION_LABELS: Record<string, string> = {
  update_header: 'تحديث بيانات عامة',
  update_item: 'تعديل بند',
  remove_item: 'حذف بند',
  replace_item: 'استبدال منتج',
  price_change: 'تعديل سعر',
  quantity_change: 'تعديل كمية',
  reason_change: 'تعديل السبب',
};

// ── Helpers — convert detail rows into the neutral ItemSnapshot ────

function returnItemToSnapshot(it: ReturnItem): ItemSnapshot {
  return {
    variant_id: it.variant_id,
    sku: it.sku,
    name: it.product_name,
    color: it.color,
    size: it.size,
    kind: 'return',
    quantity: it.quantity,
    unit_price: Number(it.unit_price),
    notes: it.notes,
  };
}

function exchangeItemToSnapshot(it: ExchangeItemDetail): ItemSnapshot {
  return {
    variant_id: it.variant_id,
    sku: it.sku,
    name: it.product_name,
    color: it.color,
    size: it.size,
    kind: it.kind,
    quantity: it.quantity,
    unit_price: Number(it.unit_price),
    notes: it.notes ?? null,
  };
}

function fmtMoney(n: number): string {
  return `${n.toLocaleString('en-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م`;
}

// ── Public props ──────────────────────────────────────────────────

export interface CreateEditRequestModalProps {
  entity: 'return' | 'exchange';
  parentId: string;
  documentNo?: string | null;
  onClose: () => void;
  onSuccess?: () => void;
}

// ── Modal ─────────────────────────────────────────────────────────

export function CreateEditRequestModal({
  entity,
  parentId,
  documentNo,
  onClose,
  onSuccess,
}: CreateEditRequestModalProps) {
  const qc = useQueryClient();

  // Lazy-load the parent doc (cache-hit for returns since the parent
  // panel already fetched it; one-shot fetch for exchanges).  The
  // generic is widened to a union because a single hook serves both
  // entities — the discriminator is the prop, not the response shape.
  const detailQuery = useQuery<ReturnDetails | ExchangeDetails>({
    queryKey: [entity, parentId],
    queryFn: async () =>
      entity === 'return'
        ? await returnsApi.get(parentId)
        : await returnsApi.getExchange(parentId),
  });

  // Initialize the builder state once the detail loads.
  const [builder, setBuilder] = useState<BuilderState | null>(null);
  useEffect(() => {
    if (!detailQuery.data || builder !== null) return;
    if (entity === 'return') {
      const r = detailQuery.data as ReturnDetails;
      const existing: BuilderState['existing'] = {};
      for (const it of r.items ?? []) {
        const before = returnItemToSnapshot(it);
        existing[it.id] = {
          item_id: it.id,
          before,
          after: { ...before },
          removed: false,
        };
      }
      setBuilder({
        existing,
        added: [],
        before_header: {
          reason: r.reason,
          reason_details: r.reason_details ?? null,
          notes: r.notes ?? null,
          refund_method: r.refund_method ?? null,
        },
        header: {},
      });
    } else {
      const e = detailQuery.data as ExchangeDetails;
      const existing: BuilderState['existing'] = {};
      for (const it of e.items ?? []) {
        const before = exchangeItemToSnapshot(it);
        existing[it.id] = {
          item_id: it.id,
          before,
          after: { ...before },
          removed: false,
        };
      }
      setBuilder({
        existing,
        added: [],
        before_header: {
          reason: e.reason ?? null,
          reason_details: e.reason_details ?? null,
          notes: e.notes ?? null,
          refund_method: e.refund_method ?? null,
        },
        header: {},
      });
    }
  }, [detailQuery.data, entity, builder]);

  // Reason text — required, ≥5 chars.
  const [reason, setReason] = useState('');
  const reasonError = useMemo(() => {
    if (reason.trim().length === 0) return null;
    return reason.trim().length < 5
      ? 'سبب طلب التعديل مطلوب ولا يقل عن 5 أحرف'
      : null;
  }, [reason]);

  // Live-built payload + derived action.
  const payload = useMemo<LineChangesPayload | null>(
    () => (builder ? buildPayload(builder) : null),
    [builder],
  );
  const action = useMemo(
    () => (payload ? deriveAction(payload) : null),
    [payload],
  );

  const canSubmit =
    payload !== null && reason.trim().length >= 5;

  // ── Mutation ─────────────────────────────────────────────────────
  const mut = useMutation({
    mutationFn: (body: CreateEditRequestBody) =>
      entity === 'return'
        ? returnsApi.createReturnEditRequest(parentId, body)
        : returnsApi.createExchangeEditRequest(parentId, body),
    onSuccess: () => {
      toast.success('تم إرسال طلب التعديل وينتظر موافقة الأدمن');
      qc.invalidateQueries({ queryKey: ['audit', entity, parentId] });
      onSuccess?.();
      onClose();
    },
    onError: (e: any) => {
      const fallback = 'تعذّر إرسال طلب التعديل';
      const candidates = [e?.response?.data?.message, e?.message];
      const picked = candidates.find(
        (c) => typeof c === 'string' && c.trim().length > 0,
      );
      toast.error(picked ?? fallback);
    },
  });

  /**
   * Best-effort variant resolution for "added" rows the user typed by
   * SKU.  Failure is non-fatal — the typed SKU + name still go into
   * the request body so the admin reviewer can see what the user
   * meant.  No write — `byBarcode` is GET-only.
   */
  async function resolveAddedRows(
    rows: ItemSnapshot[],
  ): Promise<ItemSnapshot[]> {
    return Promise.all(
      rows.map(async (row) => {
        // If user already has a variant_id, trust it.
        if (row.variant_id) return row;
        const code = row.sku?.trim();
        if (!code) return row;
        try {
          const r = await productsApi.byBarcode(code);
          return {
            ...row,
            variant_id: r.variant?.id ?? row.variant_id ?? null,
            sku: r.variant?.sku ?? row.sku,
            name: r.product?.name_ar ?? row.name,
          };
        } catch {
          // Fall back to whatever the user typed.
          return row;
        }
      }),
    );
  }

  async function handleSubmit() {
    if (!canSubmit || !payload || !action || mut.isPending) return;

    // Resolve any added-row SKUs to their canonical variant_id +
    // product name so the persisted payload is self-describing.  This
    // is GET-only (no mutation).
    const resolvedAdded = await resolveAddedRows(payload.lines.added);
    const finalPayload: LineChangesPayload = {
      ...payload,
      lines: { ...payload.lines, added: resolvedAdded },
    };

    mut.mutate({
      requested_action: action,
      requested_payload: finalPayload as unknown as Record<string, unknown>,
      reason_text: reason.trim(),
    });
  }

  const headerSubtitle = documentNo
    ? `${entity === 'return' ? 'مرتجع' : 'استبدال'} ${documentNo}`
    : entity === 'return'
      ? 'مرتجع'
      : 'استبدال';

  // ── Render ───────────────────────────────────────────────────────
  return createPortal(
    <div
      className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-[60] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="إنشاء طلب تعديل"
      onClick={onClose}
      data-testid="create-edit-request-modal"
      dir="rtl"
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white border-b border-slate-100 px-6 py-4 flex items-center justify-between z-10">
          <div>
            <h3 className="text-lg font-black text-slate-900">
              إنشاء طلب تعديل
            </h3>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {headerSubtitle}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700"
            aria-label="إغلاق"
          >
            <XCircle size={22} />
          </button>
        </div>

        <div className="p-6 space-y-5">
          {/* Warning banner */}
          <div
            className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] flex items-start gap-2"
            data-testid="create-edit-request-warning"
          >
            <AlertTriangle
              size={14}
              className="text-amber-600 mt-0.5 shrink-0"
            />
            <div className="text-amber-900 leading-relaxed">
              هذا الطلب لا يغيّر المرتجع أو الاستبدال الآن. سيتم إرساله
              للمراجعة وينتظر موافقة الأدمن.
            </div>
          </div>

          {detailQuery.isLoading || !builder ? (
            <div
              className="text-center py-8 text-slate-500 text-sm"
              data-testid="create-edit-request-loading"
            >
              جارٍ التحميل…
            </div>
          ) : detailQuery.isError ? (
            <div
              className="text-rose-700 text-sm py-4"
              data-testid="create-edit-request-load-error"
            >
              تعذّر تحميل تفاصيل {entity === 'return' ? 'المرتجع' : 'الاستبدال'}
              .
            </div>
          ) : (
            <>
              {/* Existing items */}
              <ExistingLinesSection
                builder={builder}
                onChange={setBuilder}
              />

              {/* Add new line */}
              <AddLineSection
                onAdd={(snapshot) =>
                  setBuilder((b) =>
                    b
                      ? {
                          ...b,
                          added: [
                            ...b.added,
                            {
                              temp_id: `new-${b.added.length + 1}-${Date.now()}`,
                              after: snapshot,
                            },
                          ],
                        }
                      : b,
                  )
                }
                onRemoveDraft={(temp_id) =>
                  setBuilder((b) =>
                    b
                      ? {
                          ...b,
                          added: b.added.filter((r) => r.temp_id !== temp_id),
                        }
                      : b,
                  )
                }
                drafts={builder.added}
              />

              {/* Header edits */}
              <HeaderSection
                builder={builder}
                onChange={setBuilder}
              />

              {/* Live diff preview */}
              <section data-testid="create-edit-request-summary">
                <div className="font-bold text-slate-700 mb-2 text-sm">
                  ملخص التعديل المطلوب
                </div>
                {payload ? (
                  <>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="inline-flex items-center gap-1 text-[11px] font-bold bg-indigo-50 text-indigo-700 border border-indigo-200 rounded px-2 py-1">
                        نوع الطلب: {ACTION_LABELS[action!] ?? action}
                      </span>
                      <CountChips counts={payloadCounts(payload)} />
                    </div>
                    <LineChangesDiff payload={payload} />
                  </>
                ) : (
                  <div
                    className="text-[12px] text-slate-500 italic"
                    data-testid="create-edit-request-summary-empty"
                  >
                    لم يتم إجراء أي تغيير بعد. ابدأ بتعديل بند أو إضافة بند
                    جديد.
                  </div>
                )}
              </section>
            </>
          )}

          {/* Reason */}
          <div>
            <label className="text-[11px] font-bold text-slate-700 block mb-1">
              سبب طلب التعديل
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:bg-white focus:border-brand-300 w-full"
              data-testid="create-edit-request-reason"
            />
            {reasonError && (
              <div
                className="text-[11px] text-rose-700 mt-1"
                data-testid="create-edit-request-reason-error"
              >
                {reasonError}
              </div>
            )}
          </div>

          {/* Footer reminder */}
          <div className="flex items-start gap-1.5 text-[11px] text-slate-500">
            <Info size={12} className="mt-0.5 shrink-0" />
            <span>لا يتم تطبيق أي تعديل قبل موافقة الأدمن.</span>
          </div>

          {/* Buttons */}
          <div className="flex gap-2 justify-end pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              className="text-[12px] font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 px-3 py-2 rounded-lg"
              data-testid="create-edit-request-cancel"
            >
              إلغاء
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit || mut.isPending}
              className="text-[12px] font-bold text-white bg-brand-600 hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-2 rounded-lg"
              data-testid="create-edit-request-submit"
            >
              {mut.isPending ? 'جارٍ الإرسال…' : 'إرسال طلب التعديل'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ─── Existing-lines section ────────────────────────────────────────

function ExistingLinesSection({
  builder,
  onChange,
}: {
  builder: BuilderState;
  onChange: (next: BuilderState) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const rows = Object.values(builder.existing);
  if (rows.length === 0) {
    return (
      <section data-testid="er-existing-lines">
        <div className="font-bold text-slate-700 mb-2 text-sm">
          البنود الحالية
        </div>
        <div className="text-[12px] text-slate-500 italic">
          لا توجد بنود حالية.
        </div>
      </section>
    );
  }
  return (
    <section data-testid="er-existing-lines">
      <div className="font-bold text-slate-700 mb-2 text-sm">
        البنود الحالية
      </div>
      <div className="space-y-2">
        {rows.map((row) => {
          const isEditing = editingId === row.item_id;
          const dirty =
            JSON.stringify(row.before) !== JSON.stringify(row.after);
          const lineTotal = row.after.quantity * row.after.unit_price;
          const beforeTotal = row.before.quantity * row.before.unit_price;
          return (
            <div
              key={row.item_id}
              className={`rounded-lg border p-3 ${
                row.removed
                  ? 'border-rose-300 bg-rose-50/50'
                  : dirty
                    ? 'border-amber-300 bg-amber-50/40'
                    : 'border-slate-200 bg-white'
              }`}
              data-testid={`er-existing-line-${row.item_id}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-slate-800 truncate">
                    {row.after.name || row.after.sku || '—'}
                  </div>
                  <div className="text-[11px] text-slate-500 font-mono truncate">
                    {[row.after.sku, row.after.color, row.after.size]
                      .filter(Boolean)
                      .join(' • ') || '—'}
                  </div>
                  <div className="text-[11px] text-slate-600 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                    <span>الكمية: {row.after.quantity}</span>
                    <span>السعر: {fmtMoney(row.after.unit_price)}</span>
                    <span>الإجمالي: {fmtMoney(lineTotal)}</span>
                  </div>
                  {dirty && !row.removed && (
                    <div className="text-[11px] text-amber-700 mt-1">
                      الإجمالي قبل: {fmtMoney(beforeTotal)}
                    </div>
                  )}
                </div>
                <div className="flex flex-col gap-1 shrink-0">
                  {row.removed ? (
                    <button
                      type="button"
                      onClick={() =>
                        onChange({
                          ...builder,
                          existing: {
                            ...builder.existing,
                            [row.item_id]: { ...row, removed: false },
                          },
                        })
                      }
                      className="text-[11px] bg-slate-100 hover:bg-slate-200 text-slate-700 px-2 py-1 rounded inline-flex items-center gap-1"
                      data-testid={`er-existing-line-${row.item_id}-undo`}
                    >
                      <RotateCcw size={11} /> تراجع عن الحذف
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() =>
                          setEditingId(isEditing ? null : row.item_id)
                        }
                        className="text-[11px] bg-amber-100 hover:bg-amber-200 text-amber-800 px-2 py-1 rounded inline-flex items-center gap-1"
                        data-testid={`er-existing-line-${row.item_id}-edit`}
                      >
                        <Pencil size={11} /> {isEditing ? 'إغلاق' : 'تعديل البند'}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          onChange({
                            ...builder,
                            existing: {
                              ...builder.existing,
                              [row.item_id]: { ...row, removed: true },
                            },
                          })
                        }
                        className="text-[11px] bg-rose-100 hover:bg-rose-200 text-rose-800 px-2 py-1 rounded inline-flex items-center gap-1"
                        data-testid={`er-existing-line-${row.item_id}-remove`}
                      >
                        <Trash2 size={11} /> حذف من طلب التعديل
                      </button>
                    </>
                  )}
                </div>
              </div>
              {isEditing && !row.removed && (
                <LineEditor
                  snapshot={row.after}
                  beforeSnapshot={row.before}
                  onChange={(after) =>
                    onChange({
                      ...builder,
                      existing: {
                        ...builder.existing,
                        [row.item_id]: { ...row, after },
                      },
                    })
                  }
                />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ─── Per-line editor (used by both existing-line edit + add) ───────

function LineEditor({
  snapshot,
  beforeSnapshot,
  onChange,
}: {
  snapshot: ItemSnapshot;
  beforeSnapshot?: ItemSnapshot;
  onChange: (next: ItemSnapshot) => void;
}) {
  const change = (patch: Partial<ItemSnapshot>) =>
    onChange({ ...snapshot, ...patch });
  return (
    <div
      className="mt-3 pt-3 border-t border-slate-100 grid grid-cols-1 md:grid-cols-2 gap-2"
      data-testid="er-line-editor"
    >
      <Field label="اسم المنتج">
        <input
          type="text"
          value={snapshot.name ?? ''}
          onChange={(e) => change({ name: e.target.value })}
          className="bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-sm w-full focus:bg-white focus:border-brand-300 outline-none"
          data-testid="er-line-editor-name"
        />
      </Field>
      <Field label="الكود / SKU">
        <input
          type="text"
          value={snapshot.sku ?? ''}
          onChange={(e) =>
            change({
              sku: e.target.value,
              // SKU change invalidates a previously-resolved variant_id
              // so the BE/admin sees the new code unambiguously.
              variant_id:
                e.target.value === beforeSnapshot?.sku
                  ? beforeSnapshot.variant_id ?? null
                  : null,
            })
          }
          className="bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-sm w-full font-mono focus:bg-white focus:border-brand-300 outline-none"
          data-testid="er-line-editor-sku"
          dir="ltr"
        />
      </Field>
      <Field label="الكمية">
        <input
          type="number"
          min={1}
          value={snapshot.quantity}
          onChange={(e) =>
            change({ quantity: Math.max(1, Number(e.target.value) || 1) })
          }
          className="bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-sm w-full focus:bg-white focus:border-brand-300 outline-none"
          data-testid="er-line-editor-quantity"
        />
      </Field>
      <Field label="السعر">
        <input
          type="number"
          min={0}
          step="0.01"
          value={snapshot.unit_price}
          onChange={(e) =>
            change({ unit_price: Math.max(0, Number(e.target.value) || 0) })
          }
          className="bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-sm w-full focus:bg-white focus:border-brand-300 outline-none"
          data-testid="er-line-editor-price"
        />
      </Field>
      <Field label="ملاحظات" className="md:col-span-2">
        <input
          type="text"
          value={snapshot.notes ?? ''}
          onChange={(e) => change({ notes: e.target.value || null })}
          className="bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-sm w-full focus:bg-white focus:border-brand-300 outline-none"
          data-testid="er-line-editor-notes"
        />
      </Field>
      {beforeSnapshot && (
        <div className="md:col-span-2 text-[11px] text-slate-500 flex items-center gap-3">
          <span>قبل: {beforeSnapshot.quantity} × {fmtMoney(beforeSnapshot.unit_price)}</span>
          <span>=</span>
          <span>{fmtMoney(beforeSnapshot.quantity * beforeSnapshot.unit_price)}</span>
          <span className="text-slate-300">|</span>
          <span>بعد: {snapshot.quantity} × {fmtMoney(snapshot.unit_price)}</span>
          <span>=</span>
          <span className="font-bold">
            {fmtMoney(snapshot.quantity * snapshot.unit_price)}
          </span>
        </div>
      )}
    </div>
  );
}

// ─── "Add new line" section ────────────────────────────────────────

function AddLineSection({
  drafts,
  onAdd,
  onRemoveDraft,
}: {
  drafts: BuilderState['added'];
  onAdd: (snapshot: ItemSnapshot) => void;
  onRemoveDraft: (temp_id: string) => void;
}) {
  const empty: ItemSnapshot = {
    variant_id: null,
    sku: '',
    name: '',
    quantity: 1,
    unit_price: 0,
    notes: null,
  };
  const [draft, setDraft] = useState<ItemSnapshot>(empty);
  const draftValid =
    (draft.sku ?? '').trim().length > 0 || (draft.name ?? '').trim().length > 0;

  return (
    <section data-testid="er-add-line">
      <div className="font-bold text-slate-700 mb-2 text-sm">
        إضافة بند جديد
      </div>
      <div className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-3 space-y-2">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <Field label="اسم المنتج">
            <input
              type="text"
              value={draft.name ?? ''}
              onChange={(e) =>
                setDraft({ ...draft, name: e.target.value || null })
              }
              className="bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-sm w-full focus:border-brand-300 outline-none"
              data-testid="er-add-line-name"
              placeholder="مثال: تيشيرت أزرق L"
            />
          </Field>
          <Field label="الكود / SKU">
            <div className="relative">
              <input
                type="text"
                value={draft.sku ?? ''}
                onChange={(e) =>
                  setDraft({ ...draft, sku: e.target.value || null })
                }
                className="bg-white border border-slate-200 rounded-lg px-2 py-1.5 pl-8 text-sm w-full font-mono focus:border-brand-300 outline-none"
                data-testid="er-add-line-sku"
                dir="ltr"
                placeholder="SKU"
              />
              <Search
                size={12}
                className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
              />
            </div>
          </Field>
          <Field label="الكمية">
            <input
              type="number"
              min={1}
              value={draft.quantity}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  quantity: Math.max(1, Number(e.target.value) || 1),
                })
              }
              className="bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-sm w-full focus:border-brand-300 outline-none"
              data-testid="er-add-line-quantity"
            />
          </Field>
          <Field label="السعر">
            <input
              type="number"
              min={0}
              step="0.01"
              value={draft.unit_price}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  unit_price: Math.max(0, Number(e.target.value) || 0),
                })
              }
              className="bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-sm w-full focus:border-brand-300 outline-none"
              data-testid="er-add-line-price"
            />
          </Field>
          <Field label="ملاحظات" className="md:col-span-2">
            <input
              type="text"
              value={draft.notes ?? ''}
              onChange={(e) =>
                setDraft({ ...draft, notes: e.target.value || null })
              }
              className="bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-sm w-full focus:border-brand-300 outline-none"
              data-testid="er-add-line-notes"
            />
          </Field>
        </div>
        <button
          type="button"
          onClick={() => {
            if (!draftValid) return;
            onAdd(draft);
            setDraft(empty);
          }}
          disabled={!draftValid}
          className="text-[12px] font-bold text-emerald-700 bg-emerald-100 hover:bg-emerald-200 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-1.5 rounded-lg inline-flex items-center gap-1"
          data-testid="er-add-line-submit"
        >
          <Plus size={12} /> إضافة لطلب التعديل
        </button>
      </div>

      {drafts.length > 0 && (
        <div className="mt-2 space-y-1.5" data-testid="er-add-line-drafts">
          {drafts.map((d) => (
            <div
              key={d.temp_id}
              className="rounded-lg border border-emerald-200 bg-white px-3 py-2 flex items-center justify-between text-[12px]"
            >
              <div className="min-w-0">
                <div className="font-semibold truncate">
                  {d.after.name || d.after.sku || '—'}
                </div>
                <div className="text-[11px] text-slate-500 font-mono truncate">
                  {d.after.sku || '—'} · الكمية {d.after.quantity} · السعر{' '}
                  {fmtMoney(d.after.unit_price)}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onRemoveDraft(d.temp_id)}
                className="text-rose-600 hover:text-rose-800 shrink-0"
                aria-label="إزالة"
              >
                <XCircle size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Header section ────────────────────────────────────────────────

function HeaderSection({
  builder,
  onChange,
}: {
  builder: BuilderState;
  onChange: (next: BuilderState) => void;
}) {
  const [open, setOpen] = useState(false);
  const headerHas =
    (builder.header.reason ?? null) !== null ||
    (builder.header.reason_details ?? null) !== null ||
    (builder.header.notes ?? null) !== null ||
    (builder.header.refund_method ?? null) !== null;
  const set = (patch: Partial<BuilderState['header']>) =>
    onChange({ ...builder, header: { ...builder.header, ...patch } });
  return (
    <section data-testid="er-header-section">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-[12px] font-bold text-slate-700 hover:text-slate-900 inline-flex items-center gap-1"
        data-testid="er-header-toggle"
      >
        {open ? '▾' : '▸'} تعديل البيانات العامة (اختياري)
        {headerHas && (
          <span className="text-[10px] bg-indigo-100 text-indigo-700 rounded px-1.5 py-0.5">
            ●
          </span>
        )}
      </button>
      {open && (
        <div
          className="mt-2 rounded-lg border border-indigo-200 bg-indigo-50/40 p-3 grid grid-cols-1 md:grid-cols-2 gap-2"
          data-testid="er-header-fields"
        >
          <Field label="السبب">
            <select
              value={builder.header.reason ?? ''}
              onChange={(e) =>
                set({
                  reason: e.target.value
                    ? (e.target.value as ReturnReason)
                    : null,
                })
              }
              className="bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-sm w-full focus:border-brand-300 outline-none"
              data-testid="er-header-reason"
            >
              <option value="">— بدون تغيير —</option>
              {REASON_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="طريقة الصرف">
            <select
              value={builder.header.refund_method ?? ''}
              onChange={(e) =>
                set({
                  refund_method: e.target.value
                    ? (e.target.value as PaymentMethod)
                    : null,
                })
              }
              className="bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-sm w-full focus:border-brand-300 outline-none"
              data-testid="er-header-refund-method"
            >
              <option value="">— بدون تغيير —</option>
              {REFUND_METHOD_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="تفاصيل السبب" className="md:col-span-2">
            <input
              type="text"
              value={builder.header.reason_details ?? ''}
              onChange={(e) =>
                set({ reason_details: e.target.value || null })
              }
              className="bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-sm w-full focus:border-brand-300 outline-none"
              data-testid="er-header-reason-details"
            />
          </Field>
          <Field label="ملاحظات" className="md:col-span-2">
            <input
              type="text"
              value={builder.header.notes ?? ''}
              onChange={(e) => set({ notes: e.target.value || null })}
              className="bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-sm w-full focus:border-brand-300 outline-none"
              data-testid="er-header-notes"
            />
          </Field>
        </div>
      )}
    </section>
  );
}

// ─── Tiny presentational helpers ───────────────────────────────────

function Field({
  label,
  children,
  className = '',
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="text-[11px] font-bold text-slate-700 block mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}

function CountChips({
  counts,
}: {
  counts: { updated: number; removed: number; added: number; header: number };
}) {
  const chips: Array<{ key: string; label: string; cls: string }> = [];
  if (counts.updated)
    chips.push({
      key: 'u',
      label: `${counts.updated} معدل`,
      cls: 'bg-amber-100 text-amber-800 border-amber-200',
    });
  if (counts.removed)
    chips.push({
      key: 'r',
      label: `${counts.removed} محذوف`,
      cls: 'bg-rose-100 text-rose-800 border-rose-200',
    });
  if (counts.added)
    chips.push({
      key: 'a',
      label: `${counts.added} مضاف`,
      cls: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    });
  if (counts.header)
    chips.push({
      key: 'h',
      label: 'بيانات عامة',
      cls: 'bg-indigo-100 text-indigo-800 border-indigo-200',
    });
  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((c) => (
        <span
          key={c.key}
          className={`text-[10px] font-bold border rounded px-1.5 py-0.5 ${c.cls}`}
        >
          {c.label}
        </span>
      ))}
    </div>
  );
}
