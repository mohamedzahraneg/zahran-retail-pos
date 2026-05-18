/**
 * ProductGroups.tsx — PR-P9.1a
 *
 * Manual product groups: list + create/edit + variant membership.
 * Selector-only by design: there is NO Apply button, NO pricing/cost
 * mutation. Group membership feeds into existing assistants/reports
 * in P9.1b; this page only manages the curated list.
 */
import { Fragment, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Plus,
  Pencil,
  Trash2,
  X,
  Tags,
  Search,
  Check,
  AlertTriangle,
} from 'lucide-react';
import {
  productGroupsApi,
  type CreateProductGroupPayload,
  type ProductGroup,
  type ProductGroupMember,
  type UpdateProductGroupPayload,
} from '@/api/productGroups.api';
import { productsApi, type Product, type Variant } from '@/api/products.api';

const EGP = (n: number | string | null | undefined) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

export default function ProductGroups() {
  const qc = useQueryClient();
  const [showInactive, setShowInactive] = useState(false);
  const [listQ, setListQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [editMode, setEditMode] = useState<'create' | 'edit' | null>(null);

  const { data: groups = [], isLoading } = useQuery({
    queryKey: ['product-groups', { q: listQ, is_active: !showInactive }],
    queryFn: () =>
      productGroupsApi.list({
        q: listQ.trim() || undefined,
        is_active: showInactive ? undefined : true,
      }),
  });

  const onApplied = () => {
    qc.invalidateQueries({ queryKey: ['product-groups'] });
    if (openId)
      qc.invalidateQueries({ queryKey: ['product-group', openId] });
  };

  return (
    <div className="space-y-4" dir="rtl" data-testid="product-groups-page">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-black text-slate-800 flex items-center gap-2">
            <Tags className="w-5 h-5 text-emerald-600" />
            مجموعات المنتجات
          </h1>
          <p className="text-xs text-slate-600 mt-1">
            مجموعات يدوية للأصناف — تُستخدم لاحقًا كفلتر في تقارير الأسعار
            ومساعدي تعديل البيع والتكلفة. لا تُطبّق أي تغيير تلقائي على الأسعار
            أو التكلفة أو المخزون.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setEditMode('create')}
          data-testid="product-groups-new"
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-bold bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm"
        >
          <Plus className="w-4 h-4" />
          مجموعة جديدة
        </button>
      </header>

      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="search"
          value={listQ}
          onChange={(e) => setListQ(e.target.value)}
          placeholder="بحث بالاسم"
          data-testid="product-groups-search"
          className="border border-slate-200 rounded-lg px-3 py-2 text-sm w-full md:w-72"
        />
        <label className="flex items-center gap-2 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
            data-testid="product-groups-show-inactive"
          />
          إظهار المجموعات غير النشطة
        </label>
      </div>

      <div className="border rounded-lg overflow-hidden bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 text-xs">
            <tr>
              <th className="p-2 text-right">المجموعة</th>
              <th className="p-2 text-right">الوصف</th>
              <th className="p-2 text-right">الحالة</th>
              <th className="p-2 text-right">عدد الأصناف</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading ? (
              <tr>
                <td colSpan={5} className="p-6 text-center text-slate-400">
                  جاري التحميل…
                </td>
              </tr>
            ) : groups.length === 0 ? (
              <tr>
                <td colSpan={5} className="p-6 text-center text-slate-400">
                  لا توجد مجموعات — أنشئ مجموعتك الأولى بزر "مجموعة جديدة".
                </td>
              </tr>
            ) : (
              groups.map((g) => (
                <Fragment key={g.id}>
                  <tr
                    data-testid={`product-group-row-${g.id}`}
                    className={g.is_active ? '' : 'opacity-60'}
                  >
                    <td className="p-2">
                      <div className="flex items-center gap-2">
                        {g.color ? (
                          <span
                            className="w-3 h-3 rounded-full border border-slate-200"
                            style={{ background: g.color }}
                          />
                        ) : null}
                        <button
                          type="button"
                          onClick={() =>
                            setOpenId(openId === g.id ? null : g.id)
                          }
                          className="font-bold text-emerald-700 hover:underline"
                          data-testid={`product-group-toggle-${g.id}`}
                        >
                          {g.name_ar}
                        </button>
                        {g.name_en && (
                          <span className="text-[11px] text-slate-500">
                            ({g.name_en})
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="p-2 text-slate-600 text-[12px]">
                      {g.description || '—'}
                    </td>
                    <td className="p-2">
                      {g.is_active ? (
                        <span className="inline-block px-2 py-0.5 rounded text-[11px] bg-emerald-100 text-emerald-700 font-bold">
                          نشطة
                        </span>
                      ) : (
                        <span className="inline-block px-2 py-0.5 rounded text-[11px] bg-slate-100 text-slate-600 font-bold">
                          غير نشطة
                        </span>
                      )}
                    </td>
                    <td className="p-2 font-bold">{g.member_count ?? 0}</td>
                    <td className="p-2">
                      <div className="flex items-center gap-1 justify-end">
                        <button
                          type="button"
                          onClick={() => {
                            setOpenId(g.id);
                            setEditMode('edit');
                          }}
                          data-testid={`product-group-edit-${g.id}`}
                          className="icon-btn text-amber-600"
                          title="تعديل"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        {g.is_active && (
                          <DeactivateButton id={g.id} onDone={onApplied} />
                        )}
                      </div>
                    </td>
                  </tr>
                  {openId === g.id && (
                    <tr>
                      <td colSpan={5} className="p-0 bg-slate-50/40">
                        <GroupMembersPanel
                          groupId={g.id}
                          onClose={() => setOpenId(null)}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))
            )}
          </tbody>
        </table>
      </div>

      {editMode === 'create' && (
        <GroupFormModal
          mode="create"
          onClose={() => setEditMode(null)}
          onSaved={(g) => {
            setEditMode(null);
            setOpenId(g.id);
            onApplied();
          }}
        />
      )}
      {editMode === 'edit' && openId && (
        <GroupFormModal
          mode="edit"
          groupId={openId}
          onClose={() => setEditMode(null)}
          onSaved={() => {
            setEditMode(null);
            onApplied();
          }}
        />
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 * Deactivate (soft-delete) button.
 * ────────────────────────────────────────────────────────────────*/
function DeactivateButton({
  id,
  onDone,
}: {
  id: string;
  onDone: () => void;
}) {
  const remove = useMutation({
    mutationFn: () => productGroupsApi.remove(id),
    onSuccess: () => {
      toast.success('تم إلغاء تنشيط المجموعة');
      onDone();
    },
    onError: (e: any) =>
      toast.error(
        e?.response?.data?.message || e?.message || 'فشل إلغاء التنشيط',
      ),
  });
  return (
    <button
      type="button"
      onClick={() => {
        if (
          window.confirm(
            'هل أنت متأكد من إلغاء تنشيط هذه المجموعة؟ يمكن إعادة تنشيطها لاحقًا.',
          )
        ) {
          remove.mutate();
        }
      }}
      disabled={remove.isPending}
      data-testid={`product-group-deactivate-${id}`}
      className="icon-btn text-rose-600 disabled:opacity-50"
      title="إلغاء تنشيط"
    >
      <Trash2 className="w-4 h-4" />
    </button>
  );
}

/* ─────────────────────────────────────────────────────────────────
 * Create/edit modal.
 * ────────────────────────────────────────────────────────────────*/
interface GroupFormModalProps {
  mode: 'create' | 'edit';
  groupId?: string;
  onClose: () => void;
  onSaved: (group: ProductGroup) => void;
}

function GroupFormModal({ mode, groupId, onClose, onSaved }: GroupFormModalProps) {
  const qc = useQueryClient();
  const isEdit = mode === 'edit';
  const { data: detail } = useQuery({
    queryKey: ['product-group', groupId],
    queryFn: () => productGroupsApi.get(groupId!),
    enabled: isEdit && !!groupId,
  });

  const [nameAr, setNameAr] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState('');
  const [isActive, setIsActive] = useState(true);
  const initialized = useMemo(
    () => (isEdit ? !!detail : true),
    [isEdit, detail],
  );

  useMemo(() => {
    if (isEdit && detail) {
      setNameAr(detail.name_ar);
      setNameEn(detail.name_en ?? '');
      setDescription(detail.description ?? '');
      setColor(detail.color ?? '');
      setIsActive(detail.is_active);
    }
  }, [isEdit, detail]);

  const save = useMutation({
    mutationFn: async () => {
      const name = nameAr.trim();
      if (name.length < 1) {
        throw new Error('اسم المجموعة مطلوب');
      }
      if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) {
        throw new Error('اللون يجب أن يكون بصيغة #RRGGBB');
      }
      const body: CreateProductGroupPayload & UpdateProductGroupPayload = {
        name_ar: name,
        name_en: nameEn.trim() || undefined,
        description: description.trim() || undefined,
        color: color.trim() || undefined,
      };
      if (isEdit) {
        const updateBody: UpdateProductGroupPayload = {
          ...body,
          is_active: isActive,
        };
        return productGroupsApi.update(groupId!, updateBody);
      }
      return productGroupsApi.create(body);
    },
    onSuccess: (g) => {
      toast.success(isEdit ? 'تم حفظ التعديل' : 'تم إنشاء المجموعة');
      qc.invalidateQueries({ queryKey: ['product-groups'] });
      onSaved(g);
    },
    onError: (e: any) =>
      toast.error(
        e?.response?.data?.message || e?.message || 'فشل حفظ المجموعة',
      ),
  });

  if (isEdit && !initialized) return null;

  return (
    <div
      className="fixed inset-0 bg-slate-900/50 z-[60] flex items-center justify-center p-4"
      data-testid="product-group-form-modal"
    >
      <div
        className="bg-white rounded-2xl w-full max-w-lg shadow-xl overflow-hidden"
        dir="rtl"
      >
        <div className="p-4 border-b flex items-center justify-between">
          <h3 className="font-black text-slate-800 flex items-center gap-2">
            <Tags className="w-5 h-5 text-emerald-600" />
            {isEdit ? 'تعديل المجموعة' : 'مجموعة جديدة'}
          </h3>
          <button
            type="button"
            onClick={onClose}
            disabled={save.isPending}
            className="icon-btn"
            aria-label="إغلاق"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="text-xs text-slate-600 block mb-1">
              اسم المجموعة (عربي) *
            </label>
            <input
              type="text"
              value={nameAr}
              onChange={(e) => setNameAr(e.target.value)}
              data-testid="product-group-name-ar"
              maxLength={120}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-slate-600 block mb-1">
              الاسم بالإنجليزية (اختياري)
            </label>
            <input
              type="text"
              value={nameEn}
              onChange={(e) => setNameEn(e.target.value)}
              data-testid="product-group-name-en"
              maxLength={120}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-slate-600 block mb-1">
              الوصف (اختياري)
            </label>
            <textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              data-testid="product-group-description"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-600">اللون (اختياري)</label>
            <input
              type="color"
              value={color || '#22c55e'}
              onChange={(e) => setColor(e.target.value)}
              data-testid="product-group-color"
              className="w-10 h-9 rounded border border-slate-200"
            />
            <input
              type="text"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              placeholder="#22c55e"
              className="w-28 border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono"
            />
            {color && (
              <button
                type="button"
                onClick={() => setColor('')}
                className="text-xs text-slate-500 underline"
              >
                مسح
              </button>
            )}
          </div>
          {isEdit && (
            <label className="flex items-center gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                data-testid="product-group-is-active"
              />
              المجموعة نشطة
            </label>
          )}
        </div>
        <div className="p-4 border-t flex justify-end gap-2">
          <button
            type="button"
            className="px-4 py-2 rounded-md text-sm border border-slate-200 hover:bg-slate-50"
            onClick={onClose}
            disabled={save.isPending}
          >
            إلغاء
          </button>
          <button
            type="button"
            onClick={() => save.mutate()}
            data-testid="product-group-save"
            disabled={save.isPending || nameAr.trim().length < 1}
            className="px-4 py-2 rounded-md text-sm font-bold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {save.isPending
              ? 'جاري الحفظ…'
              : isEdit
                ? 'حفظ التعديل'
                : 'إنشاء'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 * Members panel (inline, expands under the group row).
 * ────────────────────────────────────────────────────────────────*/
function GroupMembersPanel({
  groupId,
  onClose,
}: {
  groupId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data: detail, isLoading } = useQuery({
    queryKey: ['product-group', groupId],
    queryFn: () => productGroupsApi.get(groupId),
  });

  return (
    <div className="p-4" data-testid={`product-group-members-${groupId}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs text-slate-600">
          {isLoading ? 'جاري التحميل…' : ' '}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-slate-500 hover:underline"
        >
          إخفاء
        </button>
      </div>
      <AddVariantsRow
        groupId={groupId}
        onAdded={() => qc.invalidateQueries({ queryKey: ['product-group', groupId] })}
        existingVariantIds={(detail?.members ?? []).map((m) => m.variant_id)}
      />
      <MembersTable
        members={detail?.members ?? []}
        groupId={groupId}
        onChanged={() => {
          qc.invalidateQueries({ queryKey: ['product-group', groupId] });
          qc.invalidateQueries({ queryKey: ['product-groups'] });
        }}
      />
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 * Variant search → multi-select → add to group.
 * ────────────────────────────────────────────────────────────────*/
function AddVariantsRow({
  groupId,
  onAdded,
  existingVariantIds,
}: {
  groupId: string;
  onAdded: () => void;
  existingVariantIds: string[];
}) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [expandedProductId, setExpandedProductId] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, true>>({});
  const existingSet = useMemo(
    () => new Set(existingVariantIds),
    [existingVariantIds],
  );

  const searchEnabled = q.trim().length >= 2;
  const { data: searchData } = useQuery({
    queryKey: ['product-groups-search', q],
    queryFn: () =>
      productsApi.list({
        q: q.trim(),
        limit: 30,
      }),
    enabled: searchEnabled,
  });
  const products: Product[] = searchData?.data ?? [];

  const { data: expanded } = useQuery({
    queryKey: ['product-groups-expand', expandedProductId],
    queryFn: () => productsApi.get(expandedProductId!),
    enabled: !!expandedProductId,
  });

  const add = useMutation({
    mutationFn: (variantIds: string[]) =>
      productGroupsApi.addVariants(groupId, { variant_ids: variantIds }),
    onSuccess: (res) => {
      toast.success(
        `تمت إضافة ${res.added} صنفًا${res.skipped > 0 ? ` (تم تخطي ${res.skipped})` : ''}`,
      );
      setPending({});
      qc.invalidateQueries({ queryKey: ['product-groups-expand'] });
      onAdded();
    },
    onError: (e: any) =>
      toast.error(
        e?.response?.data?.message || e?.message || 'فشل إضافة الأصناف',
      ),
  });

  const togglePending = (variantId: string) =>
    setPending((m) => {
      const next = { ...m };
      if (next[variantId]) delete next[variantId];
      else next[variantId] = true;
      return next;
    });

  const pendingCount = Object.keys(pending).length;

  return (
    <section
      className="border border-emerald-100 bg-emerald-50/30 rounded-lg p-3 mb-3 space-y-2"
      data-testid="product-group-add-row"
    >
      <div className="flex items-center gap-2">
        <Search className="w-4 h-4 text-emerald-700" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="ابحث بالاسم أو الباركود لإضافة أصناف"
          data-testid="product-group-add-search"
          className="flex-1 border border-emerald-200 rounded-lg px-3 py-2 text-sm bg-white"
        />
        {pendingCount > 0 && (
          <button
            type="button"
            onClick={() => add.mutate(Object.keys(pending))}
            disabled={add.isPending}
            data-testid="product-group-add-confirm"
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-bold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            <Check className="w-4 h-4" />
            إضافة ({pendingCount})
          </button>
        )}
      </div>

      {searchEnabled && products.length > 0 && (
        <div className="border border-slate-200 rounded-md bg-white overflow-hidden">
          {products.map((p) => {
            const isExpanded = expandedProductId === p.id;
            return (
              <div key={p.id} className="border-b last:border-b-0">
                <button
                  type="button"
                  onClick={() => setExpandedProductId(isExpanded ? null : p.id)}
                  className="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-slate-50"
                  data-testid={`product-group-product-${p.id}`}
                >
                  <span className="font-bold">{p.name_ar}</span>
                  <span className="text-[11px] text-slate-500">
                    {p.variants_count ?? 0} متغيرات
                  </span>
                </button>
                {isExpanded && expanded?.id === p.id && (
                  <div className="border-t bg-slate-50/40">
                    {(expanded.variants ?? []).map((v: Variant) => {
                      const already = existingSet.has(v.id);
                      const checked = !!pending[v.id];
                      return (
                        <label
                          key={v.id}
                          className={`flex items-center gap-3 px-4 py-1.5 text-[12px] ${
                            already ? 'opacity-60' : 'hover:bg-emerald-50/30'
                          }`}
                          data-testid={`product-group-variant-${v.id}`}
                        >
                          <input
                            type="checkbox"
                            disabled={already}
                            checked={checked || already}
                            onChange={() => togglePending(v.id)}
                            data-testid={`product-group-variant-toggle-${v.id}`}
                          />
                          <span className="font-mono text-[11px]">
                            {v.sku ?? '—'}
                          </span>
                          {v.color && (
                            <span className="text-slate-600">{v.color}</span>
                          )}
                          {v.size && (
                            <span className="text-slate-600">{v.size}</span>
                          )}
                          {already && (
                            <span className="ml-auto text-[10px] text-emerald-700">
                              موجود في المجموعة
                            </span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {q.trim().length > 0 && q.trim().length < 2 && (
        <div className="text-[11px] text-slate-500">
          اكتب على الأقل حرفين للبحث.
        </div>
      )}
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────
 * Members table (read + remove).
 * ────────────────────────────────────────────────────────────────*/
function MembersTable({
  members,
  groupId,
  onChanged,
}: {
  members: ProductGroupMember[];
  groupId: string;
  onChanged: () => void;
}) {
  const remove = useMutation({
    mutationFn: (variantId: string) =>
      productGroupsApi.removeVariant(groupId, variantId),
    onSuccess: () => {
      toast.success('تم حذف الصنف من المجموعة');
      onChanged();
    },
    onError: (e: any) =>
      toast.error(
        e?.response?.data?.message || e?.message || 'فشل الحذف',
      ),
  });
  if (members.length === 0) {
    return (
      <div className="text-center text-slate-500 text-sm py-6 bg-white border border-slate-200 rounded-md">
        لا توجد أصناف في هذه المجموعة بعد — أضف من شريط البحث أعلاه.
      </div>
    );
  }
  return (
    <div className="border border-slate-200 rounded-md bg-white overflow-hidden">
      <table className="w-full text-[12px]">
        <thead className="bg-slate-50 text-slate-600">
          <tr>
            <th className="p-2 text-right">الصنف</th>
            <th className="p-2 text-right">SKU</th>
            <th className="p-2 text-right">اللون / المقاس</th>
            <th className="p-2 text-left">التكلفة</th>
            <th className="p-2 text-left">سعر البيع</th>
            <th className="p-2 text-left">المخزون</th>
            <th className="p-2"></th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {members.map((m) => (
            <tr key={m.variant_id} data-testid={`product-group-member-${m.variant_id}`}>
              <td className="p-2">
                <div className="flex items-center gap-2">
                  <span className="font-bold">{m.product_name}</span>
                  {!m.variant_is_active && (
                    <AlertTriangle
                      className="w-3 h-3 text-amber-500"
                      aria-label="الصنف غير نشط"
                    />
                  )}
                </div>
              </td>
              <td className="p-2 font-mono text-[11px]">{m.sku}</td>
              <td className="p-2">
                {[m.color_name, m.size_label].filter(Boolean).join(' / ') || '—'}
              </td>
              <td className="p-2 text-left">
                {EGP(m.current_cost_price)}
              </td>
              <td className="p-2 text-left">
                {EGP(m.current_selling_price)}
              </td>
              <td className="p-2 text-left">
                {m.stock_on_hand.toLocaleString('en-US')}
              </td>
              <td className="p-2">
                <button
                  type="button"
                  onClick={() => remove.mutate(m.variant_id)}
                  disabled={remove.isPending}
                  data-testid={`product-group-member-remove-${m.variant_id}`}
                  className="icon-btn text-rose-600 disabled:opacity-50"
                  title="حذف من المجموعة"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
