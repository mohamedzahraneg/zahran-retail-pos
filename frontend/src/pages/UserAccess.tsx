/**
 * UserAccess.tsx — PR-USER-BRANCH-WAREHOUSE-ACCESS
 *
 * Admin / manager surface to edit a single user's branch & warehouse
 * access. Mounted at `/users/:id/access` so the existing `/users`
 * page is left untouched in this PR.
 *
 * UX:
 *   · Two side-by-side panels (branches / warehouses).
 *   · Each row has a checkbox (allowed?), a select (access_level),
 *     and a radio (is_default).
 *   · Save button posts the full payload to PATCH /users/:id/access.
 *   · Strictly admin-side; no stock surface anywhere.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  ShieldCheck,
  Building2,
  Warehouse as WarehouseIcon,
  ArrowLeft,
  Save,
  type LucideIcon,
} from 'lucide-react';
import {
  accessApi,
  ACCESS_LEVELS,
  ACCESS_LEVEL_LABELS_AR,
  type AccessLevel,
} from '@/api/access.api';
import { branchesApi, type Branch } from '@/api/branches.api';
import { settingsApi, type Warehouse } from '@/api/settings.api';

interface RowDraft {
  selected: boolean;
  level: AccessLevel;
}

export default function UserAccess() {
  const { id } = useParams<{ id: string }>();
  const userId = id ?? '';
  const navigate = useNavigate();
  const qc = useQueryClient();

  // ── load reference data + current access ─────────────────────
  const { data: branches = [] } = useQuery({
    queryKey: ['access-branches-all'],
    queryFn: () => branchesApi.list(true),
    staleTime: 5 * 60_000,
  });
  const { data: warehouses = [] } = useQuery({
    queryKey: ['access-warehouses-all'],
    queryFn: () => settingsApi.listWarehouses(true),
    staleTime: 5 * 60_000,
  });
  const {
    data: access,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ['user-access', userId],
    queryFn: () => accessApi.getUserAccess(userId),
    enabled: Boolean(userId),
  });

  // ── draft state ──────────────────────────────────────────────
  const [branchDrafts, setBranchDrafts] = useState<Record<string, RowDraft>>({});
  const [warehouseDrafts, setWarehouseDrafts] = useState<Record<string, RowDraft>>({});
  const [defaultBranchId, setDefaultBranchId] = useState<string | null>(null);
  const [defaultWarehouseId, setDefaultWarehouseId] = useState<string | null>(null);

  useEffect(() => {
    if (!access) return;
    const b: Record<string, RowDraft> = {};
    for (const row of access.branches) {
      b[row.branch_id] = {
        selected: true,
        level: row.access_level,
      };
    }
    setBranchDrafts(b);
    const w: Record<string, RowDraft> = {};
    for (const row of access.warehouses) {
      w[row.warehouse_id] = {
        selected: true,
        level: row.access_level,
      };
    }
    setWarehouseDrafts(w);
    setDefaultBranchId(access.default_branch_id ?? null);
    setDefaultWarehouseId(access.default_warehouse_id ?? null);
  }, [access]);

  const save = useMutation({
    mutationFn: () => {
      const branch_access = Object.entries(branchDrafts)
        .filter(([, d]) => d.selected)
        .map(([branch_id, d]) => ({ branch_id, access_level: d.level }));
      const warehouse_access = Object.entries(warehouseDrafts)
        .filter(([, d]) => d.selected)
        .map(([warehouse_id, d]) => ({
          warehouse_id,
          access_level: d.level,
        }));
      const branchInList = branch_access.some(
        (b) => b.branch_id === defaultBranchId,
      );
      const warehouseInList = warehouse_access.some(
        (w) => w.warehouse_id === defaultWarehouseId,
      );
      return accessApi.updateUserAccess(userId, {
        branch_access,
        warehouse_access,
        default_branch_id: branchInList ? defaultBranchId : null,
        default_warehouse_id: warehouseInList ? defaultWarehouseId : null,
      });
    },
    onSuccess: () => {
      toast.success('تم حفظ صلاحيات الوصول');
      qc.invalidateQueries({ queryKey: ['user-access', userId] });
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الحفظ'),
  });

  const branchCount = useMemo(
    () => Object.values(branchDrafts).filter((d) => d.selected).length,
    [branchDrafts],
  );
  const warehouseCount = useMemo(
    () => Object.values(warehouseDrafts).filter((d) => d.selected).length,
    [warehouseDrafts],
  );

  return (
    <div className="space-y-4" dir="rtl" data-testid="user-access-page">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="icon-btn"
            onClick={() => navigate('/users')}
            aria-label="رجوع"
            data-testid="user-access-back"
          >
            <ArrowLeft size={14} />
          </button>
          <div>
            <h1 className="text-xl font-black text-slate-800 flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-indigo-600" />
              صلاحيات الوصول
            </h1>
            <p className="text-xs text-slate-500 mt-0.5">
              تحديد الفروع والمخازن المسموحة للمستخدم. لا يؤثر على المخزون أو
              القيود المالية — فقط نطاق الرؤية والعمليات.
            </p>
          </div>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => save.mutate()}
          disabled={save.isPending || isLoading}
          data-testid="user-access-save"
        >
          <Save size={14} />
          {save.isPending ? 'جاري الحفظ…' : 'حفظ التعديلات'}
        </button>
      </header>

      {isError && (
        <div className="card p-4 bg-rose-50 text-rose-800 text-sm">
          {(error as Error)?.message || 'تعذّر تحميل صلاحيات الوصول'}
        </div>
      )}

      {isLoading ? (
        <div className="card p-6 text-center text-sm text-slate-400">
          جاري التحميل…
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <AccessPanel
            icon={Building2}
            title="الفروع"
            countLabel={`${branchCount} مسموح من ${branches.length}`}
            rows={(branches as Branch[]).map((b) => ({
              id: b.id,
              code: b.code,
              name_ar: b.name_ar,
              is_active: b.is_active,
            }))}
            drafts={branchDrafts}
            onToggle={(id, selected) =>
              setBranchDrafts({
                ...branchDrafts,
                [id]: {
                  selected,
                  level: branchDrafts[id]?.level ?? 'view',
                },
              })
            }
            onLevelChange={(id, level) =>
              setBranchDrafts({
                ...branchDrafts,
                [id]: { selected: true, level },
              })
            }
            defaultId={defaultBranchId}
            onDefaultChange={setDefaultBranchId}
            testid="access-branches"
          />
          <AccessPanel
            icon={WarehouseIcon}
            title="المخازن"
            countLabel={`${warehouseCount} مسموح من ${warehouses.length}`}
            rows={(warehouses as Warehouse[]).map((w) => ({
              id: w.id,
              code: w.code,
              name_ar: w.name_ar,
              is_active: w.is_active,
            }))}
            drafts={warehouseDrafts}
            onToggle={(id, selected) =>
              setWarehouseDrafts({
                ...warehouseDrafts,
                [id]: {
                  selected,
                  level: warehouseDrafts[id]?.level ?? 'view',
                },
              })
            }
            onLevelChange={(id, level) =>
              setWarehouseDrafts({
                ...warehouseDrafts,
                [id]: { selected: true, level },
              })
            }
            defaultId={defaultWarehouseId}
            onDefaultChange={setDefaultWarehouseId}
            testid="access-warehouses"
          />
        </div>
      )}
    </div>
  );
}

interface RowItem {
  id: string;
  code: string;
  name_ar: string;
  is_active: boolean;
}

function AccessPanel({
  icon: Icon,
  title,
  countLabel,
  rows,
  drafts,
  onToggle,
  onLevelChange,
  defaultId,
  onDefaultChange,
  testid,
}: {
  icon: LucideIcon;
  title: string;
  countLabel: string;
  rows: RowItem[];
  drafts: Record<string, RowDraft>;
  onToggle: (id: string, selected: boolean) => void;
  onLevelChange: (id: string, level: AccessLevel) => void;
  defaultId: string | null;
  onDefaultChange: (id: string | null) => void;
  testid: string;
}) {
  return (
    <section className="card overflow-hidden" data-testid={testid}>
      <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between gap-2">
        <div className="font-bold text-slate-800 flex items-center gap-2">
          <Icon size={15} className="text-indigo-600" />
          {title}
          <span className="text-[11px] text-slate-400 tabular-nums">
            ({countLabel})
          </span>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th className="text-center px-3 py-2">مسموح</th>
              <th className="text-right px-3 py-2">الكود</th>
              <th className="text-right px-3 py-2">الاسم</th>
              <th className="text-right px-3 py-2">مستوى الوصول</th>
              <th className="text-center px-3 py-2">افتراضي</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => {
              const draft = drafts[r.id] ?? { selected: false, level: 'view' };
              return (
                <tr key={r.id} data-testid={`${testid}-row`}>
                  <td className="px-3 py-2 text-center">
                    <input
                      type="checkbox"
                      checked={draft.selected}
                      onChange={(e) => onToggle(r.id, e.target.checked)}
                      data-testid={`${testid}-toggle-${r.id}`}
                    />
                  </td>
                  <td className="px-3 py-2 font-mono tabular-nums">{r.code}</td>
                  <td className="px-3 py-2">{r.name_ar}</td>
                  <td className="px-3 py-2">
                    <select
                      className="input py-1 text-xs"
                      value={draft.level}
                      onChange={(e) =>
                        onLevelChange(r.id, e.target.value as AccessLevel)
                      }
                      disabled={!draft.selected}
                      data-testid={`${testid}-level-${r.id}`}
                    >
                      {ACCESS_LEVELS.map((lvl) => (
                        <option key={lvl} value={lvl}>
                          {ACCESS_LEVEL_LABELS_AR[lvl]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2 text-center">
                    <input
                      type="radio"
                      checked={defaultId === r.id}
                      onChange={() =>
                        onDefaultChange(
                          defaultId === r.id ? null : r.id,
                        )
                      }
                      disabled={!draft.selected}
                      data-testid={`${testid}-default-${r.id}`}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
