/**
 * LandedCostsSection — PR-PURCHASES-P2.2
 *
 * Operator-facing UI for the per-purchase extra costs (نقل / عمالة /
 * شحن / جمارك / تغليف / أخرى). Sits inside CreatePurchaseModal after
 * the items section and before the legacy shipping/discount/tax row.
 *
 * The component is a CONTROLLED form: parent owns the
 * `Array<ExtraCostRow>` state; we render rows, mutate via callbacks,
 * and let the parent compute the preview math (via landedCostMath).
 * Validation errors keyed by row index are passed in so the parent
 * can disable the save button when manual allocation mismatches.
 *
 * Backend remains source of truth — this UI only previews; the same
 * allocator runs server-side at save time.
 */
import { Plus, Trash2 } from 'lucide-react';
import type {
  AllocationMethod,
  ExtraCostType,
  ManualAllocationPayload,
} from '@/api/purchases.api';
import {
  ALLOC_METHOD_LABEL,
  ALLOC_METHOD_OPTIONS,
  COST_TYPE_LABEL,
  COST_TYPE_OPTIONS,
} from './landedCostLabels';
import { createEmptyExtraCostRow, type ExtraCostRow } from './landedCostState';

const EGP = (n: number | string | null | undefined) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

export interface LandedCostsSectionLine {
  variant_id: string;
  display: string;
  quantity: number;
  base_unit_cost: number;
}

export interface LandedCostsSectionProps {
  rows: ExtraCostRow[];
  lines: LandedCostsSectionLine[];
  /** Sum of capitalized rows (from the parent's computed preview). */
  capitalizedTotal: number;
  /** Sum of non-capitalized rows (from the preview). */
  nonCapitalizedTotal: number;
  /** Validation errors keyed by row index. */
  errors: Record<number, string>;
  onChange: (next: ExtraCostRow[]) => void;
}

