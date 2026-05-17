/**
 * PricingSuggestions — PR-PURCHASES-P3.1
 *
 * Pure presentational component. Renders the result of `suggestPrices()`
 * as a header strip + 4 strategy cards. Local-only:
 * "استخدام هذا السعر" calls `onApply(suggestion)` which the parent
 * uses to keep a per-line pending-prices marker. P3.1 never writes
 * to the DB; the marker is for the operator's own tracking until
 * P3.2 introduces an explicit apply endpoint with audit.
 */
import { TrendingUp } from 'lucide-react';
import type {
  PricingStrategy,
  PricingSuggestion,
  PricingSuggestionsResult,
} from './pricingMath';

const EGP = (n: number | string | null | undefined) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

const PCT = (n: number | null | undefined) =>
  `${Number(n ?? 0).toLocaleString('en-US', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 2,
  })}%`;

export interface PricingSuggestionsProps {
  result: PricingSuggestionsResult;
  /** When set, the matching card is highlighted as "applied" locally. */
  appliedStrategy?: PricingStrategy | null;
  /** Local-only: parent stores the operator's selection. */
  onApply: (suggestion: PricingSuggestion) => void;
}

export function PricingSuggestions({
  result,
  appliedStrategy = null,
  onApply,
}: PricingSuggestionsProps) {
  return (
    <section
      data-testid="pricing-suggestions"
      className="rounded-xl border border-amber-200 bg-amber-50/30 p-3 space-y-3"
      dir="rtl"
    >
      <header className="flex items-start gap-2">
        <TrendingUp className="w-4 h-4 text-amber-600 mt-1 shrink-0" />
        <div className="flex-1">
          <h4 className="font-bold text-slate-800">اقتراحات سعر البيع</h4>
          <p
            className="text-[11px] text-slate-600 mt-1 leading-relaxed"
            data-testid="pricing-markup-margin-explanation"
          >
            الزيادة على التكلفة (Markup) تختلف عن هامش الربح (Margin). مثال:
            تكلفة 100، زيادة 30% تعطي سعر 130 لكن هامش الربح الفعلي 23% تقريبًا.
          </p>
        </div>
      </header>

      {result.unknown_cost ? (
        <div
          data-testid="pricing-unknown-cost"
          className="text-xs text-slate-600 bg-white border border-slate-200 rounded p-2"
        >
          أدخل سعر الشراء لكي نقترح سعر البيع.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
            <SummaryTile
              label="التكلفة النهائية"
              value={EGP(result.cost)}
              highlight
            />
            {result.current ? (
              <>
                <SummaryTile
                  label="سعر البيع الحالي"
                  value={EGP(result.current.price)}
                />
                <SummaryTile
                  label="هامش الربح الحالي"
                  value={PCT(result.current.margin_pct)}
                  accent={
                    result.current.below_cost
                      ? 'rose'
                      : result.current.below_min_margin
                        ? 'amber'
                        : undefined
                  }
                />
              </>
            ) : (
              <div className="md:col-span-2 text-[11px] text-slate-500 self-center">
                لا يوجد سعر بيع حالي للمقارنة.
              </div>
            )}
          </div>

          {result.current?.below_cost ? (
            <div
              data-testid="pricing-below-cost-warning"
              className="text-xs font-bold text-rose-700 bg-rose-50 border border-rose-200 rounded p-2"
            >
              تحذير: السعر أقل من التكلفة (خسارة{' '}
              {EGP(Math.max(0, result.cost - result.current.price))} لكل قطعة)
            </div>
          ) : null}

          {!result.current?.below_cost && result.current?.below_min_margin ? (
            <div
              data-testid="pricing-below-min-margin-warning"
              className="text-xs font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded p-2"
            >
              هامش أقل من الحد الأدنى ({result.min_margin_pct}%)
            </div>
          ) : null}

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-2">
            {result.suggestions.map((s) => (
              <SuggestionCard
                key={s.strategy}
                suggestion={s}
                applied={appliedStrategy === s.strategy}
                onApply={() => onApply(s)}
              />
            ))}
          </div>

          <div
            data-testid="pricing-local-marker"
            className="text-[11px] text-slate-500 bg-white border border-slate-200 rounded p-2"
          >
            سعر مقترح محدد محليًا فقط — لن يتم تحديث سعر البيع في هذه المرحلة.
          </div>
        </>
      )}
    </section>
  );
}

interface SuggestionCardProps {
  suggestion: PricingSuggestion;
  applied: boolean;
  onApply: () => void;
}

function SuggestionCard({ suggestion: s, applied, onApply }: SuggestionCardProps) {
  const accent = s.below_cost
    ? 'border-rose-300 bg-rose-50/40'
    : s.below_min_margin
      ? 'border-amber-300 bg-amber-50/40'
      : applied
        ? 'border-emerald-400 bg-emerald-50/40'
        : 'border-slate-200 bg-white';
  return (
    <div
      data-testid={`pricing-card-${s.strategy}`}
      className={`rounded-md border ${accent} p-2 text-xs space-y-1.5`}
    >
      <div className="flex items-center justify-between gap-1">
        <div className="font-bold text-slate-800">{s.label_ar}</div>
        {applied ? (
          <span
            data-testid={`pricing-applied-${s.strategy}`}
            className="text-[10px] font-bold text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded"
          >
            محدد
          </span>
        ) : null}
      </div>
      <div className="text-base font-black text-slate-900">{EGP(s.price)}</div>
      <div className="text-[11px] text-slate-600 leading-relaxed">
        {s.explanation_ar}
      </div>
      <div className="grid grid-cols-2 gap-1 text-[11px]">
        <div>
          الربح: <span className="font-bold">{EGP(s.profit)}</span>
        </div>
        <div>
          هامش: <span className="font-bold">{PCT(s.margin_pct)}</span>
        </div>
        <div>
          زيادة: <span className="font-bold">{PCT(s.markup_pct)}</span>
        </div>
        {s.vs_current_amount != null ? (
          <div>
            عن الحالي:{' '}
            <span
              className={`font-bold ${
                s.vs_current_amount >= 0 ? 'text-emerald-700' : 'text-rose-700'
              }`}
            >
              {s.vs_current_amount >= 0 ? '+' : ''}
              {EGP(s.vs_current_amount)}
            </span>
          </div>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onApply}
        data-testid={`pricing-apply-${s.strategy}`}
        className="w-full text-xs font-bold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded px-2 py-1"
      >
        استخدام هذا السعر
      </button>
    </div>
  );
}

interface SummaryTileProps {
  label: string;
  value: string;
  accent?: 'rose' | 'amber';
  highlight?: boolean;
}

function SummaryTile({ label, value, accent, highlight }: SummaryTileProps) {
  const valueColor =
    accent === 'rose'
      ? 'text-rose-700'
      : accent === 'amber'
        ? 'text-amber-700'
        : highlight
          ? 'text-emerald-700'
          : 'text-slate-800';
  return (
    <div className="rounded-md border border-slate-200 bg-white p-2">
      <div className="text-[10px] text-slate-500 mb-0.5">{label}</div>
      <div className={`font-bold ${valueColor}`}>{value}</div>
    </div>
  );
}
