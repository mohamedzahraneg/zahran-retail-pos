import { useMemo, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  FileUp,
  Download,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Upload,
  RefreshCw,
  Package,
  Users,
  Truck,
  Warehouse,
} from 'lucide-react';
import { importApi, ImportReport } from '@/api/import.api';

type Tab = 'products' | 'customers' | 'suppliers' | 'opening-stock';

interface TabDef {
  id: Tab;
  label: string;
  icon: React.ReactNode;
  template?: string;
  description: string;
  columns: string[];
}

const TABS: TabDef[] = [
  {
    id: 'products',
    label: 'المنتجات',
    icon: <Package size={18} />,
    template: '/templates/zahran_products_import_template.xlsx',
    description:
      'استورد كتالوج كامل من المنتجات والمتغيرات مع الرصيد الابتدائي للمخزن المستهدف.',
    columns: [
      'product_name',
      'category',
      'type',
      'color',
      'size',
      'cost_price',
      'selling_price',
      'quantity',
      'sku',
      'barcode',
      'brand',
      'target_audience',
    ],
  },
  {
    id: 'customers',
    label: 'العملاء',
    icon: <Users size={18} />,
    template: '/templates/zahran_customers_import_template.xlsx',
    description:
      'استورد قاعدة عملاء من نظام قديم — يتم المطابقة بالهاتف أو البريد أو الرقم القومي.',
    columns: [
      'full_name',
      'phone',
      'alt_phone',
      'email',
      'national_id',
      'birth_date',
      'gender',
      'address_line',
      'city',
      'governorate',
      'loyalty_points',
      'loyalty_tier',
      'total_spent',
      'is_vip',
      'notes',
    ],
  },
  {
    id: 'suppliers',
    label: 'الموردين',
    icon: <Truck size={18} />,
    template: '/templates/zahran_suppliers_import_template.xlsx',
    description:
      'استورد قائمة موردين مع الرصيد الجاري الافتتاحي وشروط السداد.',
    columns: [
      'name',
      'contact_person',
      'phone',
      'alt_phone',
      'email',
      'address',
      'tax_number',
      'payment_terms_days',
      'credit_limit',
      'current_balance',
      'is_active',
      'notes',
    ],
  },
  {
    id: 'opening-stock',
    label: 'أرصدة افتتاحية',
    icon: <Warehouse size={18} />,
    template: '/templates/zahran_opening_stock_template.xlsx',
    description:
      'ضبط كميات المخزون الفعلية لكل SKU/مخزن إلى القيمة الافتتاحية عند بداية التشغيل.',
    columns: ['sku', 'warehouse_code', 'quantity', 'cost_price', 'notes'],
  },
];

