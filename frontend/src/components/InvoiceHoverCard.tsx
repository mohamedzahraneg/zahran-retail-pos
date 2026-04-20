import { useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import { ExternalLink } from 'lucide-react';
import { Link } from 'react-router-dom';
import { posApi } from '@/api/pos.api';

interface Props {
  /** Invoice UUID (required to fetch full details). */
  invoiceId: string;
  /** Display label — defaults to the invoice number, falls back to the id. */
  label?: string;
  /** Link destination when the user actually clicks through. */
  to?: string;
  className?: string;
}

const EGP = (n: any) => `${Number(n || 0).toFixed(2)}`;

/**
 * InvoiceHoverCard — shows a floating summary of an invoice when the user
 * hovers the invoice number. Fetches details lazily on first hover and
 * caches them via react-query. Click opens the full invoices page.
 */
export function InvoiceHoverCard({ invoiceId, label, to, className }: Props) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const anchorRef = useRef<HTMLAnchorElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  // Lazy fetch once the user has hovered for the first time.
  const { data, isLoading } = useQuery({
    queryKey: ['invoice-preview', invoiceId],
    queryFn: () => posApi.receipt(invoiceId),
    enabled: hovered && !!invoiceId,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!open || !anchorRef.current) return;
    const r = anchorRef.current.getBoundingClientRect();
    const cardWidth = 360;
    let left = r.right + window.scrollX - cardWidth;
    if (left < 12) left = 12;
    setPos({ top: r.bottom + window.scrollY + 6, left });
  }, [open]);

  const href = to || `/invoices?id=${invoiceId}`;
  const display = label || data?.invoice?.invoice_no || invoiceId.slice(0, 8);

  return (
    <>
      <Link
        ref={anchorRef as any}
        to={href}
        className={
          className ||
          'text-indigo-600 hover:text-indigo-800 hover:underline font-mono text-xs'
        }
        onMouseEnter={() => {
          setHovered(true);
          setOpen(true);
        }}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => {
          setHovered(true);
          setOpen(true);
        }}
        onBlur={() => setOpen(false)}
      >
        {display}
      </Link>

      {open &&
        createPortal(
          <div
            role="tooltip"
            style={{
              position: 'absolute',
              top: pos.top,
              left: pos.left,
              width: 360,
              zIndex: 9999,
            }}
            className="bg-white rounded-xl shadow-2xl border border-slate-200 text-sm"
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
            dir="rtl"
          >
            {isLoading || !data ? (
              <div className="p-4 text-slate-500">جارٍ التحميل…</div>
            ) : (
              <InvoiceCardBody data={data} invoiceId={invoiceId} />
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

function InvoiceCardBody({
  data,
  invoiceId,
}: {
  data: any;
  invoiceId: string;
}) {
  const inv = data.invoice || {};
  const lines: any[] = data.lines || [];
  const payments: any[] = data.payments || [];
  const totalPieces = lines.reduce(
    (s, l) => s + Number(l.quantity ?? l.qty ?? 0),
    0,
  );
  const disc = Number(inv.invoice_discount ?? inv.discount_total ?? 0);
  const coupon = Number(inv.coupon_discount ?? 0);

  return (
    <div className="p-4 space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-black text-slate-800">
            {inv.invoice_no || inv.doc_no || 'فاتورة'}
          </div>
          <div className="text-xs text-slate-500">
            {new Date(inv.completed_at || inv.created_at).toLocaleString('en-GB')}
          </div>
        </div>
        <StatusChip status={inv.status} />
      </div>

      {/* Customer + branch */}
      {(inv.customer_name || inv.warehouse_name) && (
        <div className="text-xs text-slate-600 space-y-0.5">
          {inv.customer_name && (
            <div>
              <span className="font-semibold">العميل:</span> {inv.customer_name}
              {inv.customer_phone && <span> · {inv.customer_phone}</span>}
            </div>
          )}
          {inv.cashier_name && (
            <div>
              <span className="font-semibold">الكاشير:</span> {inv.cashier_name}
            </div>
          )}
          {inv.warehouse_name && (
            <div>
              <span className="font-semibold">الفرع:</span> {inv.warehouse_name}
            </div>
          )}
        </div>
      )}

      {/* Items (first 5) */}
      <div className="border border-slate-100 rounded-lg overflow-hidden">
        <div className="bg-slate-50 px-3 py-1.5 text-[11px] font-bold text-slate-600 flex justify-between">
          <span>{lines.length} صنف · {totalPieces} قطعة</span>
          <span>الإجمالي</span>
        </div>
        <div className="max-h-[160px] overflow-y-auto divide-y divide-slate-100">
          {lines.slice(0, 8).map((l, i) => (
            <div key={l.id || i} className="px-3 py-1.5 flex justify-between gap-2 text-xs">
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold text-slate-700">
                  {l.product_name_snapshot || l.product_name_ar || '—'}
                </div>
                <div className="text-[10px] text-slate-400 font-mono">
                  {l.sku_snapshot || l.sku}
                  {l.color_name_snapshot && ` · ${l.color_name_snapshot}`}
                  {l.size_label_snapshot && ` · مقاس ${l.size_label_snapshot}`}
                </div>
              </div>
              <div className="text-slate-800 whitespace-nowrap">
                {l.quantity ?? l.qty}× {EGP(l.unit_price)}
              </div>
              <div className="font-bold text-slate-900 w-14 text-left">
                {EGP(l.line_total)}
              </div>
            </div>
          ))}
          {lines.length > 8 && (
            <div className="px-3 py-1 text-[10px] text-center text-slate-400">
              +{lines.length - 8} صنف إضافي…
            </div>
          )}
        </div>
      </div>

      {/* Totals */}
      <div className="space-y-0.5 text-xs">
        <Row label="المجموع" value={`${EGP(inv.subtotal)} ج.م`} />
        {disc > 0 && <Row label="خصم" value={`- ${EGP(disc)} ج.م`} />}
        {coupon > 0 && <Row label="كوبون" value={`- ${EGP(coupon)} ج.م`} />}
        {Number(inv.tax_amount) > 0 && (
          <Row label="ضريبة" value={`+ ${EGP(inv.tax_amount)} ج.م`} />
        )}
        <Row
          label="الإجمالي"
          value={`${EGP(inv.grand_total)} ج.م`}
          strong
        />
        {payments.length > 0 && (
          <Row
            label="مدفوع"
            value={`${EGP(inv.paid_amount || inv.paid_total)} ج.م`}
          />
        )}
        {Number(inv.gross_profit) > 0 && (
          <Row
            label="ربح"
            value={`${EGP(inv.gross_profit)} ج.م`}
            className="text-emerald-600"
          />
        )}
      </div>

      {/* Open full invoice */}
      <Link
        to={`/invoices?id=${invoiceId}`}
        className="flex items-center justify-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 pt-1 border-t border-slate-100"
      >
        <ExternalLink size={12} /> فتح الفاتورة الكاملة
      </Link>
    </div>
  );
}

function Row({
  label,
  value,
  strong,
  className,
}: { label: string; value: string; strong?: boolean; className?: string }) {
  return (
    <div className={`flex justify-between ${className || ''}`}>
      <span className="text-slate-500">{label}:</span>
      <span className={strong ? 'font-black text-slate-900 text-sm' : 'text-slate-700'}>
        {value}
      </span>
    </div>
  );
}

const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  paid: { label: 'مدفوعة', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  completed: { label: 'مكتملة', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  partially_paid: { label: 'مدفوعة جزئياً', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  draft: { label: 'مسودة', cls: 'bg-slate-50 text-slate-600 border-slate-200' },
  refunded: { label: 'مُسترجعة', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
  cancelled: { label: 'ملغية', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
};
function StatusChip({ status }: { status?: string }) {
  const s = STATUS_LABELS[status || 'draft'] || STATUS_LABELS.draft;
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${s.cls}`}>
      {s.label}
    </span>
  );
}
