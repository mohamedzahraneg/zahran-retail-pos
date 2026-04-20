import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Building2,
  Warehouse as WarehouseIcon,
  Wallet,
  CreditCard,
  Users as UsersIcon,
  Save,
  Plus,
  Edit3,
  Check,
  X,
  Printer,
} from 'lucide-react';
import toast from 'react-hot-toast';
import {
  settingsApi,
  CompanyProfile,
  Warehouse,
  Cashbox,
  PaymentMethod,
  Role,
} from '@/api/settings.api';

type TabKey = 'company' | 'receipt' | 'warehouses' | 'cashboxes' | 'payments' | 'roles';

const TABS: { key: TabKey; label: string; icon: any }[] = [
  { key: 'company', label: 'بيانات المحل', icon: Building2 },
  { key: 'receipt', label: 'إعدادات الفاتورة', icon: Printer },
  { key: 'warehouses', label: 'المخازن', icon: WarehouseIcon },
  { key: 'cashboxes', label: 'الخزائن', icon: Wallet },
  { key: 'payments', label: 'طرق الدفع', icon: CreditCard },
  { key: 'roles', label: 'الأدوار', icon: UsersIcon },
];

export default function Settings() {
  const [tab, setTab] = useState<TabKey>('company');

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
        <div className="flex flex-wrap gap-2 p-3 border-b border-slate-200">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`px-4 py-2 rounded-lg font-medium text-sm flex items-center gap-2 transition ${
                  active
                    ? 'bg-indigo-600 text-white shadow'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
              >
                <Icon className="w-4 h-4" /> {t.label}
              </button>
            );
          })}
        </div>

        <div className="p-6">
          {tab === 'company' && <CompanyTab />}
          {tab === 'receipt' && <ReceiptTab />}
          {tab === 'warehouses' && <WarehousesTab />}
          {tab === 'cashboxes' && <CashboxesTab />}
          {tab === 'payments' && <PaymentsTab />}
          {tab === 'roles' && <RolesTab />}
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
function CompanyTab() {
  const qc = useQueryClient();
  const company = useQuery({
    queryKey: ['company-profile'],
    queryFn: () => settingsApi.getCompany(),
  });

  const [form, setForm] = useState<Partial<CompanyProfile>>({});

  useEffect(() => {
    if (company.data) setForm(company.data);
  }, [company.data]);

  const save = useMutation({
    mutationFn: () => settingsApi.updateCompany(form),
    onSuccess: () => {
      toast.success('تم حفظ بيانات المحل');
      qc.invalidateQueries({ queryKey: ['company-profile'] });
    },
  });

  const field = (
    k: keyof CompanyProfile,
    label: string,
    type: 'text' | 'number' | 'email' = 'text',
  ) => (
    <div>
      <label className="block text-sm text-slate-600 mb-1">{label}</label>
      <input
        type={type}
        value={(form[k] as string | number | undefined) ?? ''}
        onChange={(e) =>
          setForm({
            ...form,
            [k]: type === 'number' ? Number(e.target.value) : e.target.value,
          })
        }
        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
      />
    </div>
  );

  return (
    <div className="max-w-3xl space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {field('name_ar', 'اسم المحل (عربي)')}
        {field('name_en', 'اسم المحل (إنجليزي)')}
        {field('tax_number', 'الرقم الضريبي')}
        {field('commercial_register', 'السجل التجاري')}
        {field('phone', 'الهاتف')}
        {field('email', 'البريد الإلكتروني', 'email')}
        {field('currency', 'العملة')}
        {field('tax_rate', 'نسبة الضريبة %', 'number')}
      </div>
      <div>
        <label className="block text-sm text-slate-600 mb-1">العنوان</label>
        <textarea
          value={form.address ?? ''}
          onChange={(e) => setForm({ ...form, address: e.target.value })}
          className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
          rows={2}
        />
      </div>
      <div>
        <label className="block text-sm text-slate-600 mb-1">تذييل الإيصال (عربي)</label>
        <textarea
          value={form.receipt_footer_ar ?? ''}
          onChange={(e) =>
            setForm({ ...form, receipt_footer_ar: e.target.value })
          }
          className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
          rows={2}
        />
      </div>
      <button
        onClick={() => save.mutate()}
        disabled={save.isPending}
        className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg px-5 py-2 text-sm font-medium flex items-center gap-2 disabled:opacity-50"
      >
        <Save className="w-4 h-4" /> حفظ
      </button>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
function WarehousesTab() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['warehouses-admin'],
    queryFn: () => settingsApi.listWarehouses(true),
  });
  const [modal, setModal] = useState<Warehouse | null | 'new'>(null);

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          onClick={() => setModal('new')}
          className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg px-4 py-2 text-sm font-medium flex items-center gap-2"
        >
          <Plus className="w-4 h-4" /> مخزن جديد
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-right p-3">الكود</th>
              <th className="text-right p-3">الاسم</th>
              <th className="text-right p-3">الهاتف</th>
              <th className="text-right p-3">المدير</th>
              <th className="p-3 text-center">الحالة</th>
              <th className="p-3 text-center">رئيسي</th>
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {list.data?.map((w) => (
              <tr key={w.id} className="border-t border-slate-100">
                <td className="p-3 font-mono text-xs">{w.code}</td>
                <td className="p-3 font-medium">{w.name_ar}</td>
                <td className="p-3 text-slate-600">{w.phone || '—'}</td>
                <td className="p-3 text-slate-600">{w.manager_name || '—'}</td>
                <td className="p-3 text-center">
                  {w.is_active ? (
                    <span className="inline-flex items-center gap-1 text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full text-xs">
                      <Check className="w-3 h-3" /> نشط
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full text-xs">
                      <X className="w-3 h-3" /> معطل
                    </span>
                  )}
                </td>
                <td className="p-3 text-center">{w.is_main ? '⭐' : ''}</td>
                <td className="p-3 text-end">
                  <button
                    onClick={() => setModal(w)}
                    className="text-indigo-600 hover:bg-indigo-50 p-1 rounded"
                  >
                    <Edit3 className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal && (
        <WarehouseModal
          warehouse={modal === 'new' ? null : (modal as Warehouse)}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            qc.invalidateQueries({ queryKey: ['warehouses-admin'] });
          }}
        />
      )}
    </div>
  );
}

function WarehouseModal({
  warehouse,
  onClose,
  onSaved,
}: {
  warehouse: Warehouse | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<Partial<Warehouse>>(
    warehouse ?? {
      code: '',
      name_ar: '',
      is_main: false,
      is_retail: true,
      is_active: true,
    },
  );
  const save = useMutation({
    mutationFn: () =>
      warehouse
        ? settingsApi.updateWarehouse(warehouse.id, form)
        : settingsApi.createWarehouse(form),
    onSuccess: () => {
      toast.success('تم الحفظ');
      onSaved();
    },
  });

  return (
    <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl w-full max-w-md shadow-xl">
        <div className="flex items-center justify-between p-4 border-b border-slate-200">
          <h2 className="text-lg font-bold">
            {warehouse ? 'تعديل مخزن' : 'مخزن جديد'}
          </h2>
          <button onClick={onClose} className="text-slate-500">✕</button>
        </div>
        <div className="p-4 space-y-3">
          <Input
            label="الكود"
            value={form.code ?? ''}
            onChange={(v) => setForm({ ...form, code: v })}
          />
          <Input
            label="الاسم (عربي)"
            value={form.name_ar ?? ''}
            onChange={(v) => setForm({ ...form, name_ar: v })}
          />
          <Input
            label="الاسم (إنجليزي)"
            value={form.name_en ?? ''}
            onChange={(v) => setForm({ ...form, name_en: v })}
          />
          <Input
            label="الهاتف"
            value={form.phone ?? ''}
            onChange={(v) => setForm({ ...form, phone: v })}
          />
          <Input
            label="العنوان"
            value={form.address ?? ''}
            onChange={(v) => setForm({ ...form, address: v })}
          />
          <div className="flex gap-4">
            <Toggle
              label="مخزن رئيسي"
              value={!!form.is_main}
              onChange={(v) => setForm({ ...form, is_main: v })}
            />
            <Toggle
              label="بيع بالتجزئة"
              value={!!form.is_retail}
              onChange={(v) => setForm({ ...form, is_retail: v })}
            />
            <Toggle
              label="نشط"
              value={!!form.is_active}
              onChange={(v) => setForm({ ...form, is_active: v })}
            />
          </div>
        </div>
        <div className="flex gap-2 p-4 border-t border-slate-200">
          <button
            onClick={onClose}
            className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg px-4 py-2 text-sm font-medium"
          >
            إلغاء
          </button>
          <button
            onClick={() => save.mutate()}
            disabled={!form.code || !form.name_ar}
            className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            حفظ
          </button>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
function CashboxesTab() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['cashboxes-admin'],
    queryFn: () => settingsApi.listCashboxes(),
  });
  const warehouses = useQuery({
    queryKey: ['warehouses-admin'],
    queryFn: () => settingsApi.listWarehouses(false),
  });
  const [modal, setModal] = useState<Cashbox | null | 'new'>(null);

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          onClick={() => setModal('new')}
          className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg px-4 py-2 text-sm font-medium flex items-center gap-2"
        >
          <Plus className="w-4 h-4" /> خزينة جديدة
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-right p-3">الاسم</th>
              <th className="text-right p-3">المخزن</th>
              <th className="text-end p-3">الرصيد الحالي</th>
              <th className="p-3 text-center">الحالة</th>
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {list.data?.map((cb) => (
              <tr key={cb.id} className="border-t border-slate-100">
                <td className="p-3 font-medium">{cb.name_ar}</td>
                <td className="p-3 text-slate-600">{cb.warehouse_name}</td>
                <td className="p-3 text-end tabular-nums font-semibold">
                  {Number(cb.current_balance).toLocaleString('en-US', {
                    minimumFractionDigits: 2,
                  })}{' '}
                  ج.م
                </td>
                <td className="p-3 text-center">
                  {cb.is_active ? '✓' : '—'}
                </td>
                <td className="p-3 text-end">
                  <button
                    onClick={() => setModal(cb)}
                    className="text-indigo-600 hover:bg-indigo-50 p-1 rounded"
                  >
                    <Edit3 className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal && (
        <CashboxModal
          cashbox={modal === 'new' ? null : (modal as Cashbox)}
          warehouses={warehouses.data ?? []}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            qc.invalidateQueries({ queryKey: ['cashboxes-admin'] });
          }}
        />
      )}
    </div>
  );
}

function CashboxModal({
  cashbox,
  warehouses,
  onClose,
  onSaved,
}: {
  cashbox: Cashbox | null;
  warehouses: Warehouse[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<Partial<Cashbox>>(
    cashbox ?? { name_ar: '', warehouse_id: '', is_active: true },
  );
  const save = useMutation({
    mutationFn: () =>
      cashbox
        ? settingsApi.updateCashbox(cashbox.id, form)
        : settingsApi.createCashbox(form),
    onSuccess: () => {
      toast.success('تم الحفظ');
      onSaved();
    },
  });

  return (
    <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl w-full max-w-md shadow-xl">
        <div className="flex items-center justify-between p-4 border-b border-slate-200">
          <h2 className="text-lg font-bold">
            {cashbox ? 'تعديل خزينة' : 'خزينة جديدة'}
          </h2>
          <button onClick={onClose} className="text-slate-500">✕</button>
        </div>
        <div className="p-4 space-y-3">
          <Input
            label="الاسم"
            value={form.name_ar ?? ''}
            onChange={(v) => setForm({ ...form, name_ar: v })}
          />
          <div>
            <label className="block text-sm text-slate-600 mb-1">المخزن</label>
            <select
              value={form.warehouse_id ?? ''}
              onChange={(e) =>
                setForm({ ...form, warehouse_id: e.target.value })
              }
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
            >
              <option value="">— اختر —</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name_ar}
                </option>
              ))}
            </select>
          </div>
          <Toggle
            label="نشط"
            value={!!form.is_active}
            onChange={(v) => setForm({ ...form, is_active: v })}
          />
        </div>
        <div className="flex gap-2 p-4 border-t border-slate-200">
          <button
            onClick={onClose}
            className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg px-4 py-2 text-sm font-medium"
          >
            إلغاء
          </button>
          <button
            onClick={() => save.mutate()}
            disabled={!form.name_ar || !form.warehouse_id}
            className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            حفظ
          </button>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
function PaymentsTab() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['payment-methods'],
    queryFn: () => settingsApi.listPaymentMethods(),
  });
  const toggle = useMutation({
    mutationFn: (p: { code: string; is_active: boolean }) =>
      settingsApi.togglePaymentMethod(p.code, p.is_active),
    onSuccess: () => {
      toast.success('تم التحديث');
      qc.invalidateQueries({ queryKey: ['payment-methods'] });
    },
  });

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-slate-600">
          <tr>
            <th className="text-right p-3">الكود</th>
            <th className="text-right p-3">الاسم (عربي)</th>
            <th className="text-right p-3">الاسم (إنجليزي)</th>
            <th className="p-3 text-center">يحتاج مرجع</th>
            <th className="p-3 text-center">الحالة</th>
          </tr>
        </thead>
        <tbody>
          {list.data?.map((p: PaymentMethod) => (
            <tr key={p.code} className="border-t border-slate-100">
              <td className="p-3 font-mono text-xs">{p.code}</td>
              <td className="p-3 font-medium">{p.name_ar}</td>
              <td className="p-3 text-slate-600">{p.name_en}</td>
              <td className="p-3 text-center">
                {p.requires_reference ? '✓' : '—'}
              </td>
              <td className="p-3 text-center">
                <button
                  onClick={() =>
                    toggle.mutate({ code: p.code, is_active: !p.is_active })
                  }
                  className={`px-3 py-1 rounded-lg text-xs font-semibold ${
                    p.is_active
                      ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200'
                      : 'bg-slate-200 text-slate-600 hover:bg-slate-300'
                  }`}
                >
                  {p.is_active ? 'مفعل' : 'معطل'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
function RolesTab() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['roles'],
    queryFn: () => settingsApi.listRoles(),
  });
  const perms = useQuery({
    queryKey: ['permissions-catalog'],
    queryFn: () => settingsApi.listPermissions(),
  });

  const [editing, setEditing] = useState<Role | null>(null);
  const [creating, setCreating] = useState(false);

  const onClose = () => {
    setEditing(null);
    setCreating(false);
    qc.invalidateQueries({ queryKey: ['roles'] });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-slate-600">
          إدارة الأدوار والصلاحيات. الأدوار الأساسية للنظام لا يمكن حذفها.
        </div>
        <button
          className="btn-primary text-sm"
          onClick={() => setCreating(true)}
        >
          + إضافة دور
        </button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-right p-3">الكود</th>
              <th className="text-right p-3">الاسم</th>
              <th className="text-right p-3">الوصف</th>
              <th className="text-right p-3">المستخدمون</th>
              <th className="text-right p-3">الصلاحيات</th>
              <th className="text-left p-3">إجراءات</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.map((r: Role) => (
              <tr key={r.id} className="border-t border-slate-100">
                <td className="p-3 font-mono text-xs">{r.code}</td>
                <td className="p-3 font-medium">
                  {r.name_ar}
                  {r.is_system && (
                    <span className="chip bg-slate-100 text-slate-600 text-[10px] mr-1">
                      أساسي
                    </span>
                  )}
                </td>
                <td className="p-3 text-slate-600 text-xs">{r.description || '—'}</td>
                <td className="p-3 text-xs">{r.users_count ?? 0}</td>
                <td className="p-3 text-xs">
                  <span className="chip bg-brand-100 text-brand-700">
                    {r.permissions?.length || 0} صلاحية
                  </span>
                </td>
                <td className="p-3 text-left">
                  <button
                    className="btn-ghost text-xs"
                    onClick={() => setEditing(r)}
                  >
                    تعديل
                  </button>
                </td>
              </tr>
            ))}
            {list.data && list.data.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="p-6 text-center text-slate-400 text-sm"
                >
                  لا توجد أدوار
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {(editing || creating) && perms.data && (
        <RoleEditorModal
          role={editing}
          groups={perms.data.groups}
          onClose={onClose}
        />
      )}
    </div>
  );
}

function RoleEditorModal({
  role,
  groups,
  onClose,
}: {
  role: Role | null;
  groups: Record<string, Array<{ code: string; label: string }>>;
  onClose: () => void;
}) {
  const isEdit = !!role;
  const [form, setForm] = useState({
    code: role?.code || '',
    name_ar: role?.name_ar || '',
    name_en: role?.name_en || '',
    description: role?.description || '',
    permissions: new Set(role?.permissions || []),
  });

  const togglePerm = (code: string) => {
    const next = new Set(form.permissions);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    setForm({ ...form, permissions: next });
  };

  const toggleGroup = (group: string, on: boolean) => {
    const next = new Set(form.permissions);
    for (const p of groups[group]) {
      if (on) next.add(p.code);
      else next.delete(p.code);
    }
    setForm({ ...form, permissions: next });
  };

  const saveMutation = useMutation({
    mutationFn: () => {
      const payload = {
        name_ar: form.name_ar.trim(),
        name_en: form.name_en.trim() || undefined,
        description: form.description.trim() || undefined,
        permissions: Array.from(form.permissions),
      };
      if (isEdit) {
        return settingsApi.updateRole(role!.id, payload);
      }
      return settingsApi.createRole({
        code: form.code.trim().toLowerCase(),
        ...payload,
      });
    },
    onSuccess: () => {
      toast.success(isEdit ? 'تم التحديث' : 'تم إضافة الدور');
      onClose();
    },
    onError: (e: any) => {
      const msg = e?.response?.data?.message || 'فشل الحفظ';
      toast.error(Array.isArray(msg) ? msg[0] : String(msg));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => settingsApi.deleteRole(role!.id),
    onSuccess: () => {
      toast.success('تم حذف الدور');
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'لا يمكن حذف هذا الدور'),
  });

  return (
    <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-slate-100">
          <h3 className="font-black text-slate-800">
            {isEdit ? `تعديل دور: ${role!.name_ar}` : 'إضافة دور جديد'}
          </h3>
          <button className="p-1 hover:bg-slate-100 rounded" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-slate-600 block mb-1">
                الكود (إنجليزي) *
              </label>
              <input
                className="input font-mono"
                value={form.code}
                disabled={isEdit}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
                placeholder="supervisor"
              />
            </div>
            <div>
              <label className="text-xs text-slate-600 block mb-1">
                الاسم العربي *
              </label>
              <input
                className="input"
                value={form.name_ar}
                onChange={(e) => setForm({ ...form, name_ar: e.target.value })}
              />
            </div>
          </div>
          <div>
            <label className="text-xs text-slate-600 block mb-1">الوصف</label>
            <input
              className="input"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="font-black text-slate-800">الصلاحيات</div>
              <div className="text-xs text-slate-500">
                {form.permissions.size} محددة
              </div>
            </div>
            <div className="space-y-3">
              {Object.entries(groups).map(([group, perms]) => {
                const allOn = perms.every((p) => form.permissions.has(p.code));
                const someOn = perms.some((p) => form.permissions.has(p.code));
                return (
                  <div
                    key={group}
                    className="rounded-lg border border-slate-200 overflow-hidden"
                  >
                    <div className="bg-slate-50 px-3 py-2 flex items-center justify-between border-b border-slate-100">
                      <span className="font-bold text-sm text-slate-700">
                        {group}
                      </span>
                      <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={allOn}
                          ref={(el) => {
                            if (el) el.indeterminate = someOn && !allOn;
                          }}
                          onChange={(e) =>
                            toggleGroup(group, e.target.checked)
                          }
                        />
                        الكل
                      </label>
                    </div>
                    <div className="p-3 grid grid-cols-2 gap-2">
                      {perms.map((p) => (
                        <label
                          key={p.code}
                          className="flex items-center gap-2 text-sm cursor-pointer hover:bg-slate-50 rounded px-2 py-1"
                        >
                          <input
                            type="checkbox"
                            checked={form.permissions.has(p.code)}
                            onChange={() => togglePerm(p.code)}
                          />
                          <span>{p.label}</span>
                          <span className="font-mono text-[10px] text-slate-400 mr-auto">
                            {p.code}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="border-t border-slate-100 p-4 flex items-center justify-between gap-2 bg-slate-50">
          {isEdit && !role?.is_system && (
            <button
              className="text-xs text-rose-600 hover:bg-rose-100 px-3 py-2 rounded-lg"
              onClick={() => {
                if (confirm(`هل أنت متأكد من حذف الدور "${role!.name_ar}"؟`))
                  deleteMutation.mutate();
              }}
              disabled={deleteMutation.isPending}
            >
              حذف الدور
            </button>
          )}
          <div className="flex items-center gap-2 ms-auto">
            <button className="btn-ghost" onClick={onClose}>
              إلغاء
            </button>
            <button
              className="btn-primary"
              disabled={
                saveMutation.isPending ||
                !form.name_ar.trim() ||
                (!isEdit && !form.code.trim())
              }
              onClick={() => saveMutation.mutate()}
            >
              {saveMutation.isPending ? 'جاري الحفظ...' : 'حفظ'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
function Input({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="block text-sm text-slate-600 mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
      />
    </div>
  );
}

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm cursor-pointer">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="rounded text-indigo-600 focus:ring-indigo-500"
      />
      <span className="text-slate-700">{label}</span>
    </label>
  );
}

/* ────────────────────────────────────────────────────────────────────
 *  Receipt settings tab — edits shop.info + shop.receipt JSON in the
 *  key/value settings table so admins can customise the printed receipt.
 * ──────────────────────────────────────────────────────────────────── */
interface ReceiptSettings {
  shopName: string;
  address: string;
  phone: string;
  taxId: string;
  logoUrl: string;
  footerNote: string;
  headerNote: string;
  qrUrl: string;
  qrCaption: string;
  website: string;
  terms: string;
}

const EMPTY_RECEIPT: ReceiptSettings = {
  shopName: '', address: '', phone: '', taxId: '', logoUrl: '', footerNote: '',
  headerNote: '', qrUrl: '', qrCaption: '', website: '', terms: '',
};

function ReceiptTab() {
  const qc = useQueryClient();
  const [form, setForm] = useState<ReceiptSettings>(EMPTY_RECEIPT);

  const infoQuery = useQuery({
    queryKey: ['settings', 'shop.info'],
    queryFn: () => settingsApi.get('shop.info').catch(() => null),
  });
  const receiptQuery = useQuery({
    queryKey: ['settings', 'shop.receipt'],
    queryFn: () => settingsApi.get('shop.receipt').catch(() => null),
  });

  useEffect(() => {
    const info = (infoQuery.data?.value as any) || {};
    const receipt = (receiptQuery.data?.value as any) || {};
    setForm({
      shopName: info.name || '',
      address: info.address || '',
      phone: info.phone || '',
      taxId: info.tax_id || info.vat_number || '',
      logoUrl: info.logo_url || '',
      footerNote: info.footer_note || receipt.footer_note || '',
      headerNote: receipt.header_note || '',
      qrUrl: receipt.qr_url || '',
      qrCaption: receipt.qr_caption || '',
      website: receipt.website || '',
      terms: receipt.terms || '',
    });
  }, [infoQuery.data, receiptQuery.data]);

  const save = useMutation({
    mutationFn: async () => {
      await settingsApi.upsert({
        key: 'shop.info',
        group_name: 'shop',
        is_public: true,
        value: {
          name: form.shopName,
          address: form.address,
          phone: form.phone,
          tax_id: form.taxId,
          logo_url: form.logoUrl,
          footer_note: form.footerNote,
        } as any,
      });
      await settingsApi.upsert({
        key: 'shop.receipt',
        group_name: 'shop',
        is_public: true,
        value: {
          header_note: form.headerNote,
          qr_url: form.qrUrl,
          qr_caption: form.qrCaption,
          website: form.website,
          terms: form.terms,
        } as any,
      });
    },
    onSuccess: () => {
      toast.success('تم الحفظ');
      qc.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (e: any) => toast.error(e?.response?.data?.message || 'فشل الحفظ'),
  });

  const set = <K extends keyof ReceiptSettings>(key: K, value: ReceiptSettings[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const pickLogo = (file: File) => {
    if (file.size > 500 * 1024) {
      toast.error('حجم الصورة أكبر من 500KB — اضغطها أو اختار أصغر');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => set('logoUrl', String(reader.result || ''));
    reader.readAsDataURL(file);
  };

  return (
    <div className="max-w-3xl space-y-4">
      {/* Logo uploader — lives at the top of the receipt */}
      <div className="rounded-xl border border-slate-200 p-4 flex items-center gap-4">
        <div className="w-20 h-20 rounded-lg bg-slate-50 border border-dashed border-slate-300 flex items-center justify-center overflow-hidden shrink-0">
          {form.logoUrl ? (
            <img src={form.logoUrl} alt="logo" className="w-full h-full object-contain" />
          ) : (
            <span className="text-xs text-slate-400">بدون شعار</span>
          )}
        </div>
        <div className="flex-1">
          <div className="text-sm font-bold text-slate-700 mb-1">شعار المحل (يظهر أعلى الفاتورة)</div>
          <div className="flex items-center gap-2 flex-wrap">
            <label className="inline-flex items-center gap-2 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 px-3 py-1.5 rounded-lg text-sm font-semibold cursor-pointer">
              رفع صورة
              <input
                type="file"
                accept="image/png,image/jpeg,image/svg+xml,image/webp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) pickLogo(f);
                  e.currentTarget.value = '';
                }}
              />
            </label>
            {form.logoUrl && (
              <button
                onClick={() => set('logoUrl', '')}
                className="text-xs text-rose-600 hover:text-rose-700 px-2 py-1"
              >
                حذف الشعار
              </button>
            )}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            PNG / JPG / SVG — أقصى 500KB — يُحفظ مع الفاتورة مباشرة (data URL)
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="اسم المحل" value={form.shopName} onChange={(v) => set('shopName', v)} />
        <Field label="الهاتف" value={form.phone} onChange={(v) => set('phone', v)} />
        <Field label="العنوان" value={form.address} onChange={(v) => set('address', v)} />
        <Field label="الرقم الضريبي" value={form.taxId} onChange={(v) => set('taxId', v)} />
        <Field label="الموقع الإلكتروني" value={form.website} onChange={(v) => set('website', v)} />
        <Field label="رابط الـ QR" value={form.qrUrl} onChange={(v) => set('qrUrl', v)}
          hint="الرابط اللي هيفتح لما الزبون يمسح الـ QR (موقعك، انستجرام، تقييم...)" />
        <Field label="تعليق تحت الـ QR" value={form.qrCaption} onChange={(v) => set('qrCaption', v)} />
        <Field label="رابط الشعار (اختياري — لو مرفوع خارجياً)" value={form.logoUrl} onChange={(v) => set('logoUrl', v)}
          hint="اتركه فاضي لو رافع الصورة أعلاه" />
      </div>

      <Textarea
        label="رسالة أعلى الفاتورة (Header)"
        value={form.headerNote}
        rows={2}
        onChange={(v) => set('headerNote', v)}
        hint="مثال: «عرض الموسم» أو شعار المحل الترويجي"
      />
      <Textarea
        label="رسالة الشكر أسفل الفاتورة (Footer)"
        value={form.footerNote}
        rows={2}
        onChange={(v) => set('footerNote', v)}
      />
      <Textarea
        label="الشروط والأحكام"
        value={form.terms}
        rows={6}
        onChange={(v) => set('terms', v)}
        hint="سطر لكل بند — هتظهر قبل الـ QR في الفاتورة المطبوعة"
      />

      <div className="pt-2">
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="inline-flex items-center gap-2 bg-indigo-600 text-white px-5 py-2.5 rounded-lg font-bold hover:bg-indigo-700 disabled:opacity-50"
        >
          <Save className="w-4 h-4" />
          {save.isPending ? 'جارٍ الحفظ…' : 'حفظ إعدادات الفاتورة'}
        </button>
      </div>
    </div>
  );
}

function Field({
  label, value, onChange, hint,
}: { label: string; value: string; onChange: (v: string) => void; hint?: string }) {
  return (
    <label className="block">
      <div className="text-sm font-semibold text-slate-700 mb-1">{label}</div>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-indigo-500 focus:outline-none"
      />
      {hint && <div className="text-xs text-slate-500 mt-1">{hint}</div>}
    </label>
  );
}

function Textarea({
  label, value, onChange, rows = 3, hint,
}: { label: string; value: string; onChange: (v: string) => void; rows?: number; hint?: string }) {
  return (
    <label className="block">
      <div className="text-sm font-semibold text-slate-700 mb-1">{label}</div>
      <textarea
        value={value}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-indigo-500 focus:outline-none"
      />
      {hint && <div className="text-xs text-slate-500 mt-1">{hint}</div>}
    </label>
  );
}
