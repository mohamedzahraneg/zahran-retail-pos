/**
 * Structured Arabic diff renderer for `requested_payload.kind === 'line_changes'`.
 *
 * Used in two places:
 *   1. The CreateEditRequestModal's "ملخص التعديل المطلوب" preview
 *      (so the user sees exactly what they're about to send).
 *   2. The ReturnsAuditPanel's EditRequestEntry (so the admin reviewing
 *      a pending request — and anyone reading history later — sees a
 *      human-readable diff instead of a raw JSON blob).
 *
 * No mutation, no API calls, no state — just pure rendering off a
 * payload object.  Falls back to a "raw JSON" view for any payload
 * that doesn't claim `kind: 'line_changes'`, so legacy edit-requests
 * created before this PR still display.
 */
import { ArrowLeftRight, Minus, Pencil, Plus } from 'lucide-react';
import type {
  HeaderEdit,
  ItemSnapshot,
  LineChangeAdded,
  LineChangeRemoved,
  LineChangeUpdated,
  LineChangesPayload,
  PaymentMethod,
  ReturnReason,
} from '@/api/returns.api';

// ── Arabic label maps ──────────────────────────────────────────────
// Co-located so the modal + audit panel render identically.  Keep in
// sync with the master maps in Returns.tsx.

const REASON_AR: Record<ReturnReason, string> = {
  defective: 'منتج معيب',
  wrong_size: 'مقاس غير مناسب',
  wrong_color: 'لون غير مناسب',
  customer_changed_mind: 'غيّر رأيه',
  not_as_described: 'غير مطابق للوصف',
  other: 'أخرى',
};

const REFUND_METHOD_AR: Record<PaymentMethod, string> = {
  cash: 'كاش',
  card: 'بطاقة',
  instapay: 'انستا باي',
  bank_transfer: 'تحويل بنكي',
};

function fmtMoney(n: number): string {
  return `${n.toLocaleString('en-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م`;
}

/** Type guard for the structured payload. */
export function isLineChangesPayload(
  raw: unknown,
): raw is LineChangesPayload {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  if (r.kind !== 'line_changes') return false;
  if (!r.lines || typeof r.lines !== 'object') return false;
  const lines = r.lines as Record<string, unknown>;
  return (
    Array.isArray(lines.updated) &&
    Array.isArray(lines.removed) &&
    Array.isArray(lines.added)
  );
}

// ── Per-line subviews ──────────────────────────────────────────────

function ItemLabel({ item }: { item: ItemSnapshot }) {
  const parts: string[] = [];
  if (item.name) parts.push(item.name);
  else if (item.sku) parts.push(item.sku);
  else parts.push('—');
  const meta: string[] = [];
  if (item.sku && item.name) meta.push(item.sku);
  if (item.color) meta.push(item.color);
  if (item.size) meta.push(item.size);
  return (
    <div className="min-w-0">
      <div className="font-semibold text-slate-800 truncate">
        {parts.join(' ')}
      </div>
      {meta.length > 0 && (
        <div className="text-[11px] text-slate-500 font-mono truncate">
          {meta.join(' • ')}
        </div>
      )}
    </div>
  );
}

function FieldDiff({
  label,
  before,
  after,
  fmt,
}: {
  label: string;
  before: string | number | null | undefined;
  after: string | number | null | undefined;
  fmt?: (v: string | number | null | undefined) => string;
}) {
  const f = fmt ?? ((v) => (v == null || v === '' ? '—' : String(v)));
  if (f(before) === f(after)) return null;
  return (
    <div className="flex items-center gap-2 text-[12px]">
      <span className="text-slate-500 shrink-0 w-20">{label}</span>
      <span className="text-rose-700 line-through">{f(before)}</span>
      <span className="text-slate-400">←</span>
      <span className="text-emerald-700 font-bold">{f(after)}</span>
    </div>
  );
}

function UpdatedRow({ row }: { row: LineChangeUpdated }) {
  return (
    <div
      className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2"
      data-testid="er-diff-updated-row"
    >
      <div className="flex items-center gap-2 text-amber-800">
        <Pencil size={12} />
        <span className="text-[11px] font-bold">بند معدل</span>
      </div>
      <ItemLabel item={row.after} />
      <div className="space-y-1">
        <FieldDiff
          label="الكمية"
          before={row.before.quantity}
          after={row.after.quantity}
        />
        <FieldDiff
          label="السعر"
          before={row.before.unit_price}
          after={row.after.unit_price}
          fmt={(v) =>
            typeof v === 'number' || (typeof v === 'string' && v !== '')
              ? fmtMoney(Number(v))
              : '—'
          }
        />
        <FieldDiff
          label="المنتج"
          before={row.before.name ?? row.before.sku}
          after={row.after.name ?? row.after.sku}
        />
        <FieldDiff
          label="الكود"
          before={row.before.sku}
          after={row.after.sku}
        />
        <FieldDiff
          label="ملاحظات"
          before={row.before.notes}
          after={row.after.notes}
        />
      </div>
    </div>
  );
}

