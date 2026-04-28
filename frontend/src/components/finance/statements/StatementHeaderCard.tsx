/**
 * StatementHeaderCard — PR-FIN-3
 *
 * Top card for a loaded statement: entity meta + opening / debit /
 * credit / net / closing.
 */
import {
  ArrowDownCircle,
  ArrowUpCircle,
  Calculator,
  Coins,
  Sparkles,
} from 'lucide-react';
import type { StatementResponse } from '@/api/statements.api';

const fmtEGP = (n: number | null | undefined) => {
  const x = Number(n ?? 0);
  if (!isFinite(x)) return '0.00 ج.م';
  return `${x.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;
};

export function StatementHeaderCard({
  data,
}: {
  data: StatementResponse;
}) {
  return (
    <div
      className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm p-4"
      data-testid="statement-header-card"
      dir="rtl"
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h3
            className="text-sm font-black text-slate-900 dark:text-slate-100 truncate"
            data-testid="statement-entity-name"
          >
            {data.entity.name_ar}
          </h3>
          <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
            {data.entity.code ? `الكود: ${data.entity.code}` : null}
            {data.entity.code && data.range ? ' · ' : ''}
            الفترة: {data.range.from} → {data.range.to}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 mt-3">
        <Tile
          label="الرصيد الافتتاحي"
          value={fmtEGP(data.opening_balance)}
          tone="slate"
          icon={<Calculator size={14} />}
          testId="statement-opening-balance"
        />
        <Tile
          label="مدين (الفترة)"
          value={fmtEGP(data.totals.debit)}
          tone="emerald"
          icon={<ArrowDownCircle size={14} />}
          testId="statement-total-debit"
        />
        <Tile
          label="دائن (الفترة)"
          value={fmtEGP(data.totals.credit)}
          tone="rose"
          icon={<ArrowUpCircle size={14} />}
          testId="statement-total-credit"
        />
        <Tile
          label="صافي الحركة"
          value={fmtEGP(data.totals.net)}
          tone={data.totals.net >= 0 ? 'emerald' : 'rose'}
          icon={<Sparkles size={14} />}
          testId="statement-net-movement"
        />
        <Tile
          label="الرصيد الختامي"
          value={fmtEGP(data.closing_balance)}
          tone="brand"
          icon={<Coins size={14} />}
          emphasis
          testId="statement-closing-balance"
        />
      </div>
    </div>
  );
}

function Tile({
  label,
  value,
  tone,
  icon,
  emphasis,
  testId,
}: {
  label: string;
  value: string;
  tone: 'slate' | 'emerald' | 'rose' | 'brand';
  icon?: React.ReactNode;
  emphasis?: boolean;
  testId?: string;
}) {
  const toneClass =
    tone === 'emerald'
      ? 'text-emerald-700 dark:text-emerald-400'
      : tone === 'rose'
        ? 'text-rose-700 dark:text-rose-400'
        : tone === 'brand'
          ? 'text-brand-700 dark:text-brand-400'
          : 'text-slate-700 dark:text-slate-200';
  return (
    <div
      className="rounded-xl border border-slate-100 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/40 px-3 py-2"
      data-testid={testId}
    >
      <div className="flex items-center gap-1 text-[10px] font-bold text-slate-500 dark:text-slate-400">
        {icon}
        <span>{label}</span>
      </div>
      <div
        className={`mt-1 font-mono tabular-nums ${emphasis ? 'text-base font-black' : 'text-sm font-bold'} ${toneClass}`}
      >
        {value}
      </div>
    </div>
  );
}
