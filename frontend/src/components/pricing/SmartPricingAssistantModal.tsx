/**
 * SmartPricingAssistantModal — PR-PURCHASES-P3.5A
 *
 * Three-step bulk pricing assistant:
 *   1. Pick scope (selected / filtered / all / single).
 *   2. Pick strategy (conservative / balanced / aggressive / clearance).
 *   3. Server-side preview → per-row apply/skip checkboxes → apply.
 *
 * Pricing-only by design — applies only to product_variants.selling_price.
 * Cost changes are deferred to P3.5B.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { productGroupsApi } from '@/api/productGroups.api';
import toast from 'react-hot-toast';
import {
  CheckCircle2,
  X,
  Sparkles,
  AlertTriangle,
} from 'lucide-react';
import {
  productsApi,
  type ManualAdjustment,
  type ManualAdjustmentOperation,
  type SmartPricingApplyPayload,
  type SmartPricingItem,
  type SmartPricingMode,
  type SmartPricingPreviewPayload,
  type SmartPricingPreviewResponse,
  type SmartPricingRecommendation,
  type SmartPricingScope,
  type SmartPricingStrategy,
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

const STRATEGY_LABEL_AR: Record<SmartPricingStrategy, string> = {
  conservative: 'محافظ',
  balanced: 'متوازن',
  aggressive: 'هجومي',
  clearance: 'تصفية / تحريك مخزون',
};

const STRATEGY_HINT_AR: Record<SmartPricingStrategy, string> = {
  conservative: 'تغييرات صغيرة، يحافظ على السعر الحالي قدر الإمكان.',
  balanced: 'يستهدف هامش الربح الموصى به، مع تعديلات معقولة.',
  aggressive: 'يدفع نحو هامش ربح عالٍ مع زيادات أكبر.',
  clearance: 'يقترح تخفيضات أكبر لتحريك مخزون راكد.',
};

// ─── P3.5A.1 — Manual adjustment labels ────────────────────────────
const OPERATION_LABEL_AR: Record<ManualAdjustmentOperation, string> = {
  increase_percent: 'زيادة بنسبة %',
  decrease_percent: 'تخفيض بنسبة %',
  increase_amount: 'زيادة بقيمة ج.م',
  decrease_amount: 'تخفيض بقيمة ج.م',
  set_price: 'تعيين سعر بيع ثابت ج.م',
};

const OPERATION_UNIT: Record<ManualAdjustmentOperation, string> = {
  increase_percent: '%',
  decrease_percent: '%',
  increase_amount: 'ج.م',
  decrease_amount: 'ج.م',
  set_price: 'ج.م',
};

const RECOMMENDATION_LABEL_AR: Record<SmartPricingRecommendation, string> = {
  increase: 'زيادة السعر',
  decrease: 'تخفيض السعر',
  keep: 'الإبقاء على السعر',
  review: 'مراجعة يدوية',
};

const RECOMMENDATION_COLOR: Record<SmartPricingRecommendation, string> = {
  increase: 'bg-emerald-100 text-emerald-700',
  decrease: 'bg-amber-100 text-amber-700',
  keep: 'bg-slate-100 text-slate-700',
  review: 'bg-rose-100 text-rose-700',
};

const WARNING_LABEL_AR: Record<string, string> = {
  below_cost_at_current: 'تحت التكلفة حاليًا',
  below_cost_after_change: 'تحت التكلفة بعد التغيير',
  below_min_margin_after_change: 'تحت الحد الأدنى للهامش بعد التغيير',
  large_increase: 'زيادة كبيرة (>50%)',
  large_decrease: 'تخفيض كبير (>50%)',
  missing_cost: 'التكلفة غير متوفرة',
  no_stock: 'لا يوجد مخزون',
  no_stock_alt: 'مخزون منخفض',
  slow_moving: 'حركة بيع ضعيفة',
  high_stock: 'مخزون مرتفع',
};

export interface SmartPricingScopeContext {
  /** Pre-selected variants (from row checkboxes). */
  selectedVariantIds: string[];
  /** Currently-applied filters that produced the visible report rows. */
  filters?: SmartPricingScope['filters'];
  /** Optional fixed single variant (used by "single" scope). */
  singleVariantId?: string;
}

export interface SmartPricingAssistantModalProps {
  open: boolean;
  context: SmartPricingScopeContext;
  onClose: () => void;
  /** Called with applied variant_ids so the parent can refetch reports
   *  and clear row selections. */
  onApplied: (appliedVariantIds: string[]) => void;
}

