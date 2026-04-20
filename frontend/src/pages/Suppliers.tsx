import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Truck,
  Plus,
  Search,
  Phone,
  Mail,
  MapPin,
  X,
  AlertTriangle,
  FileText,
  CreditCard,
  Pencil,
  Trash2,
} from 'lucide-react';
import { suppliersApi, Supplier, SupplierOutstanding } from '@/api/suppliers.api';
import { cashDeskApi } from '@/api/cash-desk.api';

const EGP = (n: number | string) =>
  `${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م`;

export default function Suppliers() {
  const [q, setQ] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState<Supplier | null>(null);
  const [payTarget, setPayTarget] = useState<Supplier | null>(null);
  const [editTarget, setEditTarget] = useState<Supplier | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Supplier | null>(null);
  const qc = useQueryClient();

  const deleteMutation = useMutation({
    mutationFn: (id: string) => suppliersApi.remove(id),
    onSuccess: () => {
      toast.success('تم حذف المورد');
      qc.invalidateQueries({ queryKey: ['suppliers'] });
      qc.invalidateQueries({ queryKey: ['suppliers-outstanding'] });
      setDeleteTarget(null);
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.message || 'فشل الحذف';
      toast.error(Array.isArray(msg) ? msg[0] : String(msg));
    },
  });

  const { data: suppliers = [], isLoading } = useQuery({
    queryKey: ['suppliers', q],
    queryFn: () => suppliersApi.list(q || undefined),
  });

  const { data: outstanding = [] } = useQuery({
    queryKey: ['suppliers-outstanding'],
    queryFn: suppliersApi.outstanding,
  });

  const outstandingMap = useMemo(() => {
    const m: Record<string, SupplierOutstanding> = {};
    for (const o of outstanding) m[o.id] = o;
    return m;
  }, [outstanding]);

  const totals = useMemo(() => {
    const due = outstanding.reduce((s, o) => s + Number(o.current_balance || 0), 0);
    const overdue = outstanding.reduce(
      (s, o) => s + Number(o.overdue_amount || 0),
      0,
    );
    return { due, overdue, count: outstanding.length };
  }, [outstanding]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-black text-slate-800 flex items-center gap-2">
            <Truck className="text-brand-600" /> الموردون
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            إدارة الموردين ومستحقاتهم
          </p>
        </div>
        <button className="btn-primary" onClick={() => setShowCreate(true)}>
          <Plus size={18} /> إضافة مورد
        </button>
      </div>

      {/* KPIs */}
      <div className="grid md:grid-cols-3 gap-4">
        <Kpi
          title="إجمالي المستحقات"
          value={EGP(totals.due)}
          color="bg-amber-50"
          icon={<CreditCard className="text-amber-600" />}
        />
        <Kpi
          title="مستحقات متأخرة"
          value={EGP(totals.overdue)}
          color="bg-rose-50"
          icon={<AlertTriangle className="text-rose-600" />}
        />
        <Kpi
          title="موردون لهم مستحقات"
          value={String(totals.count)}
          color="bg-brand-50"
          icon={<Truck className="text-brand-600" />}
        />
      </div>

      {/* Search */}
      <div className="card p-4">
        <div className="relative">
          <Search
            size={16}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <input
            className="input pr-9"
            placeholder="ابحث باسم المورد أو الكود..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>

      {/* Grid */}
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
        {isLoading && (
          <div className="col-span-full text-center py-12 text-slate-400">
            جارٍ التحميل...
          </div>
        )}
        {suppliers.map((s) => {
          const o = outstandingMap[s.id];
          const due = Number(o?.current_balance || s.current_balance || 0);
          return (
            <div
              key={s.id}
              className="card p-4 hover:shadow-glow transition cursor-pointer"
              onClick={() => setSelected(s)}
            >
              <div className="flex items-start justify-between mb-3 gap-2">
                <div className="min-w-0 flex-1">
                  <div className="font-black text-slate-800 truncate">{s.name}</div>
                  <div className="text-xs text-slate-500 font-mono">{s.code}</div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {due > 0 && (
                    <span className="chip bg-rose-100 text-rose-700">
                      مدين {EGP(due)}
                    </span>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditTarget(s);
                    }}
                    className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-brand-600"
                    title="تعديل"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteTarget(s);
                    }}
                    className="p-1.5 rounded-lg hover:bg-rose-50 text-slate-500 hover:text-rose-600"
                    title="حذف"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              {s.phone && (
                <div className="flex items-center gap-2 text-sm text-slate-600 mb-1">
                  <Phone size={14} />
                  <span dir="ltr">{s.phone}</span>
                </div>
              )}
              {s.email && (
                <div className="flex items-center gap-2 text-sm text-slate-600 mb-1">
                  <Mail size={14} />
                  <span className="truncate">{s.email}</span>
                </div>
              )}
              {s.address && (
                <div className="flex items-center gap-2 text-sm text-slate-600 mb-1">
                  <MapPin size={14} />
                  <span className="truncate">{s.address}</span>
                </div>
              )}

              <div className="flex gap-2 mt-3 pt-3 border-t border-slate-100">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelected(s);
                  }}
                  className="flex-1 text-xs py-1.5 bg-slate-100 rounded-lg hover:bg-slate-200 font-bold flex items-center justify-center gap-1"
                >
                  <FileText size={12} /> كشف حساب
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setPayTarget(s);
                  }}
                  className="flex-1 text-xs py-1.5 bg-emerald-100 text-emerald-700 rounded-lg hover:bg-emerald-200 font-bold flex items-center justify-center gap-1"
                >
                  <CreditCard size={12} /> دفعة
                </button>
              </div>
            </div>
          );
        })}

        {!isLoading && !suppliers.length && (
          <div className="col-span-full text-center py-12 text-slate-400">
            لا توجد بيانات موردين
          </div>
        )}
      </div>

      {showCreate && (
        <CreateSupplierModal
          onClose={() => setShowCreate(false)}
          onSuccess={() => {
            setShowCreate(false);
            qc.invalidateQueries({ queryKey: ['suppliers'] });
          }}
        />
      )}

      {selected && (
        <LedgerModal supplier={selected} onClose={() => setSelected(null)} />
      )}

      {payTarget && (
        <QuickPayModal
          supplier={payTarget}
          onClose={() => setPayTarget(null)}
          onSuccess={() => {
            setPayTarget(null);
            qc.invalidateQueries({ queryKey: ['suppliers-outstanding'] });
            qc.invalidateQueries({ queryKey: ['supplier-payments'] });
          }}
        />
      )}

      {editTarget && (
        <EditSupplierModal
          supplier={editTarget}
          onClose={() => setEditTarget(null)}
          onSuccess={() => {
            setEditTarget(null);
            qc.invalidateQueries({ queryKey: ['suppliers'] });
          }}
        />
      )}

      {deleteTarget && (
        <ConfirmDeleteModal
          supplier={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => deleteMutation.mutate(deleteTarget.id)}
          isPending={deleteMutation.isPending}
        />
      )}
    </div>
  );
}