function RemovedRow({ row }: { row: LineChangeRemoved }) {
  const total = (row.before.quantity || 0) * (row.before.unit_price || 0);
  return (
    <div
      className="rounded-lg border border-rose-200 bg-rose-50 p-3 space-y-1"
      data-testid="er-diff-removed-row"
    >
      <div className="flex items-center gap-2 text-rose-800">
        <Minus size={12} />
        <span className="text-[11px] font-bold">بند محذوف</span>
      </div>
      <ItemLabel item={row.before} />
      <div className="text-[11px] text-rose-700/90 flex items-center gap-3">
        <span>الكمية: {row.before.quantity}</span>
        <span>السعر: {fmtMoney(row.before.unit_price)}</span>
        <span>الإجمالي: {fmtMoney(total)}</span>
      </div>
    </div>
  );
}

function AddedRow({ row }: { row: LineChangeAdded }) {
  const total = (row.quantity || 0) * (row.unit_price || 0);
  return (
    <div
      className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 space-y-1"
      data-testid="er-diff-added-row"
    >
      <div className="flex items-center gap-2 text-emerald-800">
        <Plus size={12} />
        <span className="text-[11px] font-bold">بند مضاف</span>
      </div>
      <ItemLabel item={row} />
      <div className="text-[11px] text-emerald-700/90 flex items-center gap-3">
        <span>الكمية: {row.quantity}</span>
        <span>السعر: {fmtMoney(row.unit_price)}</span>
        <span>الإجمالي: {fmtMoney(total)}</span>
      </div>
      {row.notes && (
        <div className="text-[11px] text-slate-600 italic">
          ملاحظات: {row.notes}
        </div>
      )}
    </div>
  );
}

function HeaderDiff({ header }: { header: HeaderEdit }) {
  // A sparse overlay — only render fields the user explicitly set.
  // Null / empty-string values mean "no change requested".
  const items: Array<{ label: string; value: string }> = [];
  if (header.reason) {
    items.push({ label: 'السبب', value: REASON_AR[header.reason] });
  }
  if (
    typeof header.reason_details === 'string' &&
    header.reason_details.trim().length > 0
  ) {
    items.push({ label: 'تفاصيل السبب', value: header.reason_details });
  }
  if (typeof header.notes === 'string' && header.notes.trim().length > 0) {
    items.push({ label: 'ملاحظات', value: header.notes });
  }
  if (header.refund_method) {
    items.push({
      label: 'طريقة الصرف',
      value: REFUND_METHOD_AR[header.refund_method],
    });
  }
  if (items.length === 0) return null;
  return (
    <div
      className="rounded-lg border border-indigo-200 bg-indigo-50 p-3 space-y-1"
      data-testid="er-diff-header"
    >
      <div className="flex items-center gap-2 text-indigo-800">
        <ArrowLeftRight size={12} />
        <span className="text-[11px] font-bold">تعديل البيانات العامة</span>
      </div>
      <div className="space-y-0.5">
        {items.map((it) => (
          <div key={it.label} className="text-[12px] flex gap-2">
            <span className="text-slate-500 shrink-0 w-24">{it.label}</span>
            <span className="text-slate-800 font-bold">{it.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Public — rendered in modal preview AND audit panel ────────────

export interface LineChangesDiffProps {
  payload: LineChangesPayload;
  /**
   * If the modal supplies a context-specific copy override
   * (e.g. "في طلب التعديل") it'll appear at the empty-state line.
   */
  emptyHint?: string;
  /** When true, renders the totals summary footer (modal). */
  showTotals?: boolean;
}

export function LineChangesDiff({
  payload,
  emptyHint = 'لا توجد تغييرات بعد',
  showTotals = true,
}: LineChangesDiffProps) {
  const { updated, removed, added } = payload.lines;
  const empty =
    updated.length === 0 &&
    removed.length === 0 &&
    added.length === 0 &&
    !payload.header;

  if (empty) {
    return (
      <div
        className="text-[12px] text-slate-500 italic"
        data-testid="er-diff-empty"
      >
        {emptyHint}
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="er-diff">
      {payload.header && <HeaderDiff header={payload.header} />}
      {updated.map((row, i) => (
        <UpdatedRow key={`u-${row.item_id}-${i}`} row={row} />
      ))}
      {removed.map((row, i) => (
        <RemovedRow key={`r-${row.item_id}-${i}`} row={row} />
      ))}
      {added.map((row, i) => (
        <AddedRow
          key={`a-${row.variant_id ?? row.sku ?? 'new'}-${i}`}
          row={row}
        />
      ))}
      {showTotals && (
        <div
          className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-1"
          data-testid="er-diff-totals"
        >
          <div className="text-[11px] font-bold text-slate-700">
            ملخص الإجمالي
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[12px]">
            <span>
              <span className="text-slate-500">الإجمالي قبل: </span>
              <span className="font-mono">{fmtMoney(payload.summary.old_total)}</span>
            </span>
            <span>
              <span className="text-slate-500">الإجمالي بعد: </span>
              <span className="font-mono">{fmtMoney(payload.summary.new_total)}</span>
            </span>
            <span
              className={
                payload.summary.delta === 0
                  ? ''
                  : payload.summary.delta > 0
                    ? 'text-emerald-700 font-bold'
                    : 'text-rose-700 font-bold'
              }
            >
              <span className="text-slate-500">الفرق: </span>
              <span className="font-mono">
                {payload.summary.delta > 0 ? '+' : ''}
                {fmtMoney(payload.summary.delta)}
              </span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/** Counts shown by the modal action-summary chip. */
export function payloadCounts(payload: LineChangesPayload) {
  return {
    updated: payload.lines.updated.length,
    removed: payload.lines.removed.length,
    added: payload.lines.added.length,
    header: payload.header ? 1 : 0,
  };
}