type ScopeKey = 'selected' | 'filtered' | 'all' | 'single';
type Step = 'scope' | 'strategy' | 'preview' | 'apply';

export function SmartPricingAssistantModal({
  open,
  context,
  onClose,
  onApplied,
}: SmartPricingAssistantModalProps) {
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>('scope');
  const [scopeKey, setScopeKey] = useState<ScopeKey>('selected');
  const [strategy, setStrategy] = useState<SmartPricingStrategy>('balanced');
  // P3.5A.1: mode + manual adjustment state. Smart is the default so the
  // P3.5A flow is unchanged.
  const [mode, setMode] = useState<SmartPricingMode>('smart');
  const [manualOperation, setManualOperation] =
    useState<ManualAdjustmentOperation>('increase_percent');
  const [manualValue, setManualValue] = useState<string>('');
  const [reason, setReason] = useState('');
  const [confirmAll, setConfirmAll] = useState('');
  const [preview, setPreview] = useState<SmartPricingPreviewResponse | null>(null);
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set());
  // PR-P9.1b — manual product-group override. Seeded from the tab's
  // forwarded filter so the modal opens already scoped; the operator
  // can override inside the modal without leaving the assistant.
  const [groupOverride, setGroupOverride] = useState<string>(
    context.filters?.group_id ?? '',
  );

  // Reset every time the modal opens so we don't carry stale state.
  useEffect(() => {
    if (!open) return;
    setStep('scope');
    setReason('');
    setConfirmAll('');
    setPreview(null);
    setExcludedIds(new Set());
    // Choose the most useful default scope.
    if (context.singleVariantId) setScopeKey('single');
    else if (context.selectedVariantIds.length > 0) setScopeKey('selected');
    else if (context.filters && Object.keys(context.filters).length > 0)
      setScopeKey('filtered');
    else setScopeKey('all');
    setStrategy('balanced');
    setMode('smart');
    setManualOperation('increase_percent');
    setManualValue('');
    setGroupOverride(context.filters?.group_id ?? '');
  }, [open, context]);

  // PR-P9.1b — list of active manual groups, fetched only when the
  // modal is open. Used by the in-modal "المجموعة" select.
  const { data: groups = [] } = useQuery({
    queryKey: ['product-groups', { is_active: true }],
    queryFn: () => productGroupsApi.list({ is_active: true }),
    enabled: open,
    staleTime: 60_000,
  });

  // Whether the manual adjustment value parses to a valid number > 0.
  // Used to gate the "توليد المعاينة" button when in manual mode.
  const manualValueNum = Number(manualValue);
  const manualValueValid =
    Number.isFinite(manualValueNum)
    && manualValueNum > 0
    && (!(manualOperation === 'increase_percent' || manualOperation === 'decrease_percent')
      || manualValueNum <= 500);

  const scopePayload: SmartPricingScope = useMemo(() => {
    if (scopeKey === 'single' && context.singleVariantId) {
      return { type: 'single', variant_ids: [context.singleVariantId] };
    }
    if (scopeKey === 'selected') {
      return { type: 'selected', variant_ids: context.selectedVariantIds };
    }
    if (scopeKey === 'filtered') {
      // PR-P9.1b — merge the in-modal group override on top of the
      // tab's forwarded filters. Empty string clears the override.
      const baseFilters: SmartPricingScope['filters'] = {
        ...(context.filters ?? {}),
      };
      if (groupOverride) {
        baseFilters.group_id = groupOverride;
      } else {
        delete baseFilters.group_id;
      }
      return { type: 'filtered', filters: baseFilters };
    }
    return { type: 'all' };
  }, [scopeKey, context, groupOverride]);

  // HOTFIX P3.5A.1 timeout — friendly Arabic message when axios aborts
  // a slow preview/apply request. Recognises both the explicit axios
  // ECONNABORTED code and the canonical "timeout of …ms exceeded" body.
  const friendlyError = (e: any, fallback: string): string => {
    const msg = e?.message ?? '';
    const code = e?.code;
    if (code === 'ECONNABORTED' || /timeout of \d+ms exceeded/i.test(msg)) {
      return 'انتهت مهلة الطلب. قلّل عدد الأصناف أو استخدم فلتر أدق ثم حاول مرة أخرى.';
    }
    return e?.response?.data?.message ?? msg ?? fallback;
  };

  const previewMut = useMutation({
    mutationFn: (payload: SmartPricingPreviewPayload) =>
      productsApi.smartPricingPreview(payload),
    onSuccess: (res) => {
      setPreview(res);
      setExcludedIds(new Set());
      setStep('preview');
    },
    onError: (e: any) => {
      toast.error(friendlyError(e, 'فشل توليد المعاينة'));
    },
  });

  const applyMut = useMutation({
    mutationFn: (payload: SmartPricingApplyPayload) =>
      productsApi.smartPricingApply(payload),
    onSuccess: (res) => {
      const msg =
        res.updated > 0
          ? `تم تحديث ${res.updated} سعر — تم تخطي ${res.skipped}.`
          : 'لم يتم تحديث أي سعر — راجع المعاينة.';
      toast.success(msg);
      qc.invalidateQueries({ queryKey: ['pricing-health'] });
      qc.invalidateQueries({ queryKey: ['pricing-losses'] });
      qc.invalidateQueries({ queryKey: ['pricing-history'] });
      qc.invalidateQueries({ queryKey: ['pricing-landed-impact'] });
      qc.invalidateQueries({ queryKey: ['sold-profit-summary'] });
      qc.invalidateQueries({ queryKey: ['sold-profit-products'] });
      qc.invalidateQueries({ queryKey: ['sold-profit-invoices'] });
      onApplied(res.items.map((r) => r.variant_id));
      onClose();
    },
    onError: (e: any) => {
      const status = e?.response?.status;
      if (status === 403) {
        toast.error('ليس لديك صلاحية تعديل أسعار البيع.');
      } else {
        toast.error(friendlyError(e, 'فشل تطبيق الأسعار'));
      }
    },
  });

  const applicableItems = useMemo(
    () =>
      (preview?.items ?? []).filter(
        (i) =>
          (i.recommendation === 'increase' || i.recommendation === 'decrease')
          && i.suggested_selling_price != null
          && Math.abs(i.suggested_selling_price - i.current_price) >= 0.01
          && !excludedIds.has(i.variant_id),
      ),
    [preview, excludedIds],
  );

  // HOTFIX P3.5A.1 timeout — front-end guard mirrors the server's
  // SMART_APPLY_BATCH_MAX. Keeps the operator from queueing a request
  // we already know the server will reject.
  const APPLY_BATCH_MAX = 500;
  const applyExceedsBatch = applicableItems.length > APPLY_BATCH_MAX;

  if (!open) return null;

  const scopeOptions: { key: ScopeKey; label: string; disabled?: boolean; hint: string }[] = [
    {
      key: 'single',
      label: 'صنف واحد محدد',
      disabled: !context.singleVariantId,
      hint: 'الصنف المختار فقط.',
    },
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
      hint: 'كل الأصناف اللي ظاهرة في التقرير حسب الفلتر الحالي.',
    },
    {
      key: 'all',
      label: 'كل الأصناف',
      hint: 'يحتاج تأكيد نصي صريح قبل التطبيق.',
    },
  ];

  const buildManualAdjustment = (): ManualAdjustment | undefined =>
    mode === 'manual'
      ? { operation: manualOperation, value: manualValueNum }
      : undefined;

  const runPreview = () => {
    if (mode === 'manual' && !manualValueValid) {
      toast.error('قيمة التعديل غير صالحة');
      return;
    }
    const payload: SmartPricingPreviewPayload = {
      scope: scopePayload,
      strategy,
      limit: 1000,
    };
    if (mode === 'manual') {
      payload.mode = 'manual';
      payload.manual_adjustment = buildManualAdjustment();
    }
    previewMut.mutate(payload);
  };

  const runApply = () => {
    if (reason.trim().length < 3) {
      toast.error('سبب التعديل مطلوب');
      return;
    }
    const payload: SmartPricingApplyPayload = {
      scope: scopePayload,
      strategy,
      reason: reason.trim(),
      variant_ids_to_apply: applicableItems.map((i) => i.variant_id),
    };
    if (mode === 'manual') {
      payload.mode = 'manual';
      payload.manual_adjustment = buildManualAdjustment();
    }
    if (scopePayload.type === 'all') {
      payload.confirm_all = confirmAll;
      if (confirmAll !== 'تأكيد تعديل كل الأصناف') {
        toast.error('اكتب نص التأكيد بالضبط: تأكيد تعديل كل الأصناف');
        return;
      }
    }
    applyMut.mutate(payload);
  };

  return (
    <div
      className="fixed inset-0 bg-slate-900/50 z-[60] flex items-center justify-center p-4"
      data-testid="smart-pricing-modal"
    >
      <div
        className="bg-white rounded-2xl w-full max-w-5xl shadow-xl max-h-[95vh] overflow-hidden flex flex-col"
        dir="rtl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b flex items-center justify-between">
          <div>
            <h3 className="font-black text-slate-800 flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-amber-500" />
              مساعد تعديل الأسعار
            </h3>
            <p
              className="text-[11px] text-slate-600 mt-1 leading-relaxed"
              data-testid="smart-pricing-cost-note"
            >
              تعديل التكلفة الحالية يحتاج مرحلة منفصلة لأنه يؤثر على تقييم
              المخزون ولا يتم ضمن مساعد التسعير الحالي.
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
          {/* STEP 1 — scope */}
          {step === 'scope' && (
            <div className="space-y-3" data-testid="smart-pricing-step-scope">
              <h4 className="font-bold text-slate-800">
                الخطوة 1 — اختر النطاق
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {scopeOptions.map((opt) => (
                  <label
                    key={opt.key}
                    className={`block rounded-lg border p-3 cursor-pointer ${
                      scopeKey === opt.key
                        ? 'border-amber-500 bg-amber-50/40'
                        : 'border-slate-200 hover:bg-slate-50'
                    } ${opt.disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    <input
                      type="radio"
                      name="scope"
                      value={opt.key}
                      checked={scopeKey === opt.key}
                      disabled={opt.disabled}
                      onChange={() => setScopeKey(opt.key)}
                      className="ml-2"
                      data-testid={`smart-pricing-scope-${opt.key}`}
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
              {/* PR-P9.1b — in-modal group select. Only meaningful for
                  the filtered scope; for selected/single/all the
                  preview ignores filters.group_id. */}
              {scopeKey === 'filtered' && (
                <div className="border border-slate-200 rounded-lg p-3 bg-slate-50/40">
                  <label className="block text-[11px] text-slate-600 mb-1">
                    مجموعة المنتجات (اختياري)
                  </label>
                  <select
                    value={groupOverride}
                    onChange={(e) => setGroupOverride(e.target.value)}
                    data-testid="smart-pricing-group-filter"
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white"
                  >
                    <option value="">كل المجموعات</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name_ar}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

          {/* STEP 2 — strategy / manual mode */}
          {step === 'strategy' && (
            <div className="space-y-3" data-testid="smart-pricing-step-strategy">
              <h4 className="font-bold text-slate-800">
                الخطوة 2 — اختر طريقة التعديل
              </h4>
              {/* P3.5A.1 — mode toggle. Smart keeps the existing
                  strategy engine; Manual exposes a flat operation +
                  value the operator chooses. */}
              <div className="flex gap-2" data-testid="smart-pricing-mode-toggle">
                <button
                  type="button"
                  onClick={() => setMode('smart')}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm font-bold border ${
                    mode === 'smart'
                      ? 'bg-amber-500 text-white border-amber-500'
                      : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                  }`}
                  data-testid="smart-pricing-mode-smart"
                >
                  اقتراح ذكي
                </button>
                <button
                  type="button"
                  onClick={() => setMode('manual')}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm font-bold border ${
                    mode === 'manual'
                      ? 'bg-amber-500 text-white border-amber-500'
                      : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                  }`}
                  data-testid="smart-pricing-mode-manual"
                >
                  تعديل يدوي
                </button>
              </div>

              {mode === 'smart' && (
                <div
                  className="grid grid-cols-1 md:grid-cols-2 gap-2"
                  data-testid="smart-pricing-strategy-panel"
                >
                  {(Object.keys(STRATEGY_LABEL_AR) as SmartPricingStrategy[]).map(
                    (s) => (
                      <label
                        key={s}
                        className={`block rounded-lg border p-3 cursor-pointer ${
                          strategy === s
                            ? 'border-amber-500 bg-amber-50/40'
                            : 'border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        <input
                          type="radio"
                          name="strategy"
                          value={s}
                          checked={strategy === s}
                          onChange={() => setStrategy(s)}
                          className="ml-2"
                          data-testid={`smart-pricing-strategy-${s}`}
                        />
                        <span className="font-bold text-sm text-slate-800">
                          {STRATEGY_LABEL_AR[s]}
                        </span>
                        <div className="text-[11px] text-slate-600 mt-1">
                          {STRATEGY_HINT_AR[s]}
                        </div>
                      </label>
                    ),
                  )}
                </div>
              )}

              {mode === 'manual' && (
                <div
                  className="space-y-3 rounded-lg border border-slate-200 p-3 bg-slate-50/40"
                  data-testid="smart-pricing-manual-panel"
                >
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">
                      نوع التعديل
                    </label>
                    <select
                      value={manualOperation}
                      onChange={(e) =>
                        setManualOperation(
                          e.target.value as ManualAdjustmentOperation,
                        )
                      }
                      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                      data-testid="manual-operation-select"
                    >
                      {(
                        Object.keys(OPERATION_LABEL_AR) as ManualAdjustmentOperation[]
                      ).map((op) => (
                        <option key={op} value={op}>
                          {OPERATION_LABEL_AR[op]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">
                      القيمة
                      <span className="text-slate-400 mr-1">
                        ({OPERATION_UNIT[manualOperation]})
                      </span>
                    </label>
                    <input
                      type="number"
                      inputMode="decimal"
                      step="0.01"
                      min="0.01"
                      max={
                        manualOperation === 'increase_percent'
                        || manualOperation === 'decrease_percent'
                          ? 500
                          : undefined
                      }
                      value={manualValue}
                      onChange={(e) => setManualValue(e.target.value)}
                      placeholder={
                        manualOperation === 'set_price'
                          ? 'مثال: 150.00'
                          : OPERATION_UNIT[manualOperation] === '%'
                            ? 'مثال: 10'
                            : 'مثال: 20'
                      }
                      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                      data-testid="manual-adjustment-value"
                    />
                    {!manualValueValid && manualValue !== '' && (
                      <div className="text-[11px] text-rose-700 mt-1">
                        أدخل قيمة موجبة
                        {(manualOperation === 'increase_percent'
                          || manualOperation === 'decrease_percent') &&
                          ' لا تتجاوز 500%'}
                        .
                      </div>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-600 leading-relaxed">
                    سيتم تطبيق العملية على سعر البيع الحالي لكل صنف داخل
                    النطاق. التكلفة لا تتأثر — تعديل التكلفة مرحلة منفصلة
                    لاحقة.
                  </div>
                </div>
              )}
            </div>
          )}

          {/* STEP 3 — preview */}
          {step === 'preview' && preview && (
            <div className="space-y-3" data-testid="smart-pricing-step-preview">
              {/* HOTFIX P3.5A.1 timeout — truncation banner. Surfaces
                  the server-supplied Arabic message so the operator
                  knows they're only seeing the first N rows. */}
              {preview.truncated && (
                <div
                  className="rounded-md border border-amber-300 bg-amber-50 p-2 text-[12px] text-amber-800"
                  data-testid="smart-pricing-truncated-warning"
                >
                  {preview.message_ar
                    ?? `تم عرض أول ${preview.returned_count ?? preview.items.length} صنف فقط من ${preview.total_candidates ?? '?'}. ضيّق الفلتر أو طبّق على دفعات.`}
                </div>
              )}
              {applyExceedsBatch && (
                <div
                  className="rounded-md border border-rose-300 bg-rose-50 p-2 text-[12px] text-rose-800"
                  data-testid="smart-pricing-apply-batch-warning"
                >
                  عدد الأصناف القابلة للتطبيق ({applicableItems.length}) أكبر من
                  الحد المسموح في دفعة واحدة ({APPLY_BATCH_MAX}). استبعد بعض
                  الصفوف أو طبّق على دفعات أصغر.
                </div>
              )}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                <SummaryTile label="إجمالي الصفوف" value={String(preview.summary.total)} />
                <SummaryTile label="مقترح زيادة" value={String(preview.summary.increase)} accent="emerald" />
                <SummaryTile label="مقترح تخفيض" value={String(preview.summary.decrease)} accent="amber" />
                <SummaryTile label="مراجعة يدوية" value={String(preview.summary.review)} accent="rose" />
              </div>
              <div className="overflow-x-auto border border-slate-200 rounded-lg">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-slate-600 text-xs">
                    <tr>
                      <th className="p-2"></th>
                      <th className="p-2 text-right">الصنف</th>
                      <th className="p-2 text-right">التكلفة</th>
                      <th className="p-2 text-right">السعر الحالي</th>
                      <th className="p-2 text-right">هامش الربح الحالي</th>
                      <th className="p-2 text-right">المخزون</th>
                      <th className="p-2 text-right">مبيعات (90ي)</th>
                      <th className="p-2 text-right">الاقتراح</th>
                      <th className="p-2 text-right">السعر المقترح</th>
                      <th className="p-2 text-right">الفرق</th>
                      <th className="p-2 text-right">السبب / التحذيرات</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {preview.items.map((it) => (
                      <PreviewRow
                        key={it.variant_id}
                        item={it}
                        excluded={excludedIds.has(it.variant_id)}
                        onToggle={() =>
                          setExcludedIds((s) => {
                            const next = new Set(s);
                            if (next.has(it.variant_id))
                              next.delete(it.variant_id);
                            else next.add(it.variant_id);
                            return next;
                          })
                        }
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* STEP 4 — apply confirmation */}
          {step === 'apply' && (
            <div className="space-y-3" data-testid="smart-pricing-step-apply">
              <h4 className="font-bold text-slate-800">
                الخطوة 4 — تأكيد التطبيق
              </h4>
              <div className="text-sm text-slate-700">
                سيتم تحديث سعر البيع لـ{' '}
                <span className="font-bold">{applicableItems.length}</span>{' '}
                صنفًا. لن يتم تعديل أي فاتورة أو مخزون أو قيود محاسبية.
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  سبب التعديل *
                </label>
                <textarea
                  rows={2}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="مثال: مراجعة دورية + إعادة تسعير بعد آخر فاتورة شراء"
                  data-testid="smart-pricing-reason"
                />
              </div>
              {scopePayload.type === 'all' && (
                <div
                  className="rounded-md border border-rose-200 bg-rose-50 p-3"
                  data-testid="smart-pricing-confirm-all-block"
                >
                  <div className="text-xs font-bold text-rose-700">
                    تطبيق على كل الأصناف — اكتب نص التأكيد التالي:
                  </div>
                  <div className="text-sm font-bold text-slate-800 my-2">
                    تأكيد تعديل كل الأصناف
                  </div>
                  <input
                    type="text"
                    value={confirmAll}
                    onChange={(e) => setConfirmAll(e.target.value)}
                    placeholder="اكتب النص بالضبط"
                    className="w-full border border-rose-300 rounded-lg px-3 py-2 text-sm"
                    data-testid="smart-pricing-confirm-all-input"
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer — step navigation */}
        <div className="p-4 border-t flex items-center justify-between gap-2">
          <div className="text-[11px] text-slate-500">
            النطاق:{' '}
            <span className="font-bold">
              {scopeOptions.find((o) => o.key === scopeKey)?.label}
            </span>{' '}
            · الطريقة:{' '}
            <span className="font-bold">
              {mode === 'manual'
                ? `يدوي · ${OPERATION_LABEL_AR[manualOperation]}${
                    manualValueValid ? ` · ${manualValueNum}` : ''
                  }`
                : `ذكي · ${STRATEGY_LABEL_AR[strategy]}`}
            </span>
          </div>
          <div className="flex gap-2">
            {step !== 'scope' && (
              <button
                type="button"
                onClick={() =>
                  setStep((s) =>
                    s === 'apply' ? 'preview' : s === 'preview' ? 'strategy' : 'scope',
                  )
                }
                disabled={previewMut.isPending || applyMut.isPending}
                className="btn-ghost"
                data-testid="smart-pricing-back"
              >
                رجوع
              </button>
            )}
            {step === 'scope' && (
              <button
                type="button"
                onClick={() => setStep('strategy')}
                className="btn-primary"
                data-testid="smart-pricing-next-strategy"
              >
                التالي
              </button>
            )}
            {step === 'strategy' && (
              <button
                type="button"
                onClick={runPreview}
                disabled={
                  previewMut.isPending
                  || (mode === 'manual' && !manualValueValid)
                }
                className="btn-primary"
                data-testid="smart-pricing-generate-preview"
              >
                {previewMut.isPending ? 'جاري التحضير...' : 'توليد المعاينة'}
              </button>
            )}
            {step === 'preview' && (
              <button
                type="button"
                onClick={() => setStep('apply')}
                disabled={applicableItems.length === 0 || applyExceedsBatch}
                className="btn-primary"
                data-testid="smart-pricing-go-apply"
                title={
                  applyExceedsBatch
                    ? `الحد الأقصى للتطبيق دفعة واحدة هو ${APPLY_BATCH_MAX} صنف. استبعد بعض الصفوف أو طبّق على دفعات.`
                    : undefined
                }
              >
                التالي ({applicableItems.length} صنف)
              </button>
            )}
            {step === 'apply' && (
              <button
                type="button"
                onClick={runApply}
                disabled={applyMut.isPending}
                className="btn-primary"
                data-testid="smart-pricing-apply"
              >
                {applyMut.isPending ? 'جاري التطبيق...' : 'تأكيد تعديل الأسعار'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

interface PreviewRowProps {
  item: SmartPricingItem;
  excluded: boolean;
  onToggle: () => void;
}

function PreviewRow({ item: it, excluded, onToggle }: PreviewRowProps) {
  const applicable =
    (it.recommendation === 'increase' || it.recommendation === 'decrease')
    && it.suggested_selling_price != null
    && Math.abs((it.suggested_selling_price ?? 0) - it.current_price) >= 0.01;
  const diff =
    it.suggested_selling_price != null
      ? it.suggested_selling_price - it.current_price
      : null;
  return (
    <tr data-testid={`smart-pricing-row-${it.variant_id}`}>
      <td className="p-2">
        <input
          type="checkbox"
          checked={applicable && !excluded}
          disabled={!applicable}
          onChange={onToggle}
          data-testid={`smart-pricing-row-toggle-${it.variant_id}`}
        />
      </td>
      <td className="p-2">
        <div className="font-medium">{it.product_name}</div>
        <div className="text-[10px] font-mono text-slate-400">
          {it.sku}
        </div>
      </td>
      <td className="p-2">{EGP(it.current_cost)}</td>
      <td className="p-2 font-bold">{EGP(it.current_price)}</td>
      <td className="p-2">{PCT(it.current_margin_pct)}</td>
      <td className="p-2">{it.stock_qty}</td>
      <td className="p-2 text-xs">
        {it.qty_sold} قطعة · {it.invoice_count} فاتورة
      </td>
      <td className="p-2">
        <span
          className={`text-[10px] font-bold px-2 py-1 rounded ${RECOMMENDATION_COLOR[it.recommendation]}`}
        >
          {RECOMMENDATION_LABEL_AR[it.recommendation]}
        </span>
      </td>
      <td className="p-2 font-bold text-emerald-700">
        {it.suggested_selling_price != null
          ? EGP(it.suggested_selling_price)
          : '—'}
      </td>
      <td className="p-2">
        {diff == null ? (
          '—'
        ) : (
          <span
            className={`font-bold ${
              diff >= 0 ? 'text-emerald-700' : 'text-rose-700'
            }`}
          >
            {diff >= 0 ? '+' : ''}
            {EGP(diff)}
          </span>
        )}
      </td>
      <td className="p-2 text-xs">
        <div>{it.reason_ar}</div>
        {it.warnings.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {it.warnings.map((w) => (
              <span
                key={w}
                className="text-[9px] bg-amber-100 text-amber-700 rounded px-1 inline-flex items-center gap-0.5"
              >
                <AlertTriangle className="w-2.5 h-2.5" />
                {WARNING_LABEL_AR[w] ?? w}
              </span>
            ))}
          </div>
        )}
      </td>
    </tr>
  );
}

interface TileProps {
  label: string;
  value: string;
  accent?: 'emerald' | 'rose' | 'amber';
}

function SummaryTile({ label, value, accent }: TileProps) {
  const color =
    accent === 'emerald'
      ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
      : accent === 'rose'
        ? 'text-rose-700 bg-rose-50 border-rose-200'
        : accent === 'amber'
          ? 'text-amber-700 bg-amber-50 border-amber-200'
          : 'text-slate-800 bg-white border-slate-200';
  return (
    <div className={`rounded-md border p-2 ${color}`}>
      <div className="text-[10px] text-slate-500 mb-0.5">{label}</div>
      <div className="font-bold text-sm">{value}</div>
    </div>
  );
}

// Re-export the embedded icon to satisfy the linter when this file
// stops importing `CheckCircle2` later. (Kept used to avoid noise.)
void CheckCircle2;
