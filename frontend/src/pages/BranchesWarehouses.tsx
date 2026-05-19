/**
 * BranchesWarehouses.tsx — PR-BRANCHES-WAREHOUSES-FOUNDATION
 *
 * Admin / manager surface for the new branches model:
 *   · CRUD on branches (organisational units).
 *   · Linking branches to warehouses (M:M, one primary per warehouse).
 *
 * Strictly organisational — no stock mutation, no edit-cost / edit-
 * price / edit-quantity controls. Inventory operations stay on their
 * dedicated pages (StockTransfers / StockAdjustments / StockCount).
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Building2,
  Boxes,
  Plus,
  Pencil,
  Link2,
  Link2Off,
  Star,
  X,
  Check,
  Search,
} from 'lucide-react';
import {
  branchesApi,
  BRANCH_TYPES,
  BRANCH_TYPE_LABELS_AR,
  type Branch,
  type BranchType,
  type CreateBranchBody,
  type UpdateBranchBody,
} from '@/api/branches.api';
import { settingsApi, type Warehouse } from '@/api/settings.api';

const EMPTY_FORM: CreateBranchBody = {
  code: '',
  name_ar: '',
  name_en: '',
  type: 'retail',
  address: '',
  phone: '',
  is_active: true,
};

export default function BranchesWarehouses() {
  const qc = useQueryClient();
  const [showInactive, setShowInactive] = useState(false);
  const [listQ, setListQ] = useState('');
  const [editing, setEditing] = useState<
    | { mode: 'create' }
    | { mode: 'edit'; branch: Branch }
    | null
  >(null);
  const [linkBranchId, setLinkBranchId] = useState<string | null>(null);

  const { data: branches = [], isLoading: branchesLoading } = useQuery({
    queryKey: ['branches', { include_inactive: showInactive }],
    queryFn: () => branchesApi.list(showInactive),
  });

  const { data: warehousesRollup = [] } = useQuery({
    queryKey: ['warehouses-with-branches'],
    queryFn: () => branchesApi.listWarehousesWithBranches(),
  });

  const { data: allWarehouses = [] } = useQuery({
    queryKey: ['settings-warehouses-all'],
    queryFn: () => settingsApi.listWarehouses(true),
    staleTime: 5 * 60_000,
  });

  const filteredBranches = useMemo(() => {
    const q = listQ.trim().toLowerCase();
    if (!q) return branches;
    return branches.filter(
      (b) =>
        (b.code ?? '').toLowerCase().includes(q) ||
        (b.name_ar ?? '').toLowerCase().includes(q) ||
        (b.name_en ?? '').toLowerCase().includes(q),
    );
  }, [branches, listQ]);

  const onAfterMutation = (msg: string) => {
    toast.success(msg);
    qc.invalidateQueries({ queryKey: ['branches'] });
    qc.invalidateQueries({ queryKey: ['warehouses-with-branches'] });
  };

  return (
    <div className="space-y-4" dir="rtl" data-testid="branches-warehouses-page">
      {/* ── Header ─────────────────────────────────────────────── */}
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-black text-slate-800 flex items-center gap-2">
            <Building2 className="w-5 h-5 text-indigo-600" />
            الفروع والمخازن
          </h1>
          <p className="text-xs text-slate-600 mt-1">
            إدارة الفروع (وحدات تنظيمية) وربطها بالمخازن. لا تأثير على الأرصدة
            أو الحركات أو الفواتير — فقط بيانات تنظيمية.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setEditing({ mode: 'create' })}
          className="btn btn-primary"
          data-testid="branches-create-button"
        >
          <Plus size={16} />
          فرع جديد
        </button>
      </header>

      {/* ── Branches list ──────────────────────────────────────── */}
      <section
        className="card overflow-hidden"
        data-testid="branches-section"
      >
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between gap-2 flex-wrap">
          <div className="font-bold text-slate-800 flex items-center gap-2">
            <Building2 size={15} className="text-indigo-600" />
            الفروع
            <span className="text-[11px] text-slate-400 tabular-nums">
              ({branches.length})
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <label className="flex items-center gap-2 input">
              <Search size={13} className="text-slate-400" />
              <input
                type="text"
                placeholder="بحث بالكود أو الاسم…"
                value={listQ}
                onChange={(e) => setListQ(e.target.value)}
                className="bg-transparent outline-none text-sm w-48"
                data-testid="branches-search"
              />
            </label>
            <label className="flex items-center gap-1 cursor-pointer">
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
                data-testid="branches-show-inactive"
              />
              عرض غير النشطة
            </label>
          </div>
        </div>
        <div className="overflow-x-auto">
          {branchesLoading ? (
            <div className="p-6 text-center text-sm text-slate-400">
              جاري التحميل…
            </div>
          ) : filteredBranches.length === 0 ? (
            <div className="p-6 text-center text-sm text-slate-400">
              لا توجد فروع.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500">
                <tr>
                  <th className="text-right px-3 py-2">الكود</th>
                  <th className="text-right px-3 py-2">الاسم</th>
                  <th className="text-right px-3 py-2">النوع</th>
                  <th className="text-right px-3 py-2">المدير</th>
                  <th className="text-right px-3 py-2">الهاتف</th>
                  <th className="text-center px-3 py-2">مخازن</th>
                  <th className="text-center px-3 py-2">نشط</th>
                  <th className="text-center px-3 py-2">إجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredBranches.map((b) => (
                  <tr
                    key={b.id}
                    data-testid="branch-row"
                    className={b.is_active ? '' : 'bg-slate-50/40 text-slate-500'}
                  >
                    <td className="px-3 py-2 font-bold tabular-nums">
                      {b.code}
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-800">
                        {b.name_ar}
                      </div>
                      {b.name_en && (
                        <div className="text-[10px] text-slate-400">
                          {b.name_en}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border border-indigo-200 bg-indigo-50 text-indigo-700">
                        {BRANCH_TYPE_LABELS_AR[b.type] || b.type}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600">
                      {b.manager_name || '—'}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600 tabular-nums">
                      {b.phone || '—'}
                    </td>
                    <td className="px-3 py-2 text-center text-xs tabular-nums">
                      {b.warehouses_count ?? 0}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {b.is_active ? (
                        <Check
                          size={14}
                          className="text-emerald-600 inline"
                          aria-label="نشط"
                        />
                      ) : (
                        <X size={14} className="text-slate-400 inline" />
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          type="button"
                          className="icon-btn"
                          title="تعديل"
                          onClick={() =>
                            setEditing({ mode: 'edit', branch: b })
                          }
                          data-testid="branch-edit-button"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          title="ربط مخازن"
                          onClick={() => setLinkBranchId(b.id)}
                          data-testid="branch-link-button"
                        >
                          <Link2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* ── Warehouses + branches roll-up ──────────────────────── */}
      <section
        className="card overflow-hidden"
        data-testid="warehouses-rollup-section"
      >
        <div className="px-4 py-3 border-b border-slate-100 font-bold text-slate-800 flex items-center gap-2">
          <Boxes size={15} className="text-emerald-600" />
          المخازن — مرتبطة بالفروع
          <span className="text-[11px] text-slate-400 tabular-nums">
            ({warehousesRollup.length})
          </span>
        </div>
        <div className="overflow-x-auto">
          {warehousesRollup.length === 0 ? (
            <div className="p-6 text-center text-sm text-slate-400">
              لا توجد مخازن.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500">
                <tr>
                  <th className="text-right px-3 py-2">الكود</th>
                  <th className="text-right px-3 py-2">المخزن</th>
                  <th className="text-right px-3 py-2">النوع</th>
                  <th className="text-center px-3 py-2">قابل للبيع</th>
                  <th className="text-center px-3 py-2">سالب مسموح</th>
                  <th className="text-center px-3 py-2">نشط</th>
                  <th className="text-right px-3 py-2">الفرع الأساسي</th>
                  <th className="text-right px-3 py-2">كل الفروع</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {warehousesRollup.map((w) => (
                  <tr
                    key={w.id}
                    data-testid="warehouse-rollup-row"
                  >
                    <td className="px-3 py-2 font-bold tabular-nums">
                      {w.code}
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-800">
                        {w.name_ar || w.name}
                      </div>
                      {w.name_en && (
                        <div className="text-[10px] text-slate-400">
                          {w.name_en}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600">
                      {w.warehouse_type || w.is_main ? (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border border-slate-200 bg-white">
                          {w.warehouse_type || (w.is_main ? 'main' : 'branch')}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {w.is_sellable ? (
                        <Check size={14} className="text-emerald-600 inline" />
                      ) : (
                        <X size={14} className="text-slate-400 inline" />
                      )}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {w.allow_negative_stock ? (
                        <Check size={14} className="text-amber-600 inline" />
                      ) : (
                        <X size={14} className="text-slate-400 inline" />
                      )}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {w.is_active ? (
                        <Check size={14} className="text-emerald-600 inline" />
                      ) : (
                        <X size={14} className="text-slate-400 inline" />
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {w.primary_branch ? (
                        <span
                          className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border border-amber-200 bg-amber-50 text-amber-700"
                          data-testid="warehouse-rollup-primary"
                        >
                          <Star size={10} />
                          {w.primary_branch.name_ar}
                        </span>
                      ) : (
                        <span className="text-slate-300 text-[10px]">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div
                        className="flex flex-wrap gap-1"
                        data-testid="warehouse-rollup-branches"
                      >
                        {w.branches.length === 0 ? (
                          <span className="text-slate-300 text-[10px]">—</span>
                        ) : (
                          w.branches.map((b) => (
                            <span
                              key={b.id}
                              className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                                b.is_primary
                                  ? 'border-amber-200 bg-amber-50 text-amber-700'
                                  : 'border-slate-200 bg-white text-slate-700'
                              }`}
                            >
                              {b.is_primary && <Star size={9} />}
                              {b.name_ar}
                            </span>
                          ))
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {editing && (
        <BranchFormModal
          mode={editing.mode}
          branch={editing.mode === 'edit' ? editing.branch : null}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            onAfterMutation(message);
          }}
        />
      )}

      {linkBranchId && (
        <LinkWarehousesModal
          branchId={linkBranchId}
          allWarehouses={allWarehouses}
          onClose={() => setLinkBranchId(null)}
          onChanged={() => {
            qc.invalidateQueries({ queryKey: ['branches'] });
            qc.invalidateQueries({ queryKey: ['warehouses-with-branches'] });
            qc.invalidateQueries({
              queryKey: ['branch-warehouses', linkBranchId],
            });
          }}
        />
      )}
    </div>
  );
}

// ─── Branch create/edit modal ──────────────────────────────────────
function BranchFormModal({
  mode,
  branch,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  branch: Branch | null;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [form, setForm] = useState<CreateBranchBody>(
    branch
      ? {
          code: branch.code,
          name_ar: branch.name_ar,
          name_en: branch.name_en ?? '',
          type: branch.type,
          address: branch.address ?? '',
          phone: branch.phone ?? '',
          is_active: branch.is_active,
        }
      : EMPTY_FORM,
  );
  const update = (patch: Partial<CreateBranchBody>) =>
    setForm((f) => ({ ...f, ...patch }));

  const save = useMutation({
    mutationFn: async () => {
      const payload: CreateBranchBody = {
        ...form,
        code: form.code.trim(),
        name_ar: form.name_ar.trim(),
        name_en: form.name_en?.trim() || undefined,
        address: form.address?.trim() || undefined,
        phone: form.phone?.trim() || undefined,
      };
      if (mode === 'create') {
        return branchesApi.create(payload);
      }
      return branchesApi.update(branch!.id, payload as UpdateBranchBody);
    },
    onSuccess: () => {
      onSaved(mode === 'create' ? 'تم إنشاء الفرع' : 'تم تحديث الفرع');
    },
    onError: (e: any) => {
      toast.error(e?.response?.data?.message || 'تعذّر الحفظ');
    },
  });

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div
        className="card w-full max-w-md p-4 space-y-3"
        data-testid="branch-form-modal"
      >
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-slate-800">
            {mode === 'create' ? 'فرع جديد' : `تعديل: ${branch?.code}`}
          </h2>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="إغلاق"
          >
            <X size={14} />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs space-y-1">
            <span>الكود</span>
            <input
              className="input"
              value={form.code}
              onChange={(e) => update({ code: e.target.value })}
              data-testid="branch-form-code"
            />
          </label>
          <label className="text-xs space-y-1">
            <span>النوع</span>
            <select
              className="input"
              value={form.type}
              onChange={(e) =>
                update({ type: e.target.value as BranchType })
              }
              data-testid="branch-form-type"
            >
              {BRANCH_TYPES.map((t) => (
                <option key={t} value={t}>
                  {BRANCH_TYPE_LABELS_AR[t]}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs space-y-1 col-span-2">
            <span>الاسم بالعربي</span>
            <input
              className="input"
              value={form.name_ar}
              onChange={(e) => update({ name_ar: e.target.value })}
              data-testid="branch-form-name-ar"
            />
          </label>
          <label className="text-xs space-y-1 col-span-2">
            <span>الاسم بالإنجليزية</span>
            <input
              className="input"
              value={form.name_en ?? ''}
              onChange={(e) => update({ name_en: e.target.value })}
              data-testid="branch-form-name-en"
            />
          </label>
          <label className="text-xs space-y-1 col-span-2">
            <span>العنوان</span>
            <input
              className="input"
              value={form.address ?? ''}
              onChange={(e) => update({ address: e.target.value })}
              data-testid="branch-form-address"
            />
          </label>
          <label className="text-xs space-y-1">
            <span>الهاتف</span>
            <input
              className="input"
              value={form.phone ?? ''}
              onChange={(e) => update({ phone: e.target.value })}
              data-testid="branch-form-phone"
            />
          </label>
          <label className="text-xs flex items-end gap-1">
            <input
              type="checkbox"
              checked={form.is_active ?? true}
              onChange={(e) => update({ is_active: e.target.checked })}
              data-testid="branch-form-active"
            />
            نشط
          </label>
        </div>
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
          <button
            type="button"
            className="btn"
            onClick={onClose}
            disabled={save.isPending}
          >
            إلغاء
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => save.mutate()}
            disabled={save.isPending}
            data-testid="branch-form-save"
          >
            <Check size={14} />
            حفظ الفرع
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Link warehouses to a branch modal ─────────────────────────────
function LinkWarehousesModal({
  branchId,
  allWarehouses,
  onClose,
  onChanged,
}: {
  branchId: string;
  allWarehouses: Warehouse[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const { data: linked = [], isLoading } = useQuery({
    queryKey: ['branch-warehouses', branchId],
    queryFn: () => branchesApi.listWarehouses(branchId),
  });

  const linkedIds = useMemo(
    () => new Set(linked.map((l) => l.id)),
    [linked],
  );

  const link = useMutation({
    mutationFn: (warehouseId: string) =>
      branchesApi.linkWarehouse(branchId, warehouseId),
    onSuccess: () => {
      toast.success('تم ربط المخزن');
      onChanged();
    },
    onError: (e: any) => {
      toast.error(e?.response?.data?.message || 'تعذّر الربط');
    },
  });

  const unlink = useMutation({
    mutationFn: (warehouseId: string) =>
      branchesApi.unlinkWarehouse(branchId, warehouseId),
    onSuccess: () => {
      toast.success('تم فك الربط');
      onChanged();
    },
    onError: (e: any) => {
      toast.error(e?.response?.data?.message || 'تعذّر فك الربط');
    },
  });

  const setPrimary = useMutation({
    mutationFn: (warehouseId: string) =>
      branchesApi.setPrimary(branchId, warehouseId),
    onSuccess: () => {
      toast.success('تم تعيين الفرع الأساسي');
      onChanged();
    },
    onError: (e: any) => {
      toast.error(e?.response?.data?.message || 'تعذّر التعيين');
    },
  });

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div
        className="card w-full max-w-xl p-4 space-y-3 max-h-[85vh] overflow-y-auto"
        data-testid="link-warehouses-modal"
      >
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-slate-800 flex items-center gap-2">
            <Link2 size={15} className="text-indigo-600" />
            ربط المخازن بالفرع
          </h2>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="إغلاق"
          >
            <X size={14} />
          </button>
        </div>

        <div className="space-y-2" data-testid="link-warehouses-linked">
          <h3 className="text-xs font-bold text-slate-500">
            المخازن المرتبطة حاليًا
          </h3>
          {isLoading ? (
            <div className="text-xs text-slate-400">جاري التحميل…</div>
          ) : linked.length === 0 ? (
            <div className="text-xs text-slate-400">
              لا توجد مخازن مرتبطة بهذا الفرع.
            </div>
          ) : (
            <ul className="divide-y divide-slate-100 border border-slate-100 rounded">
              {linked.map((w) => (
                <li
                  key={w.id}
                  className="flex items-center justify-between px-2 py-1.5 text-sm"
                  data-testid="link-warehouses-linked-row"
                >
                  <div>
                    <span className="font-medium text-slate-800">
                      {w.name_ar || w.name || w.code}
                    </span>
                    <span className="text-[10px] text-slate-400 px-2 tabular-nums">
                      {w.code}
                    </span>
                    {w.is_primary && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border border-amber-200 bg-amber-50 text-amber-700">
                        <Star size={9} />
                        أساسي
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    {!w.is_primary && (
                      <button
                        type="button"
                        className="icon-btn"
                        title="تعيين كأساسي"
                        onClick={() => setPrimary.mutate(w.id)}
                        disabled={setPrimary.isPending}
                        data-testid="link-warehouses-set-primary"
                      >
                        <Star size={13} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="icon-btn"
                      title="فك الربط"
                      onClick={() => unlink.mutate(w.id)}
                      disabled={unlink.isPending}
                      data-testid="link-warehouses-unlink"
                    >
                      <Link2Off size={13} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-2" data-testid="link-warehouses-available">
          <h3 className="text-xs font-bold text-slate-500">
            مخازن يمكن ربطها
          </h3>
          {allWarehouses.length === 0 ? (
            <div className="text-xs text-slate-400">لا توجد مخازن.</div>
          ) : (
            <ul className="divide-y divide-slate-100 border border-slate-100 rounded">
              {allWarehouses
                .filter((w) => !linkedIds.has(w.id))
                .map((w) => (
                  <li
                    key={w.id}
                    className="flex items-center justify-between px-2 py-1.5 text-sm"
                    data-testid="link-warehouses-available-row"
                  >
                    <div>
                      <span className="font-medium text-slate-800">
                        {w.name_ar}
                      </span>
                      <span className="text-[10px] text-slate-400 px-2 tabular-nums">
                        {w.code}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => link.mutate(w.id)}
                      disabled={link.isPending}
                      data-testid="link-warehouses-link"
                    >
                      <Link2 size={12} />
                      ربط
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