function EditSupplierModal({
  supplier,
  onClose,
  onSuccess,
}: {
  supplier: Supplier;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [form, setForm] = useState({
    code: supplier.code || '',
    name: supplier.name || '',
    phone: supplier.phone || '',
    email: supplier.email || '',
    address: supplier.address || '',
  });
  const mutation = useMutation({
    mutationFn: (body: Partial<Supplier>) =>
      suppliersApi.update(supplier.id, body),
    onSuccess: () => {
      toast.success('تم تحديث المورد');
      onSuccess();
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.message || 'فشل التحديث';
      toast.error(Array.isArray(msg) ? msg[0] : String(msg));
    },
  });

  return (
    <Modal title={`تعديل المورد: ${supplier.name}`} onClose={onClose}>
      <div className="space-y-3">
        <div className="grid md:grid-cols-2 gap-3">
          <Field label="الكود *">
            <input
              className="input"
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
            />
          </Field>
          <Field label="الاسم *">
            <input
              className="input"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
        </div>
        <div className="grid md:grid-cols-2 gap-3">
          <Field label="الهاتف">
            <input
              className="input"
              dir="ltr"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          </Field>
          <Field label="البريد الإلكتروني">
            <input
              className="input"
              type="email"
              dir="ltr"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </Field>
        </div>
        <Field label="العنوان">
          <textarea
            rows={2}
            className="input"
            value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
          />
        </Field>
        <div className="flex gap-2 pt-2">
          <button
            className="btn-primary flex-1"
            onClick={() => {
              if (!form.code || !form.name)
                return toast.error('الكود والاسم مطلوبان');
              mutation.mutate(form);
            }}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? 'جاري الحفظ...' : 'حفظ التعديلات'}
          </button>
          <button className="btn-secondary" onClick={onClose}>
            إلغاء
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ConfirmDeleteModal({
  supplier,
  onClose,
  onConfirm,
  isPending,
}: {
  supplier: Supplier;
  onClose: () => void;
  onConfirm: () => void;
  isPending: boolean;
}) {
  return (
    <Modal title="تأكيد الحذف" onClose={onClose}>
      <div className="space-y-4">
        <div className="flex items-start gap-3 p-3 rounded-lg bg-rose-50 border border-rose-200">
          <AlertTriangle className="text-rose-600 flex-shrink-0 mt-0.5" size={20} />
          <div className="text-sm text-slate-700">
            هل أنت متأكد من حذف المورد <b>{supplier.name}</b>؟
            <br />
            <span className="text-xs text-slate-500">
              سيتم أرشفة المورد. لا يمكن الحذف إذا كان عليه رصيد مستحق.
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            className="flex-1 py-2 rounded-lg bg-rose-600 text-white font-bold hover:bg-rose-700 disabled:opacity-50"
            onClick={onConfirm}
            disabled={isPending}
          >
            <Trash2 size={16} className="inline -mt-1 ml-1" />
            {isPending ? 'جاري الحذف...' : 'تأكيد الحذف'}
          </button>
          <button className="btn-secondary" onClick={onClose}>
            إلغاء
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Kpi({
  title,
  value,
  color,
  icon,
}: {
  title: string;
  value: string;
  color: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="card p-5 flex items-center gap-4">
      <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${color}`}>
        {icon}
      </div>
      <div>
        <div className="text-xs text-slate-500">{title}</div>
        <div className="font-black text-2xl text-slate-800">{value}</div>
      </div>
    </div>
  );
}

function Modal({
  title,
  onClose,
  children,
  size = 'md',
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  size?: 'md' | 'lg';
}) {
  const w = size === 'lg' ? 'max-w-3xl' : 'max-w-xl';
  return (
    <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-center justify-center p-4">
      <div className={`bg-white rounded-2xl w-full ${w} max-h-[90vh] overflow-y-auto`}>
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

function CreateSupplierModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [form, setForm] = useState({
    code: '',
    name: '',
    phone: '',
    email: '',
    address: '',
  });
  const mutation = useMutation({
    mutationFn: suppliersApi.create,
    onSuccess: () => {
      toast.success('تم إضافة المورد');
      onSuccess();
    },
  });

  return (
    <Modal title="إضافة مورد جديد" onClose={onClose}>
      <div className="space-y-3">
        <div className="grid md:grid-cols-2 gap-3">
          <Field label="الكود *">
            <input
              className="input"
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
              placeholder="SUP-001"
            />
          </Field>
          <Field label="الاسم *">
            <input
              className="input"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
        </div>
        <div className="grid md:grid-cols-2 gap-3">
          <Field label="الهاتف">
            <input
              className="input"
              dir="ltr"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          </Field>
          <Field label="البريد الإلكتروني">
            <input
              className="input"
              type="email"
              dir="ltr"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </Field>
        </div>
        <Field label="العنوان">
          <textarea
            rows={2}
            className="input"
            value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
          />
        </Field>

        <div className="flex gap-2 pt-2">
          <button
            className="btn-primary flex-1"
            onClick={() => {
              if (!form.code || !form.name) return toast.error('الكود والاسم مطلوبان');
              mutation.mutate(form);
            }}
            disabled={mutation.isPending}
          >
            <Plus size={18} /> حفظ
          </button>
          <button className="btn-secondary" onClick={onClose}>
            إلغاء
          </button>
        </div>
      </div>
    </Modal>
  );
}

function LedgerModal({
  supplier,
  onClose,
}: {
  supplier: Supplier;
  onClose: () => void;
}) {
  const { data: entries = [], isLoading } = useQuery({
    queryKey: ['supplier-ledger', supplier.id],
    queryFn: () => suppliersApi.ledger(supplier.id),
  });

  return (
    <Modal title={`كشف حساب: ${supplier.name}`} onClose={onClose} size="lg">
      {isLoading ? (
        <div className="text-center py-8 text-slate-400">جارٍ التحميل...</div>
      ) : entries.length === 0 ? (
        <div className="text-center py-8 text-slate-400">لا توجد حركات</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-xs font-bold">
              <tr>
                <th className="text-right px-3 py-2">التاريخ</th>
                <th className="text-right px-3 py-2">البيان</th>
                <th className="text-right px-3 py-2">مدين</th>
                <th className="text-right px-3 py-2">دائن</th>
                <th className="text-right px-3 py-2">الرصيد</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e: any, idx: number) => (
                <tr key={idx} className="border-t border-slate-100">
                  <td className="px-3 py-2 text-xs text-slate-500">
                    {new Date(e.entry_date).toLocaleDateString('en-US')}
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-bold">{e.description || e.doc_type}</div>
                    <div className="text-xs text-slate-400 font-mono">{e.doc_no}</div>
                  </td>
                  <td className="px-3 py-2 text-rose-600 font-bold">
                    {Number(e.debit) ? EGP(e.debit) : '—'}
                  </td>
                  <td className="px-3 py-2 text-emerald-600 font-bold">
                    {Number(e.credit) ? EGP(e.credit) : '—'}
                  </td>
                  <td className="px-3 py-2 font-bold">{EGP(e.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

function QuickPayModal({
  supplier,
  onClose,
  onSuccess,
}: {
  supplier: Supplier;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<
    'cash' | 'card' | 'instapay' | 'bank_transfer'
  >('cash');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');

  const { data: cashboxes = [] } = useQuery({
    queryKey: ['cashboxes'],
    queryFn: cashDeskApi.cashboxes,
  });
  const [cashboxId, setCashboxId] = useState('');

  const mutation = useMutation({
    mutationFn: cashDeskApi.pay,
    onSuccess: () => {
      toast.success('تم حفظ الدفعة');
      onSuccess();
    },
  });

  const cbId = cashboxId || cashboxes[0]?.id;

  return (
    <Modal title={`دفعة للمورد: ${supplier.name}`} onClose={onClose}>
      <div className="space-y-3">
        <div className="grid md:grid-cols-2 gap-3">
          <Field label="الخزينة">
            <select
              className="input"
              value={cbId || ''}
              onChange={(e) => setCashboxId(e.target.value)}
            >
              <option value="">-- اختر --</option>
              {cashboxes.map((cb) => (
                <option key={cb.id} value={cb.id}>
                  {cb.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="طريقة الدفع">
            <select
              className="input"
              value={method}
              onChange={(e) => setMethod(e.target.value as any)}
            >
              <option value="cash">نقدي</option>
              <option value="card">بطاقة</option>
              <option value="instapay">إنستا باي</option>
              <option value="bank_transfer">تحويل بنكي</option>
            </select>
          </Field>
        </div>
        <div className="grid md:grid-cols-2 gap-3">
          <Field label="المبلغ">
            <input
              type="number"
              step="0.01"
              className="input"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
            />
          </Field>
          <Field label="المرجع">
            <input
              className="input"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </Field>
        </div>
        <Field label="ملاحظات">
          <textarea
            rows={2}
            className="input"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>

        <div className="flex gap-2 pt-2">
          <button
            className="btn-primary flex-1"
            disabled={mutation.isPending}
            onClick={() => {
              if (!cbId) return toast.error('اختر الخزينة');
              const amt = Number(amount);
              if (!amt || amt <= 0) return toast.error('أدخل مبلغاً');
              mutation.mutate({
                supplier_id: supplier.id,
                cashbox_id: cbId,
                payment_method: method,
                amount: amt,
                reference: reference || undefined,
                notes: notes || undefined,
              });
            }}
          >
            <CreditCard size={18} /> حفظ الدفعة
          </button>
          <button className="btn-secondary" onClick={onClose}>
            إلغاء
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-bold text-slate-600 mb-1 block">{label}</span>
      {children}
    </label>
  );
}
