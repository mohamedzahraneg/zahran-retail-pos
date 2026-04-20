import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, Printer, Plus, Minus, Trash2, Barcode as BarcodeIcon, PackageCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import { productsApi, Product, Variant } from '@/api/products.api';
import { stockApi } from '@/api/stock.api';
import { Barcode } from '@/components/Barcode';

interface LabelRow {
  variantId: string;
  code: string;
  sku: string;
  name: string;
  color: string | null;
  size: string | null;
  price: number;
  qty: number;
  stockQty: number;
}

type LabelSize = 'small' | 'medium' | 'large' | 'roll';

const LABEL_PRESETS: Record<
  LabelSize,
  {
    label: string;
    widthMm: number;
    heightMm: number;
    barcodeHeight: number;
    fontSize: number;
    showPrice: boolean;
    showName: boolean;
  }
> = {
  small: {
    label: 'صغير (30×20 مم)',
    widthMm: 30,
    heightMm: 20,
    barcodeHeight: 25,
    fontSize: 9,
    showPrice: false,
    showName: false,
  },
  medium: {
    label: 'متوسط (40×30 مم)',
    widthMm: 40,
    heightMm: 30,
    barcodeHeight: 35,
    fontSize: 10,
    showPrice: true,
    showName: false,
  },
  large: {
    label: 'كبير (60×40 مم)',
    widthMm: 60,
    heightMm: 40,
    barcodeHeight: 45,
    fontSize: 12,
    showPrice: true,
    showName: true,
  },
  roll: {
    label: 'رول (50×30 مم)',
    widthMm: 50,
    heightMm: 30,
    barcodeHeight: 35,
    fontSize: 10,
    showPrice: true,
    showName: true,
  },
};

