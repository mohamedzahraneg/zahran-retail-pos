/**
 * PurchaseReturns.tsx — PR-P2.4A
 *
 * List page for the upgraded `/purchases/returns*` namespace with
 * status filter tabs, supplier search, and a status-aware cancel
 * button. Create flow lives in the Purchases page (per-row "مرتجع"
 * action → CreatePurchaseReturnModal), mirroring the sales-returns
 * UX where returns are always anchored to a parent invoice.
 */
import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Undo2,
  Search,
  CheckCircle2,
  XCircle,
  FileText,
  Wallet,
  Banknote,
  Coins,
  ShieldOff,
  type LucideIcon,
} from 'lucide-react';
import {
  purchaseReturnsApi,
  PurchaseReturnListItem,
  PurchaseReturnSettlementType,
  PurchaseReturnStatus,
} from '@/api/purchaseReturns.api';

const STATUS_LABEL: Record<PurchaseReturnStatus, string> = {
  draft: 'مسودة',
  posted: 'مرحّل',
  cancelled: 'ملغى',
};

const STATUS_COLOR: Record<PurchaseReturnStatus, string> = {
  draft: 'bg-slate-100 text-slate-700',
  posted: 'bg-emerald-100 text-emerald-700',
  cancelled: 'bg-rose-100 text-rose-700',
};

const SETTLEMENT_LABEL: Record<PurchaseReturnSettlementType, string> = {
  supplier_credit: 'رصيد دائن للمورد',
  cash_refund: 'استرداد نقدي',
  bank_refund: 'استرداد بنكي',
  no_settlement: 'بدون تسوية',
};

const SETTLEMENT_ICON: Record<PurchaseReturnSettlementType, LucideIcon> = {
  supplier_credit: Wallet,
  cash_refund: Coins,
  bank_refund: Banknote,
  no_settlement: ShieldOff,
};

const fmtDate = (s?: string | null) =>
  s ? new Date(s).toLocaleDateString('en-GB') : '—';

const fmtMoney = (s: string | number | null | undefined) => {
  if (s === null || s === undefined) return '—';
  const n = typeof s === 'string' ? Number(s) : s;
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-EG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
};

