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

/**
 * Renders a single key/value cell.  Used by both the "before" column
 * and the "after" column of an updated-line diff so the two halves
 * line up visually with explicit Arabic labels (e.g. "السعر قبل" vs
 * "السعر بعد"), per spec.  This replaces the earlier compact
 * strikethrough-arrow form which conveyed the same data in less
 * scannable form.
 */
function DiffCell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'before' | 'after' | 'plain';
}) {
  const valueClass =
    tone === 'before'
      ? 'text-rose-700'
      : tone === 'after'
        ? 'text-emerald-700 font-bold'
        : 'text-slate-800';
  return (
    <div className="flex items-baseline gap-2 text-[12px]">
      <span className="text-slate-500 shrink-0 w-28">{label}</span>
      <span className={valueClass}>{value}</span>
    </div>
  );
}

function fmtMoneyOrDash(v: string | number | null | undefined): string {
  if (v == null || v === '') return '—';
  return fmtMoney(Number(v));
}

function fmtTextOrDash(v: string | number | null | undefined): string {
  if (v == null || v === '') return '—';
  return String(v);
}

/**
 * Product-cell display that combines name + SKU when both exist so a
 * reviewer reading the diff still sees both identifiers next to the
 * "المنتج قبل/بعد/المحذوف/المضاف" label.  Falls back to whichever
 * is present.
 */
function fmtProduct(
  name: string | null | undefined,
  sku: string | null | undefined,
): string {
  const n = (name ?? '').trim();
  const s = (sku ?? '').trim();
  if (n && s) return `${n} (${s})`;
  if (n) return n;
  if (s) return s;
  return '—';
}

function UpdatedRow({ row }: { row: LineChangeUpdated }) {
  // Always show the four canonical pairs (المنتج / الكمية / السعر /
  // الإجمالي) so reviewers see consistent column headings even when a
  // particular line only touched one dimension.  Optional secondary
  // pairs (الكود / ملاحظات) only render when they actually changed.
  const beforeTotal = (row.before.quantity || 0) * (row.before.unit_price || 0);
  const afterTotal = (row.after.quantity || 0) * (row.after.unit_price || 0);
  const skuChanged = (row.before.sku ?? null) !== (row.after.sku ?? null);
  const notesChanged =
    (row.before.notes ?? null) !== (row.after.notes ?? null);

  return (
    <div
      className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2"
      data-testid="er-diff-updated-row"
    >
      <div className="flex items-center gap-2 text-amber-800">
        <Pencil size={12} />
        <span className="text-[11px] font-bold">بند معدل</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
        <div className="space-y-1">
          <DiffCell
            label="المنتج قبل"
            value={fmtProduct(row.before.name, row.before.sku)}
            tone="before"
          />
          <DiffCell
            label="الكمية قبل"
            value={fmtTextOrDash(row.before.quantity)}
            tone="before"
          />
          <DiffCell
            label="السعر قبل"
            value={fmtMoneyOrDash(row.before.unit_price)}
            tone="before"
          />
          <DiffCell
            label="الإجمالي قبل"
            value={fmtMoney(beforeTotal)}
            tone="before"
          />
          {skuChanged && (
            <DiffCell
              label="الكود قبل"
              value={fmtTextOrDash(row.before.sku)}
              tone="before"
            />
          )}
          {notesChanged && (
            <DiffCell
              label="ملاحظات قبل"
              value={fmtTextOrDash(row.before.notes)}
              tone="before"
            />
          )}
        </div>
        <div className="space-y-1">
          <DiffCell
            label="المنتج بعد"
            value={fmtProduct(row.after.name, row.after.sku)}
            tone="after"
          />
          <DiffCell
            label="الكمية بعد"
            value={fmtTextOrDash(row.after.quantity)}
            tone="after"
          />
          <DiffCell
            label="السعر بعد"
            value={fmtMoneyOrDash(row.after.unit_price)}
            tone="after"
          />
          <DiffCell
            label="الإجمالي بعد"
            value={fmtMoney(afterTotal)}
            tone="after"
          />
          {skuChanged && (
            <DiffCell
              label="الكود بعد"
              value={fmtTextOrDash(row.after.sku)}
              tone="after"
            />
          )}
          {notesChanged && (
            <DiffCell
              label="ملاحظات بعد"
              value={fmtTextOrDash(row.after.notes)}
              tone="after"
            />
          )}
        </div>
      </div>
    </div>
  );
}

function RemovedRow({ row }: { row: LineChangeRemoved }) {
  const total = (row.before.quantity || 0) * (row.before.unit_price || 0);
  return (
    <div
      className="rounded-lg border border-rose-200 bg-rose-50 p-3 space-y-2"
      data-testid="er-diff-removed-row"
    >
      <div className="flex items-center gap-2 text-rose-800">
        <Minus size={12} />
        <span className="text-[11px] font-bold">بند محذوف</span>
      </div>
      <div className="space-y-1">
        <DiffCell
          label="المنتج المحذوف"
          value={fmtProduct(row.before.name, row.before.sku)}
          tone="plain"
        />
        <DiffCell
          label="الكمية"
          value={fmtTextOrDash(row.before.quantity)}
          tone="plain"
        />
        <DiffCell
          label="السعر"
          value={fmtMoneyOrDash(row.before.unit_price)}
          tone="plain"
        />
        <DiffCell label="الإجمالي" value={fmtMoney(total)} tone="plain" />
      </div>
    </div>
  );
}

function AddedRow({ row }: { row: LineChangeAdded }) {
  const total = (row.quantity || 0) * (row.unit_price || 0);
  return (
    <div
      className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 space-y-2"
      data-testid="er-diff-added-row"
    >
      <div className="flex items-center gap-2 text-emerald-800">
        <Plus size={12} />
        <span className="text-[11px] font-bold">بند مضاف</span>
      </div>
      <div className="space-y-1">
        <DiffCell
          label="المنتج المضاف"
          value={fmtProduct(row.name, row.sku)}
          tone="plain"
        />
        <DiffCell
          label="الكمية"
          value={fmtTextOrDash(row.quantity)}
          tone="plain"
        />
        <DiffCell
          label="السعر"
          value={fmtMoneyOrDash(row.unit_price)}
          tone="plain"
        />
        <DiffCell label="الإجمالي" value={fmtMoney(total)} tone="plain" />
        {row.notes && (
          <DiffCell
            label="ملاحظات"
            value={fmtTextOrDash(row.notes)}
            tone="plain"
          />
        )}
      </div>
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