export default function BarcodeLabels() {
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Product | null>(null);
  const [rows, setRows] = useState<LabelRow[]>([]);
  const [size, setSize] = useState<LabelSize>('medium');

  const { data: products } = useQuery({
    queryKey: ['products-labels', q],
    queryFn: () => productsApi.list({ q: q || undefined, limit: 30 }),
  });

  const { data: detail } = useQuery({
    queryKey: ['product-labels', selected?.id],
    queryFn: () => productsApi.get(selected!.id),
    enabled: !!selected?.id,
  });

  const { data: stockRows = [] } = useQuery({
    queryKey: ['product-stock', selected?.id],
    queryFn: () => stockApi.byProduct(selected!.id),
    enabled: !!selected?.id,
  });
  const stockByVariant = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of stockRows) m[s.variant_id] = Number(s.quantity_on_hand) || 0;
    return m;
  }, [stockRows]);

  const totalLabels = useMemo(
    () => rows.reduce((s, r) => s + r.qty, 0),
    [rows],
  );

  const addVariant = (variant: Variant, qtyOverride?: number) => {
    if (!selected) return;
    if (!variant.barcode) {
      toast.error('لا يوجد باركود لهذا المتغير');
      return;
    }
    const stockQty = stockByVariant[variant.id] ?? 0;
    const initialQty = qtyOverride ?? 1;
    setRows((prev) => {
      const existing = prev.find((r) => r.variantId === variant.id);
      if (existing) {
        return prev.map((r) =>
          r.variantId === variant.id
            ? { ...r, qty: qtyOverride ?? r.qty + 1, stockQty }
            : r,
        );
      }
      return [
        ...prev,
        {
          variantId: variant.id,
          code: variant.barcode!,
          sku: variant.sku,
          name: selected.name_ar,
          color: (variant as any).color ?? null,
          size: (variant as any).size ?? null,
          price: Number(variant.price_override ?? selected.base_price),
          qty: initialQty,
          stockQty,
        },
      ];
    });
  };

  const addAllFromStock = () => {
    if (!detail?.variants?.length) return;
    let added = 0;
    for (const v of detail.variants) {
      const s = stockByVariant[v.id] ?? 0;
      if (s > 0 && v.barcode) {
        addVariant(v as any, s);
        added++;
      }
    }
    if (added === 0) toast.error('لا يوجد مخزون لهذا المنتج');
    else toast.success(`تمت إضافة ${added} صنف بكمية المخزون`);
  };

  const updateQty = (variantId: string, qty: number) => {
    setRows((prev) =>
      qty <= 0
        ? prev.filter((r) => r.variantId !== variantId)
        : prev.map((r) => (r.variantId === variantId ? { ...r, qty } : r)),
    );
  };

  const removeRow = (variantId: string) => {
    setRows((prev) => prev.filter((r) => r.variantId !== variantId));
  };

  const handlePrint = () => {
    if (rows.length === 0) {
      toast.error('اختر منتجات أولاً');
      return;
    }
    window.print();
  };

  const preset = LABEL_PRESETS[size];

  // Expand rows to individual labels
  const labels = rows.flatMap((r) =>
    Array.from({ length: r.qty }, () => r),
  );

  return (
    <div className="space-y-6 print:space-y-0">
      <div className="flex items-center justify-between print:hidden">
        <div className="flex items-center gap-3">
          <BarcodeIcon size={28} className="text-brand-600" />
          <h2 className="text-2xl font-black text-slate-800">طباعة الباركود</h2>
        </div>
        <button
          onClick={handlePrint}
          disabled={rows.length === 0}
          className="btn-primary disabled:opacity-50"
        >
          <Printer size={18} />
          طباعة {totalLabels} ملصق
        </button>
      </div>

      {/* Editor */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 print:hidden">
        {/* Left: product selection */}
        <div className="card flex flex-col overflow-hidden h-[500px]">
          <div className="p-4 border-b border-slate-100">
            <div className="relative">
              <Search
                size={16}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
              />
              <input
                className="input pr-9"
                placeholder="ابحث عن منتج..."
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 flex-1 overflow-hidden">
            <div className="overflow-y-auto border-l border-slate-100">
              {products?.data.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setSelected(p)}
                  className={`w-full text-right p-3 border-b border-slate-100 hover:bg-slate-50 ${
                    selected?.id === p.id ? 'bg-brand-50' : ''
                  }`}
                >
                  <div className="font-semibold text-sm text-slate-800 truncate">
                    {p.name_ar}
                  </div>
                  <div className="text-xs text-slate-500 font-mono">
                    {p.sku_root}
                  </div>
                </button>
              ))}
              {!products?.data.length && (
                <div className="p-6 text-center text-slate-400">
                  ابحث لعرض المنتجات
                </div>
              )}
            </div>

            <div className="overflow-y-auto">
              {!selected && (
                <div className="p-6 text-center text-slate-400">
                  اختر منتجاً لعرض المتغيرات
                </div>
              )}
              {selected && !detail && (
                <div className="p-6 text-center text-slate-400">
                  جارٍ التحميل...
                </div>
              )}
              {detail?.variants && detail.variants.length > 0 && (
                <div className="p-2 border-b border-slate-100 bg-emerald-50">
                  <button
                    onClick={addAllFromStock}
                    className="w-full text-xs font-bold text-emerald-700 hover:bg-emerald-100 rounded p-2 flex items-center justify-center gap-1"
                  >
                    <PackageCheck size={14} />
                    إضافة الكل بكميات المخزون
                  </button>
                </div>
              )}
              {detail?.variants?.map((v) => {
                const stockQty = stockByVariant[v.id] ?? 0;
                return (
                <div
                  key={v.id}
                  className="p-3 border-b border-slate-100 flex items-center gap-2"
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-xs text-slate-700">{v.sku}</div>
                    <div className="text-xs text-slate-500 flex gap-2 flex-wrap">
                      {(v as any).color && <span>{(v as any).color}</span>}
                      {(v as any).size && <span className="font-bold">مقاس {(v as any).size}</span>}
                      <span className={stockQty > 0 ? 'text-emerald-600 font-bold' : 'text-slate-400'}>
                        رصيد: {stockQty}
                      </span>
                    </div>
                    <div className="text-xs text-slate-400 font-mono mt-0.5">
                      {v.barcode || '— لا يوجد باركود —'}
                    </div>
                  </div>
                  <button
                    onClick={() => addVariant(v)}
                    disabled={!v.barcode}
                    className="btn-ghost text-xs disabled:opacity-40"
                  >
                    <Plus size={14} /> إضافة
                  </button>
                </div>
              );
              })}
            </div>
          </div>
        </div>

        {/* Right: selected rows */}
        <div className="card flex flex-col overflow-hidden h-[500px]">
          <div className="p-4 border-b border-slate-100 flex items-center justify-between">
            <div className="font-bold text-slate-800">
              الملصقات المختارة ({rows.length} صنف · {totalLabels} ملصق)
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-slate-500">الحجم:</label>
              <select
                className="input py-1 text-sm w-auto"
                value={size}
                onChange={(e) => setSize(e.target.value as LabelSize)}
              >
                {(Object.entries(LABEL_PRESETS) as [LabelSize, typeof preset][]).map(
                  ([k, v]) => (
                    <option key={k} value={k}>
                      {v.label}
                    </option>
                  ),
                )}
              </select>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {rows.length === 0 && (
              <div className="p-12 text-center text-slate-400">
                لم تتم إضافة أي متغيرات بعد
              </div>
            )}
            {rows.map((r) => (
              <div
                key={r.variantId}
                className="flex items-center gap-2 p-3 border-b border-slate-100"
              >
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-sm truncate">{r.name}</div>
                  <div className="text-xs text-slate-500 font-mono flex gap-2 flex-wrap">
                    <span>{r.sku}</span>
                    {r.size && <span className="font-bold text-slate-700">مقاس {r.size}</span>}
                    {r.color && <span>{r.color}</span>}
                    {r.stockQty > 0 && <span className="text-emerald-600">رصيد: {r.stockQty}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => updateQty(r.variantId, r.qty - 1)}
                    className="w-7 h-7 rounded bg-slate-100 hover:bg-slate-200"
                  >
                    <Minus size={14} className="mx-auto" />
                  </button>
                  <input
                    type="number"
                    min={0}
                    value={r.qty}
                    onChange={(e) =>
                      updateQty(r.variantId, parseInt(e.target.value, 10) || 0)
                    }
                    className="w-14 text-center font-bold input py-1"
                  />
                  <button
                    onClick={() => updateQty(r.variantId, r.qty + 1)}
                    className="w-7 h-7 rounded bg-slate-100 hover:bg-slate-200"
                  >
                    <Plus size={14} className="mx-auto" />
                  </button>
                </div>
                <button
                  onClick={() => removeRow(r.variantId)}
                  className="text-rose-500 hover:bg-rose-50 p-1.5 rounded"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Preview + Print area */}
      {rows.length > 0 && (
        <>
          <div className="card p-4 print:hidden">
            <div className="text-xs font-bold text-slate-500 mb-3">معاينة:</div>
            <div
              className="flex flex-wrap gap-2 p-4 bg-slate-50 rounded-lg"
              style={{ direction: 'ltr' }}
            >
              {labels.slice(0, 12).map((r, i) => (
                <LabelCard key={i} row={r} size={size} />
              ))}
              {labels.length > 12 && (
                <div className="flex items-center justify-center text-slate-400 text-sm px-3">
                  + {labels.length - 12} ملصق آخر...
                </div>
              )}
            </div>
          </div>

          <div className="print-area">
            {labels.map((r, i) => (
              <LabelCard key={i} row={r} size={size} />
            ))}
          </div>
        </>
      )}

      {/* Print styles */}
      <style>{`
        .print-area {
          display: none;
        }
        @media print {
          @page {
            size: auto;
            margin: 4mm;
          }
          body * {
            visibility: hidden;
          }
          .print-area, .print-area * {
            visibility: visible;
          }
          .print-area {
            display: flex;
            flex-wrap: wrap;
            gap: 2mm;
            position: absolute;
            inset: 0;
            direction: ltr;
          }
        }
      `}</style>
    </div>
  );
}

function LabelCard({ row, size }: { row: LabelRow; size: LabelSize }) {
  const preset = LABEL_PRESETS[size];
  return (
    <div
      className="bg-white border border-slate-300 flex flex-col items-center justify-center p-0.5"
      style={{
        width: `${preset.widthMm}mm`,
        height: `${preset.heightMm}mm`,
        pageBreakInside: 'avoid',
        breakInside: 'avoid',
      }}
    >
      {preset.showName && (
        <div
          className="font-bold text-center truncate w-full"
          style={{ fontSize: `${preset.fontSize - 2}px`, lineHeight: 1.1 }}
        >
          {row.name}
        </div>
      )}
      <Barcode
        value={row.code}
        width={1.5}
        height={preset.barcodeHeight}
        fontSize={preset.fontSize}
        margin={0}
        textMargin={1}
      />
      <div
        className="flex items-center justify-center gap-1.5 w-full"
        style={{ fontSize: `${preset.fontSize}px`, lineHeight: 1 }}
      >
        {row.size && (
          <span className="font-bold">مقاس {row.size}</span>
        )}
        {preset.showPrice && (
          <span className="font-black">{row.price.toFixed(0)} ج.م</span>
        )}
      </div>
    </div>
  );
}