export default function PurchaseReturns() {
  const [statusFilter, setStatusFilter] = useState<PurchaseReturnStatus | ''>('');
  const [q, setQ] = useState('');
  const qc = useQueryClient();

  const { data: returns = [], isLoading } = useQuery({
    queryKey: ['purchase-returns', statusFilter, q],
    queryFn: () =>
      purchaseReturnsApi.list({
        status: statusFilter || undefined,
        q: q.trim() || undefined,
      }),
  });

  const counts = useMemo(() => {
    const c = { posted: 0, cancelled: 0, draft: 0, all: returns.length };
    for (const r of returns) c[r.status]++;
    return c;
  }, [returns]);

  const cancelM = useMutation({
    mutationFn: (id: string) => purchaseReturnsApi.cancel(id),
    onSuccess: () => {
      toast.success('تم إلغاء المرتجع وعكس القيد والمخزون');
      qc.invalidateQueries({ queryKey: ['purchase-returns'] });
    },
    onError: (e: any) =>
      toast.error(
        e?.response?.data?.message || 'فشل إلغاء المرتجع',
      ),
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-black text-slate-800 flex items-center gap-2">
            <Undo2 className="text-brand-600" /> مرتجع مشتريات
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            إنشاء مرتجع جديد من شاشة فاتورة المشتريات. هنا قائمة كل المرتجعات
            المرحّلة والملغاة.
          </p>
        </div>
        <div className="relative">
          <Search size={16} className="absolute right-3 top-3 text-slate-400" />
          <input
            className="rounded-xl border border-slate-200 px-9 py-2 text-sm bg-white w-64"
            placeholder="بحث برقم المرتجع أو اسم المورد"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>

      {/* Status tabs */}
      <div className="flex flex-wrap gap-2">
        <TabBtn active={!statusFilter} onClick={() => setStatusFilter('')}>
          الكل <Badge>{counts.all}</Badge>
        </TabBtn>
        <TabBtn
          active={statusFilter === 'posted'}
          onClick={() => setStatusFilter('posted')}
        >
          مرحّل <Badge>{counts.posted}</Badge>
        </TabBtn>
        <TabBtn
          active={statusFilter === 'cancelled'}
          onClick={() => setStatusFilter('cancelled')}
        >
          ملغى <Badge>{counts.cancelled}</Badge>
        </TabBtn>
      </div>

      {/* Table */}
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              <Th>رقم</Th>
              <Th>التاريخ</Th>
              <Th>المورد</Th>
              <Th>المخزن</Th>
              <Th>القيمة</Th>
              <Th>الأصناف</Th>
              <Th>التسوية</Th>
              <Th>الحالة</Th>
              <Th>إجراءات</Th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <Td className="text-center text-slate-400" colSpan={9}>
                  جاري التحميل…
                </Td>
              </tr>
            ) : returns.length === 0 ? (
              <tr>
                <Td className="text-center text-slate-400 py-8" colSpan={9}>
                  لا توجد مرتجعات تطابق المرشحات الحالية.
                </Td>
              </tr>
            ) : (
              returns.map((r) => (
                <RowView key={r.id} row={r} onCancel={(id) => cancelM.mutate(id)} />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RowView({
  row,
  onCancel,
}: {
  row: PurchaseReturnListItem;
  onCancel: (id: string) => void;
}) {
  const Icon = SETTLEMENT_ICON[row.settlement_type];
  const canCancel = row.status === 'posted';

  return (
    <tr className="border-t hover:bg-slate-50/50">
      <Td className="font-bold text-slate-700">{row.return_no}</Td>
      <Td className="text-slate-600">{fmtDate(row.return_date)}</Td>
      <Td className="text-slate-700">{row.supplier_name || '—'}</Td>
      <Td className="text-slate-600">{row.warehouse_name || '—'}</Td>
      <Td className="font-bold text-slate-800">
        {fmtMoney(row.total_amount)}
      </Td>
      <Td className="text-slate-600 text-center">{row.items_count}</Td>
      <Td>
        <span className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-lg bg-slate-50 text-slate-700">
          <Icon size={14} />
          {SETTLEMENT_LABEL[row.settlement_type]}
        </span>
      </Td>
      <Td>
        <span
          className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg font-bold ${STATUS_COLOR[row.status]}`}
        >
          {row.status === 'posted' && <CheckCircle2 size={12} />}
          {row.status === 'cancelled' && <XCircle size={12} />}
          {row.status === 'draft' && <FileText size={12} />}
          {STATUS_LABEL[row.status]}
        </span>
      </Td>
      <Td>
        {canCancel ? (
          <button
            className="text-xs px-2.5 py-1.5 rounded-lg bg-rose-50 text-rose-700 hover:bg-rose-100 font-bold"
            onClick={() => {
              if (
                window.confirm(
                  `هل تريد إلغاء المرتجع ${row.return_no}؟ سيتم عكس المخزون والقيد المحاسبي.`,
                )
              ) {
                onCancel(row.id);
              }
            }}
          >
            إلغاء
          </button>
        ) : (
          <span className="text-xs text-slate-400">—</span>
        )}
      </Td>
    </tr>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`px-4 py-2 rounded-xl text-sm font-bold flex items-center gap-2 ${
        active
          ? 'bg-brand-600 text-white shadow'
          : 'bg-white text-slate-700 hover:bg-slate-50'
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="bg-white/20 text-xs px-1.5 py-0.5 rounded-md">
      {children}
    </span>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return <th className="text-right font-bold text-xs p-3">{children}</th>;
}

function Td({
  children,
  className = '',
  colSpan,
}: {
  children: React.ReactNode;
  className?: string;
  colSpan?: number;
}) {
  return (
    <td className={`p-3 ${className}`} colSpan={colSpan}>
      {children}
    </td>
  );
}
