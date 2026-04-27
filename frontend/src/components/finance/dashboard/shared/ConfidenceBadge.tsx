/**
 * ConfidenceBadge — PR-FIN-2
 *
 * Visual indicator of profit-data confidence per the rules in the
 * approved plan §11:
 *   High   ✅  cost_at_sale stored on every line in range
 *   Medium ⚠️  some lines fell back to product average cost
 *   Low    🟠  some lines fell back to last purchase cost
 *   N/A    ⚪  no comparable lines (zero data in range)
 *
 * Never relies on color alone — every tier has an icon + text label.
 */
import { CheckCircle2, AlertTriangle, AlertCircle, Circle } from 'lucide-react';
import type { ConfidenceTier } from '@/api/finance.api';

const TIER_STYLES: Record<
  ConfidenceTier,
  { tone: string; label: string; Icon: typeof CheckCircle2; tooltip: string }
> = {
  High: {
    tone: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800',
    label: 'High',
    Icon: CheckCircle2,
    tooltip: 'التكلفة محفوظة على كل بنود الفواتير في الفترة',
  },
  Medium: {
    tone: 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800',
    label: 'Medium',
    Icon: AlertTriangle,
    tooltip: 'بعض البنود تستخدم متوسط التكلفة بدل cost_at_sale',
  },
  Low: {
    tone: 'bg-orange-50 text-orange-800 border-orange-200 dark:bg-orange-900/30 dark:text-orange-300 dark:border-orange-800',
    label: 'Low',
    Icon: AlertCircle,
    tooltip: 'بعض البنود تستخدم آخر تكلفة شراء — الربح تقديري',
  },
  'N/A': {
    tone: 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700',
    label: 'N/A',
    Icon: Circle,
    tooltip: 'لا توجد بيانات كافية لحساب الربح',
  },
};

export function ConfidenceBadge({
  tier,
  testId,
}: {
  tier: ConfidenceTier;
  testId?: string;
}) {
  const s = TIER_STYLES[tier];
  const Icon = s.Icon;
  return (
    <span
      data-testid={testId}
      title={s.tooltip}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold border ${s.tone}`}
    >
      <Icon size={11} aria-hidden />
      <span>ثقة: {s.label}</span>
    </span>
  );
}