export default function Import() {
  const [tab, setTab] = useState<Tab>('products');
  const [file, setFile] = useState<File | null>(null);
  const [warehouseCode, setWarehouseCode] = useState('ZHR-01');
  const [upsert, setUpsert] = useState(true);
  const [report, setReport] = useState<ImportReport | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const active = useMemo(() => TABS.find((t) => t.id === tab)!, [tab]);

  const validateMutation = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('no file');
      if (tab === 'products')
        return importApi.validate(file, warehouseCode || undefined);
      if (tab === 'customers') return importApi.validateCustomers(file);
      if (tab === 'suppliers') return importApi.validateSuppliers(file);
      return importApi.validateOpeningStock(file);
    },
    onSuccess: (r) => {
      setReport(r);
      if (r.invalid === 0) {
        toast.success(`الملف صالح — ${r.valid} صف جاهز`);
      } else {
        toast.error(`${r.invalid} صف به أخطاء`);
      }
    },
  });

  const importMutation = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('no file');
      if (tab === 'products')
        return importApi.importProducts(file, warehouseCode || undefined);
      if (tab === 'customers') return importApi.importCustomers(file, upsert);
      if (tab === 'suppliers') return importApi.importSuppliers(file, upsert);
      return importApi.applyOpeningStock(file);
    },
    onSuccess: (r) => {
      setReport(r);
      if (tab === 'products') {
        toast.success(`تم استيراد ${r.inserted} منتج`);
      } else if (tab === 'opening-stock') {
        toast.success(`تم تطبيق ${r.applied ?? 0} رصيد افتتاحي`);
      } else {
        toast.success(
          `تم: ${r.inserted} جديد · ${r.updated ?? 0} تحديث · ${r.skipped ?? 0} تخطي`,
        );
      }
    },
  });

  const handleFile = (f: File | null) => {
    setFile(f);
    setReport(null);
  };

  const switchTab = (t: Tab) => {
    setTab(t);
    setFile(null);
    setReport(null);
  };

  const allValid = report && report.invalid === 0 && report.total > 0;

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <div>
        <h2 className="text-2xl font-black text-slate-800 flex items-center gap-2">
          <FileUp className="text-brand-600" /> استيراد البيانات
        </h2>
        <p className="text-sm text-slate-500 mt-1">
          استورد المنتجات، العملاء، الموردين، أو أرصدة المخزون الافتتاحية من ملفات Excel.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2 border-b border-slate-200 pb-0">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => switchTab(t.id)}
            className={`px-4 py-2 rounded-t-lg font-bold text-sm flex items-center gap-2 border-b-2 transition ${
              tab === t.id
                ? 'border-brand-600 text-brand-700 bg-brand-50/50'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      <div className="card p-5 bg-sky-50/40 border-sky-200">
        <div className="text-sm text-slate-700 mb-2">{active.description}</div>
        <div className="text-[11px] text-slate-500">
          <span className="font-bold">الأعمدة المدعومة:</span>{' '}
          <code className="text-[10px] bg-white/70 px-1 rounded">
            {active.columns.join(' · ')}
          </code>
        </div>
      </div>

      {/* Step 1: Download template */}
      <div className="card p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="font-bold text-slate-800 mb-1">1 · تنزيل القالب</div>
            <div className="text-xs text-slate-500">
              القالب الرسمي يحتوي على الأعمدة المطلوبة والأمثلة.
            </div>
          </div>
          {active.template && (
            <a href={active.template} download className="btn-secondary">
              <Download size={16} /> تنزيل القالب
            </a>
          )}
        </div>
      </div>

      {/* Step 2: Upload */}
      <div className="card p-5">
        <div className="font-bold text-slate-800 mb-3">2 · رفع الملف</div>

        <div className="grid md:grid-cols-[1fr_220px] gap-3 mb-3">
          <div
            className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition ${
              file ? 'border-brand-300 bg-brand-50/30' : 'border-slate-200 hover:border-brand-200'
            }`}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files?.[0];
              if (f) handleFile(f);
            }}
          >
            <Upload className="mx-auto mb-2 text-slate-400" />
            {file ? (
              <div>
                <div className="font-bold text-slate-800">{file.name}</div>
                <div className="text-xs text-slate-500">
                  {(file.size / 1024).toFixed(1)} KB
                </div>
              </div>
            ) : (
              <div>
                <div className="font-bold text-slate-600">اسحب الملف هنا أو انقر للاختيار</div>
                <div className="text-xs text-slate-400 mt-1">يقبل .xlsx / .xls فقط</div>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              className="hidden"
              onChange={(e) => handleFile(e.target.files?.[0] || null)}
            />
          </div>

          <div className="space-y-2">
            {tab === 'products' && (
              <div>
                <label className="text-xs font-bold text-slate-600 block mb-1">
                  المخزن المستهدف
                </label>
                <input
                  className="input"
                  value={warehouseCode}
                  onChange={(e) => setWarehouseCode(e.target.value)}
                  placeholder="ZHR-01"
                />
              </div>
            )}
            {(tab === 'customers' || tab === 'suppliers') && (
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  className="accent-brand-600"
                  checked={upsert}
                  onChange={(e) => setUpsert(e.target.checked)}
                />
                تحديث السجلات الموجودة (Upsert)
              </label>
            )}
          </div>
        </div>

        <div className="flex gap-2">
          <button
            className="btn-secondary"
            disabled={!file || validateMutation.isPending}
            onClick={() => validateMutation.mutate()}
          >
            {validateMutation.isPending ? (
              <RefreshCw size={16} className="animate-spin" />
            ) : (
              <CheckCircle2 size={16} />
            )}{' '}
            تحقق أولاً
          </button>
          <button
            className="btn-primary"
            disabled={!file || !allValid || importMutation.isPending}
            onClick={() => importMutation.mutate()}
          >
            {importMutation.isPending ? (
              <RefreshCw size={16} className="animate-spin" />
            ) : (
              <Upload size={16} />
            )}{' '}
            تنفيذ الاستيراد
          </button>
        </div>
      </div>

      {/* Step 3: Results */}
      {report && (
        <div className="card p-5">
          <div className="font-bold text-slate-800 mb-3">3 · النتيجة</div>

          <div className="grid md:grid-cols-5 gap-3 mb-4">
            <SummaryCard label="إجمالي" value={report.total} color="bg-slate-100 text-slate-700" />
            <SummaryCard
              label="صالحة"
              value={report.valid}
              icon={<CheckCircle2 size={18} />}
              color="bg-emerald-100 text-emerald-800"
            />
            <SummaryCard
              label="أخطاء"
              value={report.invalid}
              icon={<XCircle size={18} />}
              color="bg-rose-100 text-rose-800"
            />
            <SummaryCard
              label={tab === 'opening-stock' ? 'طُبقت' : 'أُدرجت'}
              value={tab === 'opening-stock' ? (report.applied ?? 0) : report.inserted}
              icon={<Upload size={18} />}
              color="bg-brand-100 text-brand-800"
            />
            <SummaryCard
              label="تحديث / تخطي"
              value={(report.updated ?? 0) + (report.skipped ?? 0)}
              color="bg-amber-100 text-amber-800"
            />
          </div>

          {report.rows.length > 0 && (
            <div className="border border-slate-200 rounded-lg overflow-hidden">
              <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-100 text-slate-600 sticky top-0">
                    <tr>
                      <th className="text-right px-3 py-2">#</th>
                      <th className="text-right px-3 py-2">الحالة</th>
                      {active.columns.slice(0, 4).map((c) => (
                        <th key={c} className="text-right px-3 py-2">{c}</th>
                      ))}
                      <th className="text-right px-3 py-2">الأخطاء / التحذيرات</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows.map((r) => (
                      <tr
                        key={r.row}
                        className={`border-t border-slate-100 ${
                          r.errors.length ? 'bg-rose-50/40' : ''
                        }`}
                      >
                        <td className="px-3 py-2 font-mono">#{r.row}</td>
                        <td className="px-3 py-2">
                          {r.errors.length === 0 ? (
                            <CheckCircle2 size={16} className="text-emerald-600" />
                          ) : (
                            <AlertCircle size={16} className="text-rose-600" />
                          )}
                        </td>
                        {active.columns.slice(0, 4).map((c) => (
                          <td key={c} className="px-3 py-2 text-slate-700">
                            {String(r.data[c] ?? '—')}
                          </td>
                        ))}
                        <td className="px-3 py-2 text-[11px]">
                          {r.errors.length > 0 && (
                            <div className="text-rose-700">{r.errors.join(' · ')}</div>
                          )}
                          {r.warnings && r.warnings.length > 0 && (
                            <div className="text-amber-700">⚠ {r.warnings.join(' · ')}</div>
                          )}
                          {r.errors.length === 0 && !r.warnings?.length && '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  color,
  icon,
}: {
  label: string;
  value: number;
  color: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className={`rounded-xl p-4 ${color}`}>
      <div className="text-xs opacity-80 flex items-center gap-1">
        {icon} {label}
      </div>
      <div className="font-black text-3xl mt-1">{value}</div>
    </div>
  );
}
