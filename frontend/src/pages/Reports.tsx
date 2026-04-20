import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart3,
  TrendingUp,
  Package,
  Undo2,
  Users,
  Truck,
  FileSpreadsheet,
  FileText,
  Calendar,
  RefreshCw,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { reportsApi } from '@/api/reports.api';

const EGP = (n: number | string) =>
  `${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م`;

type TabKey =
  | 'sales'
  | 'profit'
  | 'top-products'
  | 'sales-per-user'
  | 'returns'
  | 'stock-valuation'
  | 'low-stock'
  | 'dead-stock'
  | 'customers-outstanding'
  | 'suppliers-outstanding';

const TABS: { key: TabKey; label: string; icon: any; needsRange: boolean }[] = [
  { key: 'sales', label: 'المبيعات', icon: BarChart3, needsRange: true },
  { key: 'profit', label: 'الأرباح', icon: TrendingUp, needsRange: true },
  { key: 'top-products', label: 'أفضل المنتجات', icon: Package, needsRange: true },
  { key: 'sales-per-user', label: 'مبيعات الكاشير', icon: Users, needsRange: true },
  { key: 'returns', label: 'المرتجعات', icon: Undo2, needsRange: true },
  { key: 'stock-valuation', label: 'تقييم المخزون', icon: Package, needsRange: false },
  { key: 'low-stock', label: 'مخزون منخفض', icon: Package, needsRange: false },
  { key: 'dead-stock', label: 'مخزون راكد', icon: Package, needsRange: false },
  {
    key: 'customers-outstanding',
    label: 'مستحقات العملاء',
    icon: Users,
    needsRange: false,
  },
  {
    key: 'suppliers-outstanding',
    label: 'مستحقات الموردين',
    icon: Truck,
    needsRange: false,
  },
];

export default function Reports() {
  const today = new Date().toISOString().slice(0, 10);
  const lastMonth = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);

  const [tab, setTab] = useState<TabKey>('sales');
  const [from, setFrom] = useState(lastMonth);
  const [to, setTo] = useState(today);
  const [groupBy, setGroupBy] = useState<'day' | 'week' | 'month'>('day');

  const tabDef = TABS.find((t) => t.key === tab)!;
  const params = tabDef.needsRange
    ? { from, to, ...(tab === 'sales' ? { group_by: groupBy } : {}) }
    : {};

  const { data = [], isLoading, refetch } = useQuery({
    queryKey: ['report', tab, params],
    queryFn: () => {
      switch (tab) {
        case 'sales':
          return reportsApi.sales({ from, to, group_by: groupBy });
        case 'profit':
          return reportsApi.profit({ from, to });
        case 'top-products':
          return reportsApi.topProducts({ from, to });
        case 'sales-per-user':
          return reportsApi.salesPerUser({ from, to });
        case 'returns':
          return reportsApi.returns({ from, to });
        case 'stock-valuation':
          return reportsApi.stockValuation();
        case 'low-stock':
          return reportsApi.lowStock();
        case 'dead-stock':
          return reportsApi.deadStock();
        case 'customers-outstanding':
          return reportsApi.customersOutstanding();
        case 'suppliers-outstanding':
          return reportsApi.suppliersOutstanding();
      }
    },
  });

  const exportFile = async (fmt: 'xlsx' | 'pdf') => {
    try {
      await reportsApi.export(tab, fmt, params);
      toast.success(`تم تنزيل ${fmt.toUpperCase()}`);
    } catch {
      toast.error('فشل التصدير');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-black text-slate-800 flex items-center gap-2">
            <BarChart3 className="text-brand-600" /> التقارير
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            تقارير المبيعات والأرباح والمخزون قابلة للتصدير
          </p>
        </div>
        <div className="flex gap-2">
          <button
            className="btn-secondary text-emerald-700 bg-emerald-50 hover:bg-emerald-100"
            onClick={() => exportFile('xlsx')}
            disabled={!data.length}
          >
            <FileSpreadsheet size={16} /> Excel
          </button>
          <button
            className="btn-secondary text-rose-700 bg-rose-50 hover:bg-rose-100"
            onClick={() => exportFile('pdf')}
            disabled={!data.length}
          >
            <FileText size={16} /> PDF
          </button>
          <button className="btn-secondary" onClick={() => refetch()}>
            <RefreshCw size={16} /> تحديث
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="card p-4 flex items-center gap-3 flex-wrap">
        {tabDef.needsRange && (
          <>
            <div className="flex items-center gap-2">
              <Calendar size={16} className="text-slate-400" />
              <span className="text-xs text-slate-500">من</span>
              <input
                type="date"
                className="input w-auto"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500">إلى</span>
              <input
                type="date"
                className="input w-auto"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
            {tab === 'sales' && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">تجميع</span>
                <select
                  className="input w-auto"
                  value={groupBy}
                  onChange={(e) => setGroupBy(e.target.value as any)}
                >
                  <option value="day">يومي</option>
                  <option value="week">أسبوعي</option>
                  <option value="month">شهري</option>
                </select>
              </div>
            )}
          </>
        )}
        {!tabDef.needsRange && (
          <div className="text-xs text-slate-500">هذا التقرير لحظي (بدون فترة)</div>
        )}
      </div>

      {/* Tabs */}
      <div className="card p-0 overflow-hidden">
        <div className="flex flex-wrap border-b border-slate-200 bg-slate-50/60">
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-4 py-3 font-bold text-xs transition border-b-2 flex items-center gap-1.5 ${
                tab === key
                  ? 'border-brand-600 text-brand-700 bg-white'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="overflow-x-auto">
          {isLoading ? (
            <div className="text-center py-12 text-slate-400">
              <RefreshCw className="animate-spin mx-auto mb-2" /> جارٍ التحميل...
            </div>
          ) : !data.length ? (
            <div className="text-center py-12 text-slate-400">لا توجد بيانات</div>
          ) : (
            <ReportTable tab={tab} rows={data} />
          )}
        </div>

        {data.length > 0 && (
          <div className="p-3 bg-slate-50/60 border-t border-slate-100 text-xs text-slate-500 text-center">
            عدد الصفوف: {data.length}
          </div>
        )}
      </div>
    </div>
  );
}

