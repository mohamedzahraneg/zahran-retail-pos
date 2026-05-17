/**
 * CostAdjustmentAssistantModal — PR-PURCHASES-P3.6A
 *
 * Three-step bulk cost-adjustment assistant:
 *   1. Pick scope (selected / filtered / all) + adjustment type + value.
 *   2. Server-side preview → per-row apply/skip checkboxes.
 *   3. Reason + explicit "no GL / no revaluation" confirmation → apply.
 *
 * COST-REFERENCE-ONLY by design — the assistant updates ONLY
 * product_variants.cost_price and inserts variant_cost_history audit
 * rows. It does NOT post a journal entry, does NOT touch inventory
 * ledgers (stock.*, stock_movements), does NOT change historical
 * invoice_items.unit_cost, does NOT change selling_price, and does
 * NOT touch supplier ledgers. The new reference cost only affects
 * the NEXT sale's COGS basis.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { AlertTriangle, ShieldAlert, Coins, X } from 'lucide-react';
import {
  productsApi,
  type CostAdjustmentApplyPayload,
  type CostAdjustmentFilters,
  type CostAdjustmentPreviewItem,
  type CostAdjustmentPreviewPayload,
  type CostAdjustmentPreviewResponse,
  type CostAdjustmentScopeType,
  type CostAdjustmentType,
} from '@/api/products.api';

const EGP = (n: number | string | null | undefined) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

const PCT = (n: number | null | undefined) =>
  n == null
    ? '—'
    : `${Number(n).toLocaleString('en-US', {
        minimumFractionDigits: 1,
        maximumFractionDigits: 2,
      })}%`;

const TYPE_LABEL_AR: Record<CostAdjustmentType, string> = {
  fixed_increase: 'زيادة بقيمة ثابتة ج.م',
  fixed_decrease: 'تخفيض بقيمة ثابتة ج.م',
  percent_increase: 'زيادة بنسبة %',
  percent_decrease: 'تخفيض بنسبة %',
  set_exact: 'تعيين قيمة تكلفة محددة ج.م',
};

const TYPE_UNIT: Record<CostAdjustmentType, string> = {
  fixed_increase: 'ج.م',
  fixed_decrease: 'ج.م',
  percent_increase: '%',
  percent_decrease: '%',
  set_exact: 'ج.م',
};

export interface CostAdjustmentScopeContext {
  selectedVariantIds: string[];
  filters?: CostAdjustmentFilters;
}

export interface CostAdjustmentAssistantModalProps {
  open: boolean;
  context: CostAdjustmentScopeContext;
  onClose: () => void;
  onApplied: (appliedVariantIds: string[]) => void;
}

type Step = 'config' | 'preview' | 'apply';

export function CostAdjustmentAssistantModal({
  open,
  context,
  onClose,
  onApplied,
}: CostAdjustmentAssistantModalProps) {
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>('config');
  const [scopeKey, setScopeKey] = useState<CostAdjustmentScopeType>('selected');
  const [adjustmentType, setAdjustmentType] =
    useState<CostAdjustmentType>('percent_increase');
  const [adjustmentValue, setAdjustmentValue] = useState<string>('');
  const [reason, setReason] = useState('');
  const [acknowledgeRefOnly, setAcknowledgeRefOnly] = useState(false);
  const [preview, setPreview] = useState<CostAdjustmentPreviewResponse | null>(
    null,
  );
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    setStep('config');
    setReason('');
    setAcknowledgeRefOnly(false);
    setPreview(null);
    setExcludedIds(new Set());
    setAdjustmentType('percent_increase');
    setAdjustmentValue('');
    if (context.selectedVariantIds.length > 0) setScopeKey('selected');
    else if (context.filters && Object.keys(context.filters).length > 0)
      setScopeKey('filtered');
    else setScopeKey('all');
  }, [open, context]);

  const valueNum = Number(adjustmentValue);
  const valueValid =
    Number.isFinite(valueNum)
    && valueNum >= 0
    && (adjustmentType === 'set_exact' || valueNum > 0)
    && (!(adjustmentType === 'percent_increase'
      || adjustmentType === 'percent_decrease')
      || valueNum <= 500);

  const friendlyError = (e: any, fallback: string): string => {
    const msg = e?.message ?? '';
    const code = e?.code;
    if (code === 'ECONNABORTED' || /timeout of \d+ms exceeded/i.test(msg)) {
      return 'انتهت مهلة الطلب. قلّل عدد الأصناف أو ضيّق الفلتر ثم حاول مرة أخرى.';
    }
    return e?.response?.data?.message ?? msg ?? fallback;
  };

  const buildPreviewPayload = (): CostAdjustmentPreviewPayload => {
    const payload: CostAdjustmentPreviewPayload = {
      scope: scopeKey,
      adjustment_type: adjustmentType,
      adjustment_value: valueNum,
      limit: 1000,
    };
    if (scopeKey === 'selected') {
      payload.variant_ids = context.selectedVariantIds;
    } else if (scopeKey === 'filtered') {
      payload.filters = context.filters ?? {};
    }
    return payload;
  };

  const previewMut = useMutation({
    mutationFn: (payload: CostAdjustmentPreviewPayload) =>
      productsApi.costAdjustmentPreview(payload),
    onSuccess: (res) => {
      setPreview(res);
      setExcludedIds(new Set());
      setStep('preview');
    },
    onError: (e: any) => {
      toast.error(friendlyError(e, 'فشل توليد معاينة التكلفة'));
    },
  });

  const applyMut = useMutation({
    mutationFn: (payload: CostAdjustmentApplyPayload) =>
      productsApi.costAdjustmentApply(payload),
    onSuccess: (res) => {
      const msg =
        res.updated > 0
          ? `تم تعديل تكلفة ${res.updated} صنف — تم تخطي ${res.skipped}.`
          : 'لم يتم تعديل أي صنف — راجع المعاينة.';
      toast.success(msg);
      qc.invalidateQueries({ queryKey: ['pricing-health'] });
      qc.invalidateQueries({ queryKey: ['pricing-losses'] });
      qc.invalidateQueries({ queryKey: ['pricing-history'] });
      qc.invalidateQueries({ queryKey: ['pricing-landed-impact'] });
      qc.invalidateQueries({ queryKey: ['sold-profit-summary'] });
      qc.invalidateQueries({ queryKey: ['sold-profit-products'] });
      qc.invalidateQueries({ queryKey: ['sold-profit-invoices'] });
      qc.invalidateQueries({ queryKey: ['products'] });
      onApplied(res.items.map((r) => r.variant_id));
      onClose();
    },
    onError: (e: any) => {
      const status = e?.response?.status;
      if (status === 403) {
        toast.error('ليس لديك صلاحية تعديل التكلفة بشكل جماعي.');
      } else {
        toast.error(friendlyError(e, 'فشل تطبيق التكلفة'));
      }
    },
  });

  const applicableItems = useMemo<CostAdjustmentPreviewItem[]>(
    () =>
      (preview?.items ?? []).filter(
        (i) =>
          Math.abs(i.new_cost_price - i.current_cost_price) >= 0.01
          && !excludedIds.has(i.variant_id),
      ),
    [preview, excludedIds],
  );

  const APPLY_BATCH_MAX = 500;
  const applyExceedsBatch = applicableItems.length > APPLY_BATCH_MAX;

  if (!open) return null;

  const scopeOptions: {
    key: CostAdjustmentScopeType;
    label: string;
    disabled?: boolean;
    hint: string;
  }[] = [
    {
      key: 'selected',
      label: `الأصناف المختارة (${context.selectedVariantIds.length})`,
      disabled: context.selectedVariantIds.length === 0,
      hint: 'الأصناف المختارة من قائمة التقرير.',
    },
    {
      key: 'filtered',
      label: 'نتائج الفلتر الحالي',
      disabled: !context.filters || Object.keys(context.filters).length === 0,
      hint: 'كل الأصناف الظاهرة في التقرير حسب الفلتر الحالي.',
    },
    {
      key: 'all',
      label: 'كل الأصناف النشطة',
      hint: 'يحتاج تأكيد إضافي قبل التطبيق.',
    },
  ];

  const runPreview = () => {
    if (!valueValid) {
      toast.error('قيمة التعديل غير صالحة');
      return;
    }
    previewMut.mutate(buildPreviewPayload());
  };

  const runApply = () => {
    if (reason.trim().length < 3) {
      toast.error('سبب التعديل مطلوب (3 أحرف على الأقل)');
      return;
    }
    if (!acknowledgeRefOnly) {
      toast.error('يجب الإقرار بأن هذا التعديل تكلفة مرجعية فقط');
      return;
    }
    if (applyExceedsBatch) {
      toast.error('عدد الأصناف كبير جدًا. طبّق على دفعات أصغر.');
      return;
    }
    if (applicableItems.length === 0) {
      toast.error('لا توجد أصناف ضمن التطبيق.');
      return;
    }
    const payload: CostAdjustmentApplyPayload = {
      scope: scopeKey,
      adjustment_type: adjustmentType,
      adjustment_value: valueNum,
      reason: reason.trim(),
      variant_ids_to_apply: applicableItems.map((i) => i.variant_id),
    };
    if (scopeKey === 'selected') {
      payload.variant_ids = context.selectedVariantIds;
    } else if (scopeKey === 'filtered') {
      payload.filters = context.filters ?? {};
    }
    applyMut.mutate(payload);
  };

  const toggleExclude = (variantId: string) => {
    setExcludedIds((prev) => {
      const next = new Set(prev);
      if (next.has(variantId)) next.delete(variantId);
      else next.add(variantId);
      return next;
    });
  };

  return (
    <div
      className="fixed inset-0 bg-slate-900/50 z-[60] flex items-center justify-center p-4"
      data-testid="cost-adjust-modal"
    >
      <div
        className="bg-white rounded-2xl w-full max-w-5xl shadow-xl max-h-[95vh] overflow-hidden flex flex-col"
        dir="rtl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b flex items-center justify-between">
          <div>
            <h3 className="font-black text-slate-800 flex items-center gap-2">
              <Coins className="w-5 h-5 text-emerald-600" />
              مساعد تعديل التكلفة
            </h3>
            <p
              className="text-[11px] text-slate-600 mt-1 leading-relaxed"
              data-testid="cost-adjust-ref-only-note"
            >
              تكلفة مرجعية فقط — لا يتم إنشاء قيد محاسبي ولا تعديل قيمة المخزون
              ولا تغيير مرتجعات/فواتير سابقة. التعديل يؤثر فقط على بيع
              الأصناف من الآن فصاعدًا.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={previewMut.isPending || applyMut.isPending}
            className="icon-btn"
            aria-label="إغلاق"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 overflow-y-auto flex-1 space-y-4">
          {step === 'config' && (
            <div className="space-y-4" data-testid="cost-adjust-step-config">
              <section>
                <h4 className="font-bold text-slate-800 mb-2">
                  الخطوة 1 — اختر النطاق
                </h4>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                  {scopeOptions.map((opt) => (
                    <label
                      key={opt.key}
                      className={`block rounded-lg border p-3 cursor-pointer ${
                        scopeKey === opt.key
                          ? 'border-emerald-500 bg-emerald-50/40'
                          : 'border-slate-200 hover:bg-slate-50'
                      } ${opt.disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      <input
                        type="radio"
                        name="cost-scope"
                        value={opt.key}
                        checked={scopeKey === opt.key}
                        disabled={opt.disabled}
                        onChange={() => setScopeKey(opt.key)}
                        className="ml-2"
                        data-testid={`cost-adjust-scope-${opt.key}`}
                      />
                      <span className="font-bold text-sm text-slate-800">
                        {opt.label}
                      </span>
                      <div className="text-[11px] text-slate-600 mt-1">
                        {opt.hint}
                      </div>
                    </label>
                  ))}
                </div>
              </section>

              <section className="space-y-3">
                <h4 className="font-bold text-slate-800">
                  الخطوة 2 — نوع التعديل وقيمته
                </h4>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    نوع التعديل
                  </label>
                  <select
                    value={adjustmentType}
                    onChange={(e) =>
                      setAdjustmentType(e.target.value as CostAdjustmentType)
                    }
                    className="w-full rounded-md border-slate-200 text-sm"
                    data-testid="cost-adjust-type"
                  >
                    {(Object.keys(TYPE_LABEL_AR) as CostAdjustmentType[]).map(
                      (t) => (
                        <option key={t} value={t}>
                          {TYPE_LABEL_AR[t]}
                        </option>
                      ),
                    )}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    القيمة ({TYPE_UNIT[adjustmentType]})
                  </label>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={adjustmentValue}
                    onChange={(e) => setAdjustmentValue(e.target.value)}
                    className="w-full rounded-md border-slate-200 text-sm"
                    placeholder={
                      adjustmentType.startsWith('percent')
                        ? 'مثال: 10 للنسبة 10%'
                        : 'مثال: 50'
                    }
                    data-testid="cost-adjust-value"
                  />
                  {(adjustmentType === 'percent_increase'
                    || adjustmentType === 'percent_decrease') && (
                    <p className="text-[11px] text-slate-500 mt-1">
                      النسبة لا يمكن أن تتجاوز 500%.
                    </p>
                  )}
                </div>
              </section>

              <div className="flex justify-end gap-2 border-t pt-3">
                <button
                  type="button"
                  className="px-4 py-2 rounded-md text-sm border border-slate-200 hover:bg-slate-50"
                  onClick={onClose}
                  disabled={previewMut.isPending}
                >
                  إلغاء
                </button>
                <button
                  type="button"
                  className="px-4 py-2 rounded-md text-sm font-bold bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50"
                  disabled={
                    !valueValid
                    || previewMut.isPending
                    || (scopeKey === 'selected'
                      && context.selectedVariantIds.length === 0)
                  }
                  onClick={runPreview}
                  data-testid="cost-adjust-run-preview"
                >
                  {previewMut.isPending ? 'جاري الحساب…' : 'توليد المعاينة'}
                </button>
              </div>
            </div>
          )}

          {step === 'preview' && preview && (
            <div className="space-y-4" data-testid="cost-adjust-step-preview">
              <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-[12px] text-amber-900 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <div>
                  هذه تكلفة مرجعية — قيمة المخزون التقديرية بعد التغيير
                  استرشادية فقط ولن تُنشئ أي قيد محاسبي أو حركة مخزون. حركة
                  المبيعات السابقة ومرتجعاتها لن تتأثر.
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-center">
                <SummaryTile
                  label="إجمالي المطابقات"
                  value={preview.summary.total_candidates.toLocaleString(
                    'en-US',
                  )}
                />
                <SummaryTile
                  label="ضمن المعاينة"
                  value={preview.summary.returned_count.toLocaleString('en-US')}
                />
                <SummaryTile
                  label="متوسط نسبة التغيير"
                  value={PCT(preview.summary.avg_delta_pct)}
                />
                <SummaryTile
                  label="فرق قيمة المخزون (استرشادي)"
                  value={EGP(
                    preview.summary.total_inventory_value_after_reference_only
                      - preview.summary.total_inventory_value_before,
                  )}
                  testId="cost-adjust-inventory-delta"
                />
              </div>

              {preview.summary.truncated && preview.summary.message_ar && (
                <div
                  className="rounded-md border border-amber-300 bg-amber-50 p-2 text-[12px] text-amber-800"
                  data-testid="cost-adjust-truncated"
                >
                  {preview.summary.message_ar}
                </div>
              )}

              {applyExceedsBatch && (
                <div
                  className="rounded-md border border-rose-300 bg-rose-50 p-2 text-[12px] text-rose-800"
                  data-testid="cost-adjust-batch-warn"
                >
                  عدد الأصناف ضمن التطبيق ({applicableItems.length}) يتجاوز الحد
                  ({APPLY_BATCH_MAX}). استبعد بعض الأصناف أو طبّق على دفعات.
                </div>
              )}

              <div className="border rounded-lg overflow-hidden">
                <div className="max-h-[40vh] overflow-y-auto">
                  <table className="w-full text-[12px]">
                    <thead className="bg-slate-50 text-slate-600 sticky top-0">
                      <tr>
                        <th className="p-2 text-right w-8"></th>
                        <th className="p-2 text-right">الصنف</th>
                        <th className="p-2 text-right">SKU</th>
                        <th className="p-2 text-left">التكلفة الحالية</th>
                        <th className="p-2 text-left">التكلفة الجديدة</th>
                        <th className="p-2 text-left">الفرق</th>
                        <th className="p-2 text-left">المخزون</th>
                        <th className="p-2 text-right">ملاحظات</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.items.map((it) => {
                        const noChange =
                          Math.abs(it.new_cost_price - it.current_cost_price)
                          < 0.01;
                        const excluded = excludedIds.has(it.variant_id);
                        return (
                          <tr
                            key={it.variant_id}
                            className={
                              noChange || excluded
                                ? 'bg-slate-50 text-slate-400'
                                : ''
                            }
                            data-testid={`cost-adjust-row-${it.variant_id}`}
                          >
                            <td className="p-2 text-right">
                              <input
                                type="checkbox"
                                checked={!noChange && !excluded}
                                disabled={noChange}
                                onChange={() => toggleExclude(it.variant_id)}
                                data-testid={`cost-adjust-include-${it.variant_id}`}
                              />
                            </td>
                            <td className="p-2 text-right font-bold">
                              {it.product_name}
                            </td>
                            <td className="p-2 text-right font-mono text-[11px]">
                              {it.sku}
                            </td>
                            <td className="p-2 text-left">
                              {EGP(it.current_cost_price)}
                            </td>
                            <td className="p-2 text-left font-bold">
                              {EGP(it.new_cost_price)}
                            </td>
                            <td
                              className={`p-2 text-left ${
                                it.delta_amount > 0
                                  ? 'text-emerald-700'
                                  : it.delta_amount < 0
                                    ? 'text-rose-700'
                                    : ''
                              }`}
                            >
                              {EGP(it.delta_amount)}{' '}
                              <span className="text-[10px]">
                                ({PCT(it.delta_pct)})
                              </span>
                            </td>
                            <td className="p-2 text-left">
                              {it.stock_on_hand.toLocaleString('en-US')}
                            </td>
                            <td className="p-2 text-right text-[11px] text-amber-700">
                              {it.warning ?? ''}
                            </td>
                          </tr>
                        );
                      })}
                      {preview.items.length === 0 && (
                        <tr>
                          <td
                            colSpan={8}
                            className="p-6 text-center text-slate-500"
                          >
                            لا توجد أصناف في هذه المعاينة.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="flex justify-between items-center border-t pt-3 gap-2">
                <button
                  type="button"
                  className="px-4 py-2 rounded-md text-sm border border-slate-200 hover:bg-slate-50"
                  onClick={() => setStep('config')}
                >
                  رجوع
                </button>
                <button
                  type="button"
                  className="px-4 py-2 rounded-md text-sm font-bold bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50"
                  disabled={applicableItems.length === 0 || applyExceedsBatch}
                  onClick={() => setStep('apply')}
                  data-testid="cost-adjust-go-apply"
                >
                  متابعة للتطبيق ({applicableItems.length})
                </button>
              </div>
            </div>
          )}

          {step === 'apply' && preview && (
            <div className="space-y-4" data-testid="cost-adjust-step-apply">
              <div className="rounded-lg bg-rose-50 border border-rose-200 p-3 text-[12px] text-rose-900 flex items-start gap-2">
                <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                <div>
                  هذا التعديل يكتب فقط في <b>product_variants.cost_price</b>
                  ويضيف سجلًا في <b>variant_cost_history</b>. لا يُنشئ قيد
                  محاسبي، ولا يُعدّل قيمة المخزون أو حركة المخزون أو حساب
                  المورد، ولا يُعدّل التكلفة على أي فاتورة سابقة.
                </div>
              </div>

              <div className="rounded-md border border-slate-200 p-3 bg-slate-50/50 text-[12px]">
                سيتم تعديل تكلفة <b>{applicableItems.length}</b> صنف. عند
                التطبيق سيتم تجميع كل السجلات تحت رقم دفعة واحد للتدقيق.
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  سبب التعديل (مطلوب — 3 أحرف على الأقل)
                </label>
                <textarea
                  rows={3}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="w-full rounded-md border-slate-200 text-sm"
                  placeholder="مثال: تحديث قائمة أسعار المورد ﻿شهر 5/2026"
                  data-testid="cost-adjust-reason"
                />
              </div>

              <label className="flex items-start gap-2 text-[12px] text-slate-700">
                <input
                  type="checkbox"
                  checked={acknowledgeRefOnly}
                  onChange={(e) => setAcknowledgeRefOnly(e.target.checked)}
                  className="mt-0.5"
                  data-testid="cost-adjust-ack"
                />
                <span>
                  أُقر بأن هذا التعديل هو تكلفة مرجعية فقط ولا يُنشئ قيدًا
                  محاسبيًا ولا يُعيد تقييم المخزون ولا يُغيّر الفواتير أو
                  المرتجعات السابقة.
                </span>
              </label>

              <div className="flex justify-between items-center border-t pt-3 gap-2">
                <button
                  type="button"
                  className="px-4 py-2 rounded-md text-sm border border-slate-200 hover:bg-slate-50"
                  onClick={() => setStep('preview')}
                  disabled={applyMut.isPending}
                >
                  رجوع للمعاينة
                </button>
                <button
                  type="button"
                  className="px-4 py-2 rounded-md text-sm font-bold bg-rose-600 hover:bg-rose-700 text-white disabled:opacity-50"
                  disabled={
                    applyMut.isPending
                    || !acknowledgeRefOnly
                    || reason.trim().length < 3
                    || applicableItems.length === 0
                    || applyExceedsBatch
                  }
                  onClick={runApply}
                  data-testid="cost-adjust-confirm-apply"
                >
                  {applyMut.isPending ? 'جاري التطبيق…' : 'تطبيق التعديل'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SummaryTile({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId?: string;
}) {
  return (
    <div
      className="rounded-lg bg-slate-50 border border-slate-200 p-3"
      data-testid={testId}
    >
      <div className="text-[11px] text-slate-600">{label}</div>
      <div className="text-base font-black text-slate-800 mt-0.5">{value}</div>
    </div>
  );
}
