/**
 * Row2ProfitSummary — PR-FIN-2 (ملخص الأرباح)
 *
 * Nine-card grid matching the second row of the dashboard image.
 * Order (right→left in RTL):
 *   1. إجمالي المبيعات
 *   2. تكلفة البضاعة المباعة (lower-is-better polarity for delta)
 *   3. مجمل الربح
 *   4. إجمالي المصروفات (lower-is-better)
 *   5. صافي الربح
 *   6. هامش الربح
 *   7. أفضل عميل ربحًا
 *   8. أفضل مورد ربحًا
 *   9. أفضل صنف ربحًا
 *
 * Confidence badge appears on every "صافي الربح" card per Q10.
 */
import {
  TrendingUp,
  Package,
  Sparkles,
  Receipt,
  Coins,
  Percent,
  Users,
  Truck,
  Star,
} from 'lucide-react';
import type { FinanceDashboard } from '@/api/finance.api';
import { KpiCard } from './shared/KpiCard';
import { DeltaBadge } from './shared/DeltaBadge';
import { ConfidenceBadge } from './shared/ConfidenceBadge';
import { fmtEGP, fmtPct } from './shared/utils';
import { DashboardSection } from './shared/DashboardSection';

export function Row2ProfitSummary({ data }: { data: FinanceDashboard }) {
  const p = data.profit;
  return (
    <DashboardSection
      title="ملخص الأرباح"
      subtitle={`الفترة: ${data.range.from} → ${data.range.to}`}
      testId="dashboard-row-2"
    >
      <div
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3 2xl:grid-cols-9 gap-3"
        dir="rtl"
      >
        <ProfitMetric
          title="إجمالي المبيعات"
          value={fmtEGP(p.sales_total)}
          icon={<TrendingUp size={18} />}
          tone="indigo"
          delta={p.delta_vs_previous.sales_pct}
          testId="profit-sales-total"
        />
        <ProfitMetric
          title="تكلفة البضاعة المباعة"
          value={fmtEGP(p.cogs_total)}
          icon={<Package size={18} />}
          tone="violet"
          delta={p.delta_vs_previous.cogs_pct}
          lowerIsBetter
          testId="profit-cogs"
        />
        <ProfitMetric
          title="مجمل الربح"
          value={fmtEGP(p.gross_profit)}
          icon={<Sparkles size={18} />}
          tone="emerald"
          delta={p.delta_vs_previous.gross_pct}
          testId="profit-gross"
        />
        <ProfitMetric
          title="إجمالي المصروفات"
          value={fmtEGP(p.expenses_total)}
          icon={<Receipt size={18} />}
          tone="rose"
          delta={p.delta_vs_previous.expenses_pct}
          lowerIsBetter
          testId="profit-expenses-total"
        />
        <ProfitMetric
          title="صافي الربح"
          value={fmtEGP(p.net_profit)}
          icon={<Coins size={18} />}
          tone="emerald"
          delta={p.delta_vs_previous.net_pct}
          confidence={p.confidence}
          emphasized
          testId="profit-net"
        />
        <ProfitMetric
          title="هامش الربح"
          value={fmtPct(p.margin_pct)}
          icon={<Percent size={18} />}
          tone="amber"
          deltaPp={p.delta_vs_previous.margin_pp}
          testId="profit-margin"
        />
        <BestCard
          title="أفضل عميل ربحًا"
          icon={<Users size={18} />}
          tone="sky"
          best={p.best_customer}
          testId="profit-best-customer"
        />
        <BestCard
          title="أفضل مورد ربحًا"
          icon={<Truck size={18} />}
          tone="violet"
          best={p.best_supplier}
          testId="profit-best-supplier"
        />
        <BestCard
          title="أفضل صنف ربحًا"
          icon={<Star size={18} />}
          tone="pink"
          best={p.best_product}
          testId="profit-best-product"
        />
      </div>
    </DashboardSection>
  );
}

function ProfitMetric({
  title,
  value,
  icon,
  tone,
  delta,
  deltaPp,
  lowerIsBetter,
  confidence,
  emphasized,
  testId,
}: {
  title: string;
  value: string;
  icon: React.ReactNode;
  tone: 'emerald' | 'rose' | 'amber' | 'indigo' | 'sky' | 'violet' | 'pink';
  delta?: number;
  deltaPp?: number;
  lowerIsBetter?: boolean;
  confidence?: FinanceDashboard['profit']['confidence'];
  emphasized?: boolean;
  testId?: string;
}) {
  return (
    <KpiCard title={title} icon={icon} tone={tone} testId={testId}>
      <div
        className={`font-mono tabular-nums ${emphasized ? 'text-2xl font-black text-emerald-700 dark:text-emerald-400' : 'text-xl font-black text-slate-900 dark:text-slate-100'}`}
      >
        {value}
      </div>
      {typeof delta === 'number' && (
        <DeltaBadge pct={delta} lowerIsBetter={lowerIsBetter} />
      )}
      {typeof deltaPp === 'number' && (
        <span className="text-[10px] text-slate-500 dark:text-slate-400">
          {deltaPp >= 0 ? '+' : ''}
          {deltaPp.toFixed(1)} نقطة عن الفترة السابقة
        </span>
      )}
      {confidence && <ConfidenceBadge tier={confidence} />}
    </KpiCard>
  );
}

function BestCard({
  title,
  icon,
  tone,
  best,
  testId,
}: {
  title: string;
  icon: React.ReactNode;
  tone: 'sky' | 'violet' | 'pink';
  best: { name: string; profit: number } | null;
  testId?: string;
}) {
  return (
    <KpiCard title={title} icon={icon} tone={tone} testId={testId}>
      {best ? (
        <>
          <div className="text-base font-bold text-slate-800 dark:text-slate-100 truncate">
            {best.name}
          </div>
          <div className="font-mono tabular-nums text-lg font-black text-emerald-700 dark:text-emerald-400">
            {fmtEGP(best.profit)}
          </div>
        </>
      ) : (
        <span
          className="text-sm text-slate-500 dark:text-slate-400"
          title="لا توجد بيانات كافية في الفترة الحالية"
        >
          لا يتوفر بعد
        </span>
      )}
    </KpiCard>
  );
}