function ReportTable({ tab, rows }: { tab: TabKey; rows: any[] }) {
  switch (tab) {
    case 'sales':
      return <GenericTable
        rows={rows}
        cols={[
          { key: 'period', label: 'الفترة', fmt: (v) => new Date(v).toLocaleDateString('en-US') },
          { key: 'invoices_count', label: 'عدد الفواتير' },
          { key: 'revenue', label: 'الإيراد', fmt: EGP, bold: true, color: 'text-emerald-700' },
          { key: 'collected', label: 'المحصّل', fmt: EGP },
          { key: 'discounts', label: 'الخصومات', fmt: EGP, color: 'text-rose-600' },
          { key: 'avg_ticket', label: 'متوسط الفاتورة', fmt: EGP },
        ]}
      />;
    case 'profit':
      return <GenericTable rows={rows} cols={[
        { key: 'day', label: 'اليوم', fmt: (v) => new Date(v).toLocaleDateString('en-US') },
        { key: 'revenue', label: 'الإيراد', fmt: EGP },
        { key: 'cogs', label: 'تكلفة البضاعة', fmt: EGP, color: 'text-rose-600' },
        { key: 'gross_profit', label: 'ربح إجمالي', fmt: EGP, bold: true, color: 'text-emerald-700' },
        { key: 'net_profit', label: 'ربح صافي', fmt: EGP, bold: true, color: 'text-emerald-800' },
        { key: 'margin_pct', label: 'الهامش %', fmt: (v) => `${Number(v).toFixed(1)}%` },
      ]} />;
    case 'top-products':
      return <GenericTable rows={rows} cols={[
        { key: 'product_name', label: 'المنتج', bold: true },
        { key: 'sku_root', label: 'SKU', mono: true },
        { key: 'units_sold', label: 'كمية مباعة' },
        { key: 'revenue', label: 'الإيراد', fmt: EGP },
        { key: 'cogs', label: 'التكلفة', fmt: EGP },
        { key: 'profit', label: 'الربح', fmt: EGP, bold: true, color: 'text-emerald-700' },
      ]} />;
    case 'sales-per-user':
      return <GenericTable rows={rows} cols={[
        { key: 'full_name', label: 'الكاشير', bold: true },
        { key: 'username', label: 'المستخدم', mono: true },
        { key: 'invoices_count', label: 'الفواتير' },
        { key: 'revenue', label: 'المبيعات', fmt: EGP, bold: true },
        { key: 'avg_ticket', label: 'متوسط', fmt: EGP },
        { key: 'discounts', label: 'خصومات', fmt: EGP, color: 'text-rose-600' },
      ]} />;
    case 'returns':
      return <GenericTable rows={rows} cols={[
        { key: 'return_no', label: 'رقم المرتجع', mono: true, bold: true },
        { key: 'invoice_no', label: 'الفاتورة الأصلية', mono: true },
        { key: 'customer_name', label: 'العميل' },
        { key: 'reason', label: 'السبب' },
        { key: 'status', label: 'الحالة' },
        { key: 'total_refund', label: 'الإجمالي', fmt: EGP },
        { key: 'net_refund', label: 'الصافي', fmt: EGP, bold: true },
        { key: 'requested_at', label: 'التاريخ', fmt: (v) => new Date(v).toLocaleDateString('en-US') },
      ]} />;
    case 'stock-valuation':
      return <GenericTable rows={rows} cols={[
        { key: 'warehouse_name', label: 'المخزن', bold: true },
        { key: 'variants_count', label: 'عدد الأصناف' },
        { key: 'total_units', label: 'إجمالي الكمية' },
        { key: 'total_cost', label: 'قيمة التكلفة', fmt: EGP },
        { key: 'total_retail', label: 'قيمة البيع', fmt: EGP, bold: true, color: 'text-emerald-700' },
      ]} />;
    default:
      return <GenericTable rows={rows} cols={Object.keys(rows[0]).map((k) => ({ key: k, label: k }))} />;
  }
}

interface Col {
  key: string;
  label: string;
  fmt?: (v: any) => string;
  bold?: boolean;
  mono?: boolean;
  color?: string;
}

function GenericTable({ rows, cols }: { rows: any[]; cols: Col[] }) {
  return (
    <table className="min-w-full text-sm">
      <thead className="bg-slate-50/60 text-slate-600 text-xs font-bold">
        <tr>
          {cols.map((c) => (
            <th key={c.key} className="text-right px-3 py-2">
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-t border-slate-100 hover:bg-slate-50/40">
            {cols.map((c) => {
              const v = r[c.key];
              const disp = c.fmt ? c.fmt(v) : v == null ? '—' : String(v);
              return (
                <td
                  key={c.key}
                  className={`px-3 py-2 ${c.bold ? 'font-bold' : ''} ${c.mono ? 'font-mono text-xs' : ''} ${c.color || ''}`}
                >
                  {disp}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
