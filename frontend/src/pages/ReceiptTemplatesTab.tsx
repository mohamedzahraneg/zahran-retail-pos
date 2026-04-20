import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Save, Trash2, Copy, Check } from 'lucide-react';
import toast from 'react-hot-toast';
import { settingsApi } from '@/api/settings.api';
import {
  BLANK_TEMPLATE,
  DEFAULT_TEMPLATES,
  FONT_OPTIONS,
  type ReceiptTemplate,
} from '@/types/receipt-template';
import { Receipt } from '@/components/Receipt';

/** Sample data used to render the live preview on the right. */
const SAMPLE: any = {
  invoice: {
    id: 'preview',
    invoice_no: 'INV-PREVIEW-001',
    subtotal: 640,
    invoice_discount: 40,
    invoice_discount_type: 'percentage',
    invoice_discount_value: 10,
    coupon_discount: 20,
    coupon_code: 'EID2026',
    grand_total: 580,
    gross_profit: 180,
    paid_amount: 600,
    change_amount: 20,
    notes: 'ملاحظات تجريبية على الفاتورة',
    created_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    customer_name: 'عميل تجريبي',
    customer_phone: '01000000000',
    customer_loyalty_points: 125,
    cashier_name: 'الكاشير',
    salesperson_name: 'البائع',
    warehouse_name: 'المستودع الرئيسي',
  },
  lines: [
    {
      id: '1',
      product_name_snapshot: 'حذاء رسمي',
      sku_snapshot: 'SHOE-42',
      color_name_snapshot: 'أسود',
      size_label_snapshot: '42',
      quantity: 1,
      unit_price: 450,
      line_total: 450,
    },
    {
      id: '2',
      product_name_snapshot: 'شنطة يد',
      sku_snapshot: 'BAG-19',
      color_name_snapshot: 'بني',
      quantity: 1,
      unit_price: 190,
      line_total: 190,
    },
  ],
  payments: [{ payment_method: 'cash', amount: 600 }],
  loyalty: [{ direction: 'in', points: 5, reason: 'earned' }],
  shop: {
    name: 'زهران',
    address: 'العنوان — المدينة',
    phone: '01000000000',
    footer_note: 'شكراً لتعاملكم معنا 💖',
    header_note: 'عرض الموسم — خصم 10%',
    qr_url: 'https://pos.turathmasr.com',
    qr_caption: 'امسح لزيارة متجرنا',
    website: 'pos.turathmasr.com',
    terms: '• الاستبدال خلال 14 يوم.\n• المنتج بحالته الأصلية.',
  },
};

