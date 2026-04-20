import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Plus, Search, Phone, Mail, Award, X, ArrowUpDown } from 'lucide-react';
import { customersApi } from '@/api/customers.api';

const EGP = (n: number) => `${Number(n).toFixed(0)} EGP`;

const TIER_COLORS: Record<string, string> = {
  bronze: 'bg-amber-100 text-amber-800',
  silver: 'bg-slate-200 text-slate-700',
  gold: 'bg-yellow-100 text-yellow-800',
  platinum: 'bg-purple-100 text-purple-800',
};

const TIER_LABELS: Record<string, string> = {
  bronze: 'برونزي',
  silver: 'فضي',
  gold: 'ذهبي',
  platinum: 'بلاتيني',
};

type CustomerSort =
  | 'name'
  | 'points_desc'
  | 'points_asc'
  | 'balance_desc'
  | 'balance_asc'
  | 'created_desc';

export default function Customers() {
  const [q, setQ] = useState('');
  const [tier, setTier] = useState<string>('');
  const [sort, setSort] = useState<CustomerSort>('created_desc');
  const [showCreate, setShowCreate] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['customers', q],
    queryFn: () => customersApi.list({ q: q || undefined, limit: 200 }),
  });

  const customers = useMemo(() => {
    let list = (data?.data || []).slice();
    if (tier) list = list.filter((c) => c.loyalty_tier === tier);
    list.sort((a, b) => {
      switch (sort) {
        case 'name':
          return String(a.full_name || '').localeCompare(
            String(b.full_name || ''),
            'ar',
          );
        case 'points_desc':
          return Number(b.loyalty_points || 0) - Number(a.loyalty_points || 0);
        case 'points_asc':
          return Number(a.loyalty_points || 0) - Number(b.loyalty_points || 0);
        case 'balance_desc':
          return Number(b.current_balance || 0) - Number(a.current_balance || 0);
        case 'balance_asc':
          return Number(a.current_balance || 0) - Number(b.current_balance || 0);
        default:
          return (
            Date.parse(String((b as any).created_at || 0)) -
            Date.parse(String((a as any).created_at || 0))
          );
      }
    });
    return list;
  }, [data?.data, tier, sort]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-black text-slate-800">العملاء</h2>
        <button className="btn-primary" onClick={() => setShowCreate(true)}>
          <Plus size={18} /> إضافة عميل
        </button>
      </div>

      <div className="card p-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search
            size={16}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <input
            className="input pr-9"
            placeholder="ابحث بالاسم أو رقم العميل..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <select
          className="input max-w-[140px]"
          value={tier}
          onChange={(e) => setTier(e.target.value)}
          title="فلتر حسب التصنيف"
        >
          <option value="">كل التصنيفات</option>
          <option value="bronze">برونزي</option>
          <option value="silver">فضي</option>
          <option value="gold">ذهبي</option>
          <option value="platinum">بلاتيني</option>
        </select>
        <select
          className="input max-w-[180px]"
          value={sort}
          onChange={(e) => setSort(e.target.value as CustomerSort)}
          title="ترتيب"
        >
          <option value="created_desc">الأحدث أولاً</option>
          <option value="name">الاسم (أ-ي)</option>
          <option value="points_desc">النقاط الأعلى</option>
          <option value="points_asc">النقاط الأقل</option>
          <option value="balance_desc">الرصيد الأعلى</option>
          <option value="balance_asc">الرصيد الأقل</option>
        </select>
        <div className="text-xs text-slate-500">
          المعروض: <b className="text-slate-800">{customers.length}</b>
        </div>
      </div>

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
        {isLoading && (
          <div className="col-span-full text-center py-12 text-slate-400">
            جارٍ التحميل...
          </div>
        )}
        {customers.map((c) => (
          <div key={c.id} className="card p-4 hover:shadow-glow transition">
            <div className="flex items-start justify-between mb-3">
              <div>
                <div className="font-black text-slate-800">{c.full_name}</div>
                <div className="text-xs text-slate-500 font-mono">{c.code}</div>
              </div>
              <span className={`chip ${TIER_COLORS[c.loyalty_tier] || ''}`}>
                <Award size={12} /> {TIER_LABELS[c.loyalty_tier]}
              </span>
            </div>

            {c.phone && (
              <div className="flex items-center gap-2 text-sm text-slate-600 mb-1">
                <Phone size={14} />
                <span dir="ltr">{c.phone}</span>
              </div>
            )}
            {c.email && (
              <div className="flex items-center gap-2 text-sm text-slate-600 mb-3">
                <Mail size={14} />
                <span className="truncate">{c.email}</span>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2 pt-3 border-t border-slate-100">
              <div>
                <div className="text-xs text-slate-500">النقاط</div>
                <div className="font-bold text-brand-600">{c.loyalty_points}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">الرصيد</div>
                <div
                  className={`font-bold ${
                    Number(c.current_balance) > 0 ? 'text-rose-600' : 'text-emerald-600'
                  }`}
                >
                  {EGP(c.current_balance)}
                </div>
              </div>
            </div>
          </div>
        ))}

        {!isLoading && !customers.length && (
          <div className="col-span-full text-center py-12 text-slate-400">
            لا توجد بيانات عملاء
          </div>
        )}
      </div>

      {showCreate && (
        <CreateCustomerModal
          onClose={() => setShowCreate(false)}
          onSuccess={() => setShowCreate(false)}
        />
      )}
    </div>
  );
}

function CreateCustomerModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    code: '',
    full_name: '',
    phone: '',
    email: '',
    loyalty_tier: 'bronze' as 'bronze' | 'silver' | 'gold' | 'platinum',
    credit_limit: '',
    notes: '',
  });

  const mutation = useMutation({
    mutationFn: customersApi.create,
    onSuccess: () => {
      toast.success('تم إضافة العميل');
      qc.invalidateQueries({ queryKey: ['customers'] });
      onSuccess();
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.message || 'فشل حفظ العميل';
      toast.error(Array.isArray(msg) ? msg[0] : String(msg));
    },
  });

  const submit = () => {
    if (!form.code.trim() || !form.full_name.trim()) {
      toast.error('الكود والاسم مطلوبان');
      return;
    }
    const limit = form.credit_limit ? Number(form.credit_limit) : undefined;
    if (limit !== undefined && (isNaN(limit) || limit < 0)) {
      toast.error('حد الائتمان يجب أن يكون رقماً صالحاً');
      return;
    }
    mutation.mutate({
      code: form.code.trim(),
      full_name: form.full_name.trim(),
      phone: form.phone.trim() || undefined,
      email: form.email.trim() || undefined,
      loyalty_tier: form.loyalty_tier,
      credit_limit: limit,
      notes: form.notes.trim() || undefined,
    } as any);
  };

  return (
    <Modal title="إضافة عميل جديد" onClose={onClose}>
      <div className="space-y-3">
        <div className="grid md:grid-cols-2 gap-3">
          <Field label="الكود *">
            <input
              className="input"
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
              placeholder="CUS-001"
            />
          </Field>
          <Field label="المستوى">
            <select
              className="input"
              value={form.loyalty_tier}
              onChange={(e) =>
                setForm({ ...form, loyalty_tier: e.target.value as any })
              }
            >
              <option value="bronze">برونزي</option>
              <option value="silver">فضي</option>
              <option value="gold">ذهبي</option>
              <option value="platinum">بلاتيني</option>
            </select>
          </Field>
        </div>
        <Field label="الاسم الكامل *">
          <input
            className="input"
            value={form.full_name}
            onChange={(e) => setForm({ ...form, full_name: e.target.value })}
            placeholder="مي محمد"
          />
        </Field>
        <div className="grid md:grid-cols-2 gap-3">
          <Field label="الهاتف">
            <input
              className="input"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              placeholder="01012345678"
              dir="ltr"
            />
          </Field>
          <Field label="البريد">
            <input
              className="input"
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              placeholder="name@example.com"
              dir="ltr"
            />
          </Field>
        </div>
        <Field label="حد الائتمان">
          <input
            type="number"
            min={0}
            step="0.01"
            className="input"
            value={form.credit_limit}
            onChange={(e) => setForm({ ...form, credit_limit: e.target.value })}
            placeholder="0"
          />
        </Field>
        <Field label="ملاحظات">
          <textarea
            className="input min-h-[70px]"
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
          />
        </Field>
        <div className="flex items-center justify-end gap-2 pt-4">
          <button className="btn-ghost" onClick={onClose}>
            إلغاء
          </button>
          <button
            className="btn-primary"
            onClick={submit}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? 'جاري الحفظ...' : 'حفظ'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-slate-100 sticky top-0 bg-white z-10">
          <h3 className="font-black text-lg text-slate-800">{title}</h3>
          <button onClick={onClose} className="p-1 hover:bg-slate-100 rounded">
            <X size={20} />
          </button>
        </div>
        <div className="p-5">{children}</div>
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