export function LandedCostsSection({
  rows,
  lines,
  capitalizedTotal,
  nonCapitalizedTotal,
  errors,
  onChange,
}: LandedCostsSectionProps) {
  const noLines = lines.length === 0;

  const addRow = () => {
    onChange([
      ...rows,
      { ...createEmptyExtraCostRow(), sort_order: rows.length },
    ]);
  };

  const removeRow = (idx: number) => {
    const next = rows.filter((_, i) => i !== idx).map((r, i) => ({
      ...r,
      sort_order: i,
    }));
    onChange(next);
  };

  const patchRow = (idx: number, patch: Partial<ExtraCostRow>) => {
    const next = rows.map((r, i) => (i === idx ? { ...r, ...patch } : r));
    onChange(next);
  };

  const patchManualAllocation = (
    idx: number,
    variant_id: string,
    amount: number,
  ) => {
    const row = rows[idx];
    const existing = row.manual_allocations ?? [];
    let found = false;
    const updated: ManualAllocationPayload[] = existing.map((m) => {
      if (m.variant_id === variant_id) {
        found = true;
        return { ...m, amount };
      }
      return m;
    });
    if (!found && amount > 0) updated.push({ variant_id, amount });
    patchRow(idx, {
      manual_allocations: updated.filter((m) => m.amount > 0 || m.amount === 0),
    });
  };

  return (
    <section
      data-testid="landed-costs-section"
      className="rounded-xl border border-slate-200 bg-white p-3 space-y-3"
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h3 className="font-bold text-slate-700">مصاريف إضافية على الفاتورة</h3>
          <p className="text-xs text-slate-500">
            مصاريف الشحن الحالية منفصلة. استخدم المصاريف الإضافية إذا أردت
            توزيعها على تكلفة المنتجات.
          </p>
        </div>
        <button
          type="button"
          onClick={addRow}
          className="btn-primary text-xs"
          data-testid="landed-costs-add-row"
          disabled={noLines}
          title={noLines ? 'أضف صنفاً واحداً على الأقل أولاً' : ''}
        >
          <Plus className="w-3.5 h-3.5" />
          إضافة مصروف
        </button>
      </div>

      {noLines && rows.length === 0 ? (
        <div
          data-testid="landed-costs-empty-hint"
          className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded p-2"
        >
          أضف الأصناف أولاً، ثم يمكنك إضافة مصاريف وتوزيعها.
        </div>
      ) : null}

      {rows.length === 0 ? null : (
        <div className="space-y-2">
          {rows.map((r, idx) => {
            const cap = r.capitalize_to_inventory !== false;
            const allocMethod: AllocationMethod = r.allocation_method ?? 'by_value';
            const err = errors[idx];
            return (
              <div
                key={r._key}
                data-testid={`landed-cost-row-${idx}`}
                className="rounded-md border border-slate-200 p-2 space-y-2 bg-slate-50/40"
              >
                <div className="grid grid-cols-1 md:grid-cols-6 gap-2 items-end">
                  <div>
                    <label className="label text-[10px]">النوع</label>
                    <select
                      className="input"
                      value={r.cost_type}
                      onChange={(e) =>
                        patchRow(idx, {
                          cost_type: e.target.value as ExtraCostType,
                        })
                      }
                      data-testid={`landed-cost-type-${idx}`}
                    >
                      {COST_TYPE_OPTIONS.map((t) => (
                        <option key={t} value={t}>
                          {COST_TYPE_LABEL[t]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="md:col-span-2">
                    <label className="label text-[10px]">الوصف / البيان</label>
                    <input
                      type="text"
                      className="input"
                      value={r.label ?? ''}
                      onChange={(e) => patchRow(idx, { label: e.target.value })}
                      placeholder={COST_TYPE_LABEL[r.cost_type]}
                    />
                  </div>
                  <div>
                    <label className="label text-[10px]">المبلغ</label>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      className="input"
                      value={r.amount}
                      onChange={(e) =>
                        patchRow(idx, { amount: Number(e.target.value) || 0 })
                      }
                      data-testid={`landed-cost-amount-${idx}`}
                    />
                  </div>
                  <div>
                    <label className="label text-[10px]">يدخل في تكلفة المنتج؟</label>
                    <label className="flex items-center gap-2 text-xs py-2">
                      <input
                        type="checkbox"
                        checked={cap}
                        onChange={(e) =>
                          patchRow(idx, {
                            capitalize_to_inventory: e.target.checked,
                          })
                        }
                        data-testid={`landed-cost-capitalize-${idx}`}
                      />
                      <span>{cap ? 'نعم' : 'لا'}</span>
                    </label>
                  </div>
                  <div className="flex md:justify-end">
                    <button
                      type="button"
                      onClick={() => removeRow(idx)}
                      className="icon-btn text-rose-500"
                      data-testid={`landed-cost-remove-${idx}`}
                      aria-label="حذف"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {cap ? (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                    <div>
                      <label className="label text-[10px]">طريقة التوزيع</label>
                      <select
                        className="input"
                        value={allocMethod}
                        onChange={(e) =>
                          patchRow(idx, {
                            allocation_method: e.target
                              .value as AllocationMethod,
                          })
                        }
                        data-testid={`landed-cost-method-${idx}`}
                      >
                        {ALLOC_METHOD_OPTIONS.map((m) => (
                          <option key={m} value={m}>
                            {ALLOC_METHOD_LABEL[m]}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="md:col-span-2">
                      <label className="label text-[10px]">ملاحظات</label>
                      <input
                        type="text"
                        className="input"
                        value={r.notes ?? ''}
                        onChange={(e) =>
                          patchRow(idx, { notes: e.target.value })
                        }
                      />
                    </div>
                  </div>
                ) : (
                  <div className="text-[11px] text-slate-500">
                    لا يدخل في تكلفة المنتج — يُسجَّل كمصروف منفصل ولا يؤثر على
                    تكلفة القطعة.
                  </div>
                )}

                {cap && allocMethod === 'manual' ? (
                  <ManualAllocationSubTable
                    rowIdx={idx}
                    lines={lines}
                    amount={Number(r.amount || 0)}
                    manualAllocations={r.manual_allocations ?? []}
                    onChange={(variant_id, amount) =>
                      patchManualAllocation(idx, variant_id, amount)
                    }
                  />
                ) : null}

                {err ? (
                  <div
                    data-testid={`landed-cost-error-${idx}`}
                    className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-1.5"
                  >
                    {err}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {rows.length > 0 ? (
        <div
          data-testid="landed-costs-subtotals"
          className="grid grid-cols-2 gap-2 text-xs pt-1 border-t border-slate-200"
        >
          <div className="rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200 p-2">
            <div className="text-[10px] text-slate-500 mb-0.5">
              إجمالي المصاريف المحملة
            </div>
            <div className="font-bold">{EGP(capitalizedTotal)}</div>
          </div>
          <div className="rounded-md bg-slate-50 text-slate-700 border border-slate-200 p-2">
            <div className="text-[10px] text-slate-500 mb-0.5">
              إجمالي المصاريف غير المحملة
            </div>
            <div className="font-bold">{EGP(nonCapitalizedTotal)}</div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

interface ManualAllocationSubTableProps {
  rowIdx: number;
  lines: LandedCostsSectionLine[];
  amount: number;
  manualAllocations: ManualAllocationPayload[];
  onChange: (variant_id: string, amount: number) => void;
}

function ManualAllocationSubTable({
  rowIdx,
  lines,
  amount,
  manualAllocations,
  onChange,
}: ManualAllocationSubTableProps) {
  const byVariant = new Map(manualAllocations.map((m) => [m.variant_id, m.amount]));
  const allocated = +manualAllocations
    .reduce((s, m) => s + Number(m.amount || 0), 0)
    .toFixed(2);
  const remaining = +(amount - allocated).toFixed(2);
  const mismatch = Math.abs(remaining) > 0.01;

  return (
    <div
      className="rounded-md border border-slate-200 bg-white p-2 space-y-1.5"
      data-testid={`landed-cost-manual-${rowIdx}`}
    >
      <table className="w-full text-xs">
        <thead className="text-slate-500">
          <tr>
            <th className="p-1 text-right">الصنف</th>
            <th className="p-1 text-right">الكمية</th>
            <th className="p-1 text-right">المبلغ المخصص</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {lines.map((l) => (
            <tr key={l.variant_id}>
              <td className="p-1">{l.display}</td>
              <td className="p-1">{l.quantity}</td>
              <td className="p-1">
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  className="input"
                  value={byVariant.get(l.variant_id) ?? 0}
                  onChange={(e) =>
                    onChange(l.variant_id, Number(e.target.value) || 0)
                  }
                  data-testid={`landed-cost-manual-input-${rowIdx}-${l.variant_id}`}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div
        data-testid={`landed-cost-manual-summary-${rowIdx}`}
        className={`text-xs font-bold ${mismatch ? 'text-rose-700' : 'text-emerald-700'}`}
      >
        الموزع: {EGP(allocated)} / {EGP(amount)}
        {' · '}
        المتبقي: {EGP(remaining)}
      </div>
    </div>
  );
}
