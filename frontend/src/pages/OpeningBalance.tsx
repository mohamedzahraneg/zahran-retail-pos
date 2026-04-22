import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { useNavigate } from 'react-router-dom';
import {
  Banknote,
  Users,
  Truck,
  Package,
  Box,
  PiggyBank,
  ArrowLeft,
  CheckCircle2,
} from 'lucide-react';

import { accountsApi } from '@/api/accounts.api';
import { cashDeskApi } from '@/api/cash-desk.api';

const EGP = (n: number | string) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

/**
 * One-screen onboarding for a fresh install — enter every opening
 * balance at once and the backend composes a single balanced journal
 * entry, creates a cashbox opening deposit, and sets the cashbox
 * current_balance. After submission the user's books are ready for
 * normal operations.
 */
export default function OpeningBalance() {
  const nav = useNavigate();
  const today = new Date().toISOString().slice(0, 10);

  const [form, setForm] = useState({
    entry_date: today,
    cash_in_hand: 0,
    customer_dues: 0,
    supplier_dues: 0,
    inventory_value: 0,
    fixed_assets: 0,
    capital: '' as string | number, // '' = auto-plug
    cashbox_id: '',
    notes: '',
  });

  const { data: cashboxes = [] } = useQuery({
    queryKey: ['cashboxes'],
    queryFn: () => cashDeskApi.cashboxes(),
  });

  const { data: accounts = [] } = useQuery({
    queryKey: ['coa', false],
    queryFn: () => accountsApi.list(false),
  });

  // Check if opening balance was already posted.
  const { data: journals = [] } = useQuery({
    queryKey: ['journal', 'opening'],
    queryFn: () =>
      accountsApi.listJournal({
        reference_type: 'opening_balance',
        limit: 1,
      }),
  });
  const alreadyPosted = journals.length > 0 && !journals[0].is_void;

  const totals = useMemo(() => {
    const num = (v: any) => Number(v || 0);
    const debit =
      num(form.cash_in_hand) +
      num(form.customer_dues) +
      num(form.inventory_value) +
      num(form.fixed_assets);
    const explicit = form.capital !== '' ? num(form.capital) : null;
    const plug =
      explicit != null ? explicit : debit - num(form.supplier_dues);
    const credit = num(form.supplier_dues) + plug;
    return {
      debit,
      credit,
      plug,
      balanced: Math.abs(debit - credit) < 0.01,
    };
  }, [form]);

  const mutation = useMutation({
    mutationFn: () =>
      accountsApi.postOpeningBalance({
        entry_date: form.entry_date,
        cash_in_hand: Number(form.cash_in_hand) || 0,
        customer_dues: Number(form.customer_dues) || 0,
        supplier_dues: Number(form.supplier_dues) || 0,
        inventory_value: Number(form.inventory_value) || 0,
        fixed_assets: Number(form.fixed_assets) || 0,
        capital: form.capital !== '' ? Number(form.capital) : undefined,
        cashbox_id: form.cashbox_id || undefined,
        notes: form.notes || undefined,
      }),
    onSuccess: (r) => {
      toast.success(
        `تم تسجيل الرصيد الافتتاحي بنجاح\nرأس المال/الرصيد المرحّل: ${EGP(r.plug_to_capital)}`,
        { duration: 8000 },
      );
      setTimeout(() => nav('/accounts'), 1500);
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل تسجيل القيد'),
  });

  if (alreadyPosted) {
    return (
      <div className="max-w-xl mx-auto mt-10">
        <div className="card p-8 border-2 border-emerald-200 bg-emerald-50 text-center">
          <CheckCircle2
            size={48}
            className="mx-auto text-emerald-600 mb-3"
          />
          <div className="font-black text-xl mb-2">
            تم تسجيل الرصيد الافتتاحي مسبقاً
          </div>
          <div className="text-sm text-slate-600 mb-4">
            رقم القيد:{' '}
            <span className="font-mono font-bold">
              {journals[0].entry_no}
            </span>{' '}
            بتاريخ {journals[0].entry_date}
          </div>
          <div className="text-xs text-slate-500 mb-6">
            إذا أردت تسجيل رصيد افتتاحي جديد، قم بإلغاء القيد الحالي من
            شاشة القيود اليومية أولاً، أو استخدم "إعادة تهيئة المصنع"
            لبدء النظام من جديد.
          </div>
          <button className="btn-primary" onClick={() => nav('/accounts')}>
            <ArrowLeft size={14} /> الذهاب إلى الحسابات
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <div>
        <h2 className="text-2xl font-black text-slate-800 flex items-center gap-2">
          <PiggyBank className="text-brand-600" /> فتح الحسابات — الرصيد
          الافتتاحي
        </h2>
        <p className="text-sm text-slate-500 mt-1">
          سجّل أرصدة البداية دفعة واحدة. النظام يُنشئ قيداً متوازناً تلقائياً
          ويحدّث رصيد الخزنة.
        </p>
      </div>

      <div className="card p-5 space-y-5">
        <div className="grid md:grid-cols-2 gap-3">
          <Field label="تاريخ الرصيد الافتتاحي">
            <input
              type="date"
              className="input"
              value={form.entry_date}
              onChange={(e) =>
                setForm({ ...form, entry_date: e.target.value })
              }
            />
          </Field>
          <Field label="الخزنة (للنقدية)">
            <select
              className="input"
              value={form.cashbox_id}
              onChange={(e) =>
                setForm({ ...form, cashbox_id: e.target.value })
              }
            >
              <option value="">— تلقائي (أول خزنة نشطة) —</option>
              {cashboxes.map((c: any) => (
                <option key={c.id} value={c.id}>
                  {c.name_ar || c.name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="border border-slate-200 rounded-lg p-4 bg-slate-50/50">
          <div className="font-bold text-sm text-emerald-700 mb-3">
            الأصول (تدخل مديناً)
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            <MoneyField
              icon={<Banknote size={14} />}
              label="نقدية في الخزنة (1111)"
              value={form.cash_in_hand}
              onChange={(v) => setForm({ ...form, cash_in_hand: v })}
              hint="الرصيد النقدي الموجود فعلاً يوم البدء"
            />
            <MoneyField
              icon={<Users size={14} />}
              label="ذمم العملاء المدينة (1121)"
              value={form.customer_dues}
              onChange={(v) => setForm({ ...form, customer_dues: v })}
              hint="إجمالي ما على العملاء من حسابات سابقة"
            />
            <MoneyField
              icon={<Package size={14} />}
              label="قيمة المخزون الافتتاحي (1131)"
              value={form.inventory_value}
              onChange={(v) => setForm({ ...form, inventory_value: v })}
              hint="بسعر التكلفة، ليس البيع"
            />
            <MoneyField
              icon={<Box size={14} />}
              label="الأصول الثابتة (121)"
              value={form.fixed_assets}
              onChange={(v) => setForm({ ...form, fixed_assets: v })}
              hint="معدات/أثاث/أجهزة بقيمتها الدفترية"
            />
          </div>
        </div>

        <div className="border border-slate-200 rounded-lg p-4 bg-slate-50/50">
          <div className="font-bold text-sm text-rose-700 mb-3">
            الخصوم + حقوق الملكية (تدخل دائنة)
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            <MoneyField
              icon={<Truck size={14} />}
              label="ذمم الموردين (211)"
              value={form.supplier_dues}
              onChange={(v) => setForm({ ...form, supplier_dues: v })}
              hint="إجمالي ما عليك للموردين من حسابات سابقة"
            />
            <MoneyField
              icon={<PiggyBank size={14} />}
              label="رأس المال / الرصيد المرحَّل (31)"
              value={form.capital}
              onChange={(v) => setForm({ ...form, capital: v })}
              hint="اتركه فارغاً ليحسبه النظام تلقائياً (ضبط)"
              placeholder="تلقائي"
            />
          </div>
        </div>

        {/* Live balance summary */}
        <div
          className={`card p-4 border-2 ${
            totals.balanced
              ? 'border-emerald-300 bg-emerald-50'
              : 'border-rose-300 bg-rose-50'
          }`}
        >
          <div className="grid grid-cols-3 gap-3 text-center text-sm">
            <div>
              <div className="text-xs text-slate-500">إجمالي المدين</div>
              <div className="font-mono font-black text-lg text-emerald-700">
                {EGP(totals.debit)}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">إجمالي الدائن</div>
              <div className="font-mono font-black text-lg text-rose-700">
                {EGP(totals.credit)}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">
                {form.capital === '' ? 'رأس المال (مُحسوب)' : 'الحالة'}
              </div>
              <div
                className={`font-mono font-black text-lg ${
                  totals.balanced ? 'text-indigo-700' : 'text-rose-700'
                }`}
              >
                {form.capital === '' ? EGP(totals.plug) : '—'}
              </div>
            </div>
          </div>
          <div className="text-center text-xs mt-2">
            {totals.balanced ? (
              <span className="text-emerald-700 font-bold">
                ✓ القيد متوازن
              </span>
            ) : (
              <span className="text-rose-700 font-bold">
                ⚠ غير متوازن — فرق {EGP(Math.abs(totals.debit - totals.credit))}
              </span>
            )}
          </div>
        </div>

        <Field label="ملاحظات">
          <textarea
            className="input"
            rows={2}
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            placeholder="اختياري — أي ملاحظات للتوثيق"
          />
        </Field>

        <div className="flex gap-2 pt-2 border-t border-slate-100">
          <button
            className="btn-primary flex-1"
            disabled={
              mutation.isPending || !totals.balanced || totals.debit < 0.01
            }
            onClick={() => {
              if (
                confirm(
                  `سيتم ترحيل قيد افتتاحي بإجمالي ${EGP(totals.debit)} — متابعة؟`,
                )
              ) {
                mutation.mutate();
              }
            }}
          >
            {mutation.isPending
              ? '⏳ جارٍ الترحيل...'
              : '🎯 ترحيل الرصيد الافتتاحي'}
          </button>
          <button className="btn-secondary" onClick={() => nav('/accounts')}>
            إلغاء
          </button>
        </div>

        <div className="text-xs text-slate-500 leading-relaxed border-t border-slate-100 pt-3">
          <b>كيف يعمل:</b> القيد المزدوج تلقائياً — الأصول تدخل على المدين،
          الموردون على الدائن، والفرق يذهب تلقائياً لحساب رأس المال/الأرباح
          المحتجزة (3). النقدية تُضاف فوراً للخزنة المختارة وتُسجَّل حركة
          "رصيد افتتاحي" في كشف الخزنة.
        </div>
      </div>

      <div className="text-xs text-slate-400 text-center">
        هذه الشاشة تُستخدم مرة واحدة عند بدء التشغيل. بعد الترحيل تبدأ
        عملياتك الفعلية (فواتير / مصروفات / دفعات) وكل شيء يتحدّث تلقائياً.
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs font-bold text-slate-600 mb-1 block">
        {label}
      </span>
      {children}
    </label>
  );
}

function MoneyField({
  icon,
  label,
  value,
  onChange,
  hint,
  placeholder,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  onChange: (v: any) => void;
  hint?: string;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs font-bold text-slate-600 mb-1 flex items-center gap-1">
        {icon} {label}
      </span>
      <input
        type="number"
        step="0.01"
        min={0}
        className="input"
        value={value === '' ? '' : String(value)}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === '' ? '' : Number(v));
        }}
        placeholder={placeholder || '0.00'}
      />
      {hint && (
        <span className="text-[10px] text-slate-400 mt-0.5 block">{hint}</span>
      )}
    </label>
  );
}