export function ReceiptTemplatesTab() {
  const qc = useQueryClient();
  const templatesQ = useQuery({
    queryKey: ['settings', 'shop.receipt_templates'],
    queryFn: () => settingsApi.get('shop.receipt_templates').catch(() => null),
  });
  const activeQ = useQuery({
    queryKey: ['settings', 'shop.receipt_active_template'],
    queryFn: () =>
      settingsApi.get('shop.receipt_active_template').catch(() => null),
  });

  const serverTemplates: ReceiptTemplate[] = useMemo(() => {
    const v = (templatesQ.data?.value as any);
    return Array.isArray(v) && v.length ? v : DEFAULT_TEMPLATES;
  }, [templatesQ.data]);
  const activeId: string =
    (typeof activeQ.data?.value === 'string'
      ? (activeQ.data.value as string)
      : (activeQ.data?.value as any)?.id) || serverTemplates[0]?.id;

  const [templates, setTemplates] = useState<ReceiptTemplate[]>(serverTemplates);
  const [selectedId, setSelectedId] = useState<string>(activeId);
  useEffect(() => {
    setTemplates(serverTemplates);
    if (!templates.some((t) => t.id === selectedId)) {
      setSelectedId(serverTemplates[0]?.id || '');
    }
  }, [serverTemplates]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = templates.find((t) => t.id === selectedId) || templates[0];

  const update = <K extends keyof ReceiptTemplate>(key: K, value: ReceiptTemplate[K]) => {
    setTemplates((arr) =>
      arr.map((t) => (t.id === selectedId ? { ...t, [key]: value } : t)),
    );
  };

  const addTemplate = () => {
    const id = `tpl-${Date.now().toString(36)}`;
    setTemplates((arr) => [
      ...arr,
      { id, name: 'قالب جديد', ...BLANK_TEMPLATE } as ReceiptTemplate,
    ]);
    setSelectedId(id);
  };

  const cloneTemplate = () => {
    if (!selected) return;
    const id = `tpl-${Date.now().toString(36)}`;
    setTemplates((arr) => [
      ...arr,
      { ...selected, id, name: `${selected.name} (نسخة)` },
    ]);
    setSelectedId(id);
  };

  const deleteTemplate = () => {
    if (templates.length <= 1) {
      toast.error('لا يمكن حذف القالب الوحيد');
      return;
    }
    if (!confirm('حذف القالب نهائياً؟')) return;
    const remaining = templates.filter((t) => t.id !== selectedId);
    setTemplates(remaining);
    setSelectedId(remaining[0]?.id || '');
  };

  const save = useMutation({
    mutationFn: async (opts: { setActive?: boolean } = {}) => {
      await settingsApi.upsert({
        key: 'shop.receipt_templates',
        group_name: 'shop',
        is_public: true,
        value: templates as any,
      });
      if (opts.setActive) {
        await settingsApi.upsert({
          key: 'shop.receipt_active_template',
          group_name: 'shop',
          is_public: true,
          value: selectedId as any,
        });
      }
    },
    onSuccess: () => {
      toast.success('تم الحفظ');
      qc.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (e: any) => toast.error(e?.response?.data?.message || 'فشل الحفظ'),
  });

  if (!selected) return <div className="text-slate-500">لا توجد قوالب</div>;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_420px] gap-6">
      {/* ─── Editor ─── */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className="input py-2"
          >
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} {t.id === activeId ? '· ⭐ نشط' : ''}
              </option>
            ))}
          </select>
          <button onClick={addTemplate} className="btn-ghost" title="قالب جديد">
            <Plus size={16} /> قالب جديد
          </button>
          <button onClick={cloneTemplate} className="btn-ghost" title="نسخة">
            <Copy size={16} /> نسخة
          </button>
          <button
            onClick={deleteTemplate}
            className="btn-ghost text-rose-600"
            title="حذف"
          >
            <Trash2 size={16} /> حذف
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Labeled label="اسم القالب">
            <input
              className="input"
              value={selected.name}
              onChange={(e) => update('name', e.target.value)}
            />
          </Labeled>
          <Labeled label="عرض الورقة (مم)">
            <input
              type="number"
              min={40}
              max={300}
              className="input"
              value={selected.paper_width_mm}
              onChange={(e) => update('paper_width_mm', Number(e.target.value))}
            />
          </Labeled>
          <Labeled label="ارتفاع ثابت (مم — اتركه فاضي للطول التلقائي)">
            <input
              type="number"
              min={0}
              className="input"
              value={selected.paper_height_mm ?? 0}
              onChange={(e) =>
                update(
                  'paper_height_mm',
                  Number(e.target.value) || null,
                )
              }
            />
          </Labeled>
          <Labeled label="الحواف (مم)">
            <input
              type="number"
              min={0}
              max={30}
              className="input"
              value={selected.padding_mm}
              onChange={(e) => update('padding_mm', Number(e.target.value))}
            />
          </Labeled>
          <Labeled label="الخط">
            <select
              className="input"
              value={selected.font_family}
              onChange={(e) => update('font_family', e.target.value)}
            >
              {FONT_OPTIONS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </Labeled>
          <Labeled label="حجم الخط (px)">
            <input
              type="number"
              min={8}
              max={24}
              className="input"
              value={selected.font_size_base}
              onChange={(e) => update('font_size_base', Number(e.target.value))}
            />
          </Labeled>
          <Labeled label="حجم العنوان (px)">
            <input
              type="number"
              min={10}
              max={40}
              className="input"
              value={selected.font_size_title}
              onChange={(e) => update('font_size_title', Number(e.target.value))}
            />
          </Labeled>
          <Labeled label="ارتفاع السطر">
            <input
              type="number"
              step={0.05}
              min={1}
              max={2.5}
              className="input"
              value={selected.line_height}
              onChange={(e) => update('line_height', Number(e.target.value))}
            />
          </Labeled>
        </div>

        <fieldset className="border border-slate-200 rounded-lg p-4">
          <legend className="text-sm font-bold text-slate-700 px-2">الألوان</legend>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Color label="النص" value={selected.color_text}
              onChange={(v) => update('color_text', v)} />
            <Color label="الثانوي" value={selected.color_muted}
              onChange={(v) => update('color_muted', v)} />
            <Color label="العناوين" value={selected.color_primary}
              onChange={(v) => update('color_primary', v)} />
            <Color label="الإجمالي" value={selected.color_accent}
              onChange={(v) => update('color_accent', v)} />
            <Color label="الخطوط الفاصلة" value={selected.color_divider}
              onChange={(v) => update('color_divider', v)} />
          </div>
        </fieldset>

        <fieldset className="border border-slate-200 rounded-lg p-4">
          <legend className="text-sm font-bold text-slate-700 px-2">الشعار</legend>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Labeled label="حجم الشعار (مم)">
              <input
                type="number"
                min={8}
                max={80}
                className="input"
                value={selected.logo_size_mm}
                onChange={(e) => update('logo_size_mm', Number(e.target.value))}
              />
            </Labeled>
            <Labeled label="موضع الشعار">
              <select
                className="input"
                value={selected.logo_align}
                onChange={(e) => update('logo_align', e.target.value as any)}
              >
                <option value="right">يمين</option>
                <option value="center">وسط</option>
                <option value="left">يسار</option>
              </select>
            </Labeled>
          </div>
        </fieldset>

        <fieldset className="border border-slate-200 rounded-lg p-4">
          <legend className="text-sm font-bold text-slate-700 px-2">
            الأقسام الظاهرة
          </legend>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            <Toggle label="الشعار" checked={selected.show_logo}
              onChange={(v) => update('show_logo', v)} />
            <Toggle label="رسالة الهيدر" checked={selected.show_header_note}
              onChange={(v) => update('show_header_note', v)} />
            <Toggle label="بيانات العميل" checked={selected.show_customer}
              onChange={(v) => update('show_customer', v)} />
            <Toggle label="البائع" checked={selected.show_salesperson}
              onChange={(v) => update('show_salesperson', v)} />
            <Toggle label="الفرع/المستودع" checked={selected.show_warehouse}
              onChange={(v) => update('show_warehouse', v)} />
            <Toggle label="اللون والمقاس" checked={selected.show_items_variant}
              onChange={(v) => update('show_items_variant', v)} />
            <Toggle label="كود المنتج (SKU)" checked={selected.show_items_sku}
              onChange={(v) => update('show_items_sku', v)} />
            <Toggle label="ربح الفاتورة" checked={selected.show_profit}
              onChange={(v) => update('show_profit', v)} />
            <Toggle label="نقاط الولاء" checked={selected.show_loyalty}
              onChange={(v) => update('show_loyalty', v)} />
            <Toggle label="الشروط والأحكام" checked={selected.show_terms}
              onChange={(v) => update('show_terms', v)} />
            <Toggle label="الباركود" checked={selected.show_barcode}
              onChange={(v) => update('show_barcode', v)} />
            <Toggle label="كود QR" checked={selected.show_qr}
              onChange={(v) => update('show_qr', v)} />
            <Toggle label="الملاحظات" checked={selected.show_notes}
              onChange={(v) => update('show_notes', v)} />
            <Toggle label="ختم الطباعة" checked={selected.show_print_stamp}
              onChange={(v) => update('show_print_stamp', v)} />
            <Toggle label="إطار حول الإجمالي" checked={selected.grand_total_boxed}
              onChange={(v) => update('grand_total_boxed', v)} />
            <Toggle label="خطوط فاصلة منقطة" checked={selected.dashed_divider}
              onChange={(v) => update('dashed_divider', v)} />
          </div>
        </fieldset>

        <div className="flex gap-2 pt-2 flex-wrap">
          <button
            onClick={() => save.mutate({})}
            disabled={save.isPending}
            className="inline-flex items-center gap-2 bg-indigo-600 text-white px-5 py-2.5 rounded-lg font-bold hover:bg-indigo-700 disabled:opacity-50"
          >
            <Save size={16} /> حفظ
          </button>
          <button
            onClick={() => save.mutate({ setActive: true })}
            disabled={save.isPending}
            className="inline-flex items-center gap-2 bg-emerald-600 text-white px-5 py-2.5 rounded-lg font-bold hover:bg-emerald-700 disabled:opacity-50"
            title="حفظ واستخدام هذا القالب لكل الفواتير القادمة"
          >
            <Check size={16} /> حفظ وتعيين كقالب نشط
          </button>
        </div>
      </div>

      {/* ─── Live preview ─── */}
      <div className="lg:sticky lg:top-4 self-start">
        <div className="text-sm font-bold text-slate-700 mb-2">معاينة مباشرة</div>
        <div className="bg-slate-100 rounded-xl p-4 overflow-auto max-h-[85vh]">
          <div className="bg-white shadow-xl inline-block mx-auto">
            <Receipt data={SAMPLE} template={selected} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── small UI helpers ─── */
function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-xs font-semibold text-slate-600 mb-1">{label}</div>
      {children}
    </label>
  );
}
function Color({
  label, value, onChange,
}: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <div className="text-xs font-semibold text-slate-600 mb-1">{label}</div>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-10 h-9 rounded border border-slate-300 cursor-pointer"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="input flex-1 font-mono text-xs"
        />
      </div>
    </label>
  );
}
function Toggle({
  label, checked, onChange,
}: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="w-4 h-4 text-indigo-600 rounded"
      />
      <span className="text-slate-700">{label}</span>
    </label>
  );
}
