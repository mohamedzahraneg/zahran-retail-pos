/**
 * Financial Control Tower — real-time dashboard.
 *
 * Reads (only):
 *   - /dashboard/financial/health           → score + tiles
 *   - /dashboard/financial/live-stream      → last 50 events
 *   - /dashboard/financial/anomalies        → active anomalies
 *   - /dashboard/financial/migration-status → phase progress
 *   - /accounting/cost/reconcile/history    → last 5 recon reports
 *
 * Writes:
 *   - POST /dashboard/financial/anomalies/scan (operator-only button)
 *   - PATCH /dashboard/financial/anomalies/:id/resolve (operator-only)
 *
 * Auto-refreshes every 20 seconds. Gated on `dashboard.financial.view`.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  TrendingUp,
  ShieldAlert,
  Eye,
  Zap,
} from 'lucide-react';
import { financialDashboardApi } from '@/api/financial-dashboard.api';

const fmtEGP = (n: number | string | null | undefined) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

const classificationTone: Record<string, string> = {
  EXCELLENT: 'bg-emerald-100 text-emerald-700 border-emerald-300',
  GOOD: 'bg-indigo-100 text-indigo-700 border-indigo-300',
  WARNING: 'bg-amber-100 text-amber-700 border-amber-300',
  CRITICAL: 'bg-rose-100 text-rose-700 border-rose-300',
};

const severityTone: Record<string, string> = {
  critical: 'bg-rose-100 text-rose-700 border-rose-300',
  high: 'bg-orange-100 text-orange-700 border-orange-300',
  medium: 'bg-amber-100 text-amber-700 border-amber-300',
  low: 'bg-slate-100 text-slate-700 border-slate-300',
};

export default function FinancialControlTower() {
  const qc = useQueryClient();

  const { data: health, isLoading: hLoad } = useQuery({
    queryKey: ['financial-health'],
    queryFn: () => financialDashboardApi.health(),
    refetchInterval: 20_000,
  });

  const { data: events = [] } = useQuery({
    queryKey: ['financial-stream'],
    queryFn: () => financialDashboardApi.liveStream(50),
    refetchInterval: 20_000,
  });

  const { data: anomalies } = useQuery({
    queryKey: ['financial-anomalies'],
    queryFn: () => financialDashboardApi.anomalies(),
    refetchInterval: 20_000,
  });

  const { data: migration } = useQuery({
    queryKey: ['financial-migration'],
    queryFn: () => financialDashboardApi.migrationStatus(),
    refetchInterval: 60_000,
  });

  const { data: reconHistory = [] } = useQuery({
    queryKey: ['financial-recon-history'],
    queryFn: () => financialDashboardApi.recentReconciliation(5),
    refetchInterval: 60_000,
  });

  const scan = useMutation({
    mutationFn: () => financialDashboardApi.scan(24),
    onSuccess: (res) => {
      toast.success(
        res.inserted > 0
          ? `تم اكتشاف ${res.inserted} شذوذ جديد`
          : 'لا شذوذات جديدة خلال آخر 24 ساعة',
      );
      qc.invalidateQueries({ queryKey: ['financial-anomalies'] });
      qc.invalidateQueries({ queryKey: ['financial-health'] });
    },
    onError: (e: any) => toast.error(e?.response?.data?.message || 'فشل المسح'),
  });

  const resolve = useMutation({
    mutationFn: (id: number) => financialDashboardApi.resolve(id),
    onSuccess: () => {
      toast.success('تم حل الشذوذ');
      qc.invalidateQueries({ queryKey: ['financial-anomalies'] });
      qc.invalidateQueries({ queryKey: ['financial-health'] });
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الحل'),
  });

  if (hLoad || !health) {
    return (
      <div className="card p-12 text-center text-slate-500">
        جارٍ تحميل برج المراقبة المالية…
      </div>
    );
  }

  const allAnomalies = anomalies
    ? [
        ...anomalies.by_severity.critical,
        ...anomalies.by_severity.high,
        ...anomalies.by_severity.medium,
        ...anomalies.by_severity.low,
      ]
    : [];

  const latestRecon = reconHistory[0];

  return (
    <div className="space-y-5">
      {/* ─── Header ─── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-indigo-100 text-indigo-700">
            <Activity size={20} />
          </div>
          <div>
            <h1 className="text-xl font-black text-slate-800">
              برج المراقبة المالية
            </h1>
            <p className="text-xs text-slate-500">
              حالة مالية حيّة — تحديث تلقائي كل 20 ثانية
            </p>
          </div>
        </div>
        <button
          className="btn-ghost flex items-center gap-1 text-xs"
          onClick={() => scan.mutate()}
          disabled={scan.isPending}
        >
          <RefreshCw size={14} className={scan.isPending ? 'animate-spin' : ''} />
          {scan.isPending ? 'جارٍ المسح…' : 'مسح يدوي للشذوذات'}
        </button>
      </div>

      {/* ─── Health Score Card ─── */}
      <div
        className={`card p-5 border-2 ${classificationTone[health.classification]}`}
      >
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <div className="text-xs font-bold opacity-80 mb-1">
              درجة الصحة المالية
            </div>
            <div className="flex items-baseline gap-3">
              <span className="text-5xl font-black tabular-nums">
                {health.health_score.toFixed(1)}
              </span>
              <span className="text-lg font-bold">/ 100</span>
              <span className="chip text-[11px]">{health.classification}</span>
            </div>
          </div>
          <div className="text-[11px] opacity-70 tabular-nums">
            آخر تحديث: {new Date(health.snapshot_at).toLocaleTimeString('ar-EG')}
          </div>
        </div>

        {/* Penalty breakdown */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-4 text-xs">
          <div className="bg-white/60 rounded-lg p-2 border border-current/20">
            <div className="opacity-70">خصم تجاوزات Legacy</div>
            <div className="font-bold tabular-nums">
              −{health.penalties.legacy.toFixed(1)}
            </div>
          </div>
          <div className="bg-white/60 rounded-lg p-2 border border-current/20">
            <div className="opacity-70">خصم انحراف الخزنة</div>
            <div className="font-bold tabular-nums">
              −{health.penalties.drift.toFixed(1)}
            </div>
          </div>
          <div className="bg-white/60 rounded-lg p-2 border border-current/20">
            <div className="opacity-70">خصم الشذوذات</div>
            <div className="font-bold tabular-nums">
              −{health.penalties.anomaly.toFixed(1)}
            </div>
          </div>
          <div className="bg-white/60 rounded-lg p-2 border border-current/20">
            <div className="opacity-70">خصم قيود غير متوازنة</div>
            <div className="font-bold tabular-nums">
              −{health.penalties.unbalanced.toFixed(1)}
            </div>
          </div>
        </div>
      </div>

      {/* ─── Metric Tiles ─── */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <MetricTile
          icon={<Zap size={16} />}
          label="تغطية المحرك (24س)"
          value={`${health.engine_coverage.pct_24h.toFixed(1)}%`}
          hint={`${health.engine_coverage.engine_events_24h} محرك / ${health.engine_coverage.total_events_24h} إجمالي`}
          tone="indigo"
        />
        <MetricTile
          icon={<ShieldAlert size={16} />}
          label="نشاط Legacy (24س)"
          value={`${health.legacy_activity.rate_24h_pct.toFixed(1)}%`}
          hint={`${health.legacy_activity.bypass_alerts_24h} تنبيه تجاوز`}
          tone={health.legacy_activity.rate_24h_pct > 0 ? 'amber' : 'emerald'}
        />
        <MetricTile
          icon={<AlertTriangle size={16} />}
          label="شذوذات نشطة"
          value={health.anomalies.open_total.toString()}
          hint={`${health.anomalies.critical} حرجة · ${health.anomalies.high} عالية`}
          tone={health.anomalies.open_total > 0 ? 'rose' : 'emerald'}
        />
        <MetricTile
          icon={<TrendingUp size={16} />}
          label="انحراف الخزنة"
          value={fmtEGP(health.drift_status.total_cashbox_drift)}
          hint={
            health.journal_integrity.unbalanced_entries_24h > 0
              ? `${health.journal_integrity.unbalanced_entries_24h} قيود غير متوازنة`
              : 'كل القيود متوازنة'
          }
          tone={health.drift_status.tolerable ? 'emerald' : 'rose'}
        />
      </div>

      {/* ─── Migration Status ─── */}
      {migration && (
        <div className="card p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-black text-slate-800">
              حالة هجرة المحاسبة إلى FinancialEngine
            </h3>
            <span className="chip bg-indigo-50 text-indigo-700 border-indigo-200 text-xs">
              التغطية الإجمالية (7 أيام): {migration.overall_engine_coverage_7d.toFixed(1)}%
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {migration.by_reference_type.map((b) => (
              <div
                key={b.reference_type}
                className="rounded-lg border border-slate-200 p-2.5 text-xs"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-mono font-bold">{b.reference_type}</span>
                  <span className="text-[10px] text-slate-500">
                    Phase {b.phase}
                  </span>
                </div>
                <div className="w-full bg-slate-100 rounded-full h-1.5 mb-1 overflow-hidden">
                  <div
                    className={`h-full ${
                      b.engine_pct >= 99.5 ? 'bg-emerald-500' : 'bg-amber-500'
                    }`}
                    style={{ width: `${Math.min(100, b.engine_pct)}%` }}
                  />
                </div>
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-slate-600">
                    {b.engine_count} / {b.total_7d} محرك
                  </span>
                  <span
                    className={
                      b.migrated ? 'text-emerald-700 font-bold' : 'text-slate-500'
                    }
                  >
                    {b.engine_pct.toFixed(1)}%
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ─── Anomalies Table ─── */}
      <div className="card p-4">
        <h3 className="font-black text-slate-800 mb-3 flex items-center gap-2">
          <AlertTriangle size={16} className="text-rose-600" />
          الشذوذات النشطة ({allAnomalies.length})
        </h3>
        {allAnomalies.length === 0 ? (
          <div className="text-center text-emerald-700 text-xs py-6 flex items-center justify-center gap-2">
            <CheckCircle2 size={16} />
            لا شذوذات نشطة — النظام نظيف
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 text-slate-600 text-[11px]">
                  <th className="p-2 text-right">الخطورة</th>
                  <th className="p-2 text-right">النوع</th>
                  <th className="p-2 text-right">الوصف</th>
                  <th className="p-2 text-right">الجهة</th>
                  <th className="p-2 text-right">وقت الاكتشاف</th>
                  <th className="p-2 text-center">حل</th>
                </tr>
              </thead>
              <tbody>
                {allAnomalies.map((a) => (
                  <tr key={a.anomaly_id} className="border-t border-slate-100">
                    <td className="p-2">
                      <span className={`chip text-[10px] ${severityTone[a.severity]}`}>
                        {a.severity}
                      </span>
                    </td>
                    <td className="p-2 font-mono text-[10px] text-slate-700">
                      {a.anomaly_type}
                    </td>
                    <td className="p-2 text-slate-700">{a.description}</td>
                    <td className="p-2 text-slate-500 text-[10px]">
                      {a.affected_entity || '—'}
                    </td>
                    <td className="p-2 tabular-nums text-[10px] text-slate-500">
                      {new Date(a.detected_at).toLocaleString('ar-EG', {
                        timeZone: 'Africa/Cairo',
                      })}
                    </td>
                    <td className="p-2 text-center">
                      <button
                        className="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-[10px] font-bold disabled:opacity-50"
                        onClick={() => resolve.mutate(a.anomaly_id)}
                        disabled={resolve.isPending}
                      >
                        حلّ
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ─── Reconciliation Summary ─── */}
      <div className="card p-4">
        <h3 className="font-black text-slate-800 mb-3">
          ملخص تسوية المصروفات
        </h3>
        {latestRecon ? (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs mb-3">
            <ReconTile
              label="تكرارات"
              value={latestRecon.duplicate_detected_count.toString()}
              tone={
                latestRecon.duplicate_detected_count > 0 ? 'rose' : 'emerald'
              }
            />
            <ReconTile
              label="مصروفات يتيمة"
              value={latestRecon.orphan_count.toString()}
              tone={latestRecon.orphan_count > 0 ? 'rose' : 'emerald'}
            />
            <ReconTile
              label="فئات غير مربوطة"
              value={latestRecon.unlinked_category_count.toString()}
              tone={
                latestRecon.unlinked_category_count > 0 ? 'amber' : 'emerald'
              }
            />
            <ReconTile
              label="مبلغ المحرك"
              value={fmtEGP(latestRecon.total_expense_engine)}
              tone="indigo"
            />
            <ReconTile
              label="مبلغ Legacy"
              value={fmtEGP(latestRecon.total_expense_legacy)}
              tone={
                Number(latestRecon.total_expense_legacy) > 0
                  ? 'amber'
                  : 'emerald'
              }
            />
          </div>
        ) : (
          <div className="text-xs text-slate-500 py-3">
            لم يُنفَّذ أي تقرير تسوية بعد. الـ cron يعمل يومياً 02:10 (القاهرة).
          </div>
        )}
        {reconHistory.length > 0 && (
          <div className="text-[11px] text-slate-500">
            آخر {reconHistory.length} تقرير —{' '}
            {reconHistory.map((r) => r.report_date).join(' · ')}
          </div>
        )}
      </div>

      {/* ─── Live Event Stream ─── */}
      <div className="card p-4">
        <h3 className="font-black text-slate-800 mb-3 flex items-center gap-2">
          <Eye size={16} className="text-indigo-600" />
          التدفق الحي للأحداث ({events.length})
        </h3>
        {events.length === 0 ? (
          <div className="text-center text-slate-500 text-xs py-8">
            لا أحداث بعد. سيظهر أي مصروف/فاتورة/إقفال وردية هنا لحظياً.
          </div>
        ) : (
          <div className="overflow-x-auto max-h-96 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-white">
                <tr className="bg-slate-50 text-slate-600 text-[11px]">
                  <th className="p-2 text-right">الوقت</th>
                  <th className="p-2 text-right">النوع</th>
                  <th className="p-2 text-right">المرجع</th>
                  <th className="p-2 text-right">المصدر</th>
                  <th className="p-2 text-center">المبلغ</th>
                  <th className="p-2 text-center">مسار</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.event_id} className="border-t border-slate-100">
                    <td className="p-2 tabular-nums font-mono text-[10px] text-slate-500">
                      {new Date(e.created_at).toLocaleTimeString('en-GB', {
                        timeZone: 'Africa/Cairo',
                      })}
                    </td>
                    <td className="p-2 font-mono text-[10px]">
                      {e.event_type}
                    </td>
                    <td className="p-2 text-slate-600 text-[10px]">
                      {e.reference_type}
                      {e.reference_id ? (
                        <span className="opacity-50 mx-1">
                          / {String(e.reference_id).slice(0, 8)}
                        </span>
                      ) : null}
                    </td>
                    <td className="p-2 text-[10px] text-slate-600">
                      {e.source_service || '—'}
                    </td>
                    <td className="p-2 text-center tabular-nums font-bold">
                      {fmtEGP(e.amount)}
                    </td>
                    <td className="p-2 text-center">
                      {e.is_engine ? (
                        <span className="chip bg-emerald-50 text-emerald-700 border-emerald-200 text-[9px]">
                          engine
                        </span>
                      ) : e.is_legacy ? (
                        <span className="chip bg-amber-50 text-amber-700 border-amber-200 text-[9px]">
                          legacy
                        </span>
                      ) : (
                        <span className="chip bg-slate-50 text-slate-600 border-slate-200 text-[9px]">
                          unknown
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function MetricTile({
  icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  tone: 'indigo' | 'amber' | 'emerald' | 'rose';
}) {
  const toneCls: Record<string, string> = {
    indigo: 'bg-indigo-50 border-indigo-200 text-indigo-700',
    amber: 'bg-amber-50 border-amber-200 text-amber-700',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-700',
    rose: 'bg-rose-50 border-rose-200 text-rose-700',
  };
  return (
    <div className={`card p-3 border ${toneCls[tone]}`}>
      <div className="flex items-center gap-2 text-xs font-bold mb-1">
        {icon}
        {label}
      </div>
      <div className="text-xl font-black tabular-nums">{value}</div>
      {hint && <div className="text-[10px] opacity-70 mt-1">{hint}</div>}
    </div>
  );
}

function ReconTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'rose' | 'amber' | 'emerald' | 'indigo';
}) {
  const toneCls: Record<string, string> = {
    rose: 'bg-rose-50 border-rose-200 text-rose-700',
    amber: 'bg-amber-50 border-amber-200 text-amber-700',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-700',
    indigo: 'bg-indigo-50 border-indigo-200 text-indigo-700',
  };
  return (
    <div className={`rounded-lg p-2 border ${toneCls[tone]}`}>
      <div className="font-bold text-[10px] mb-0.5">{label}</div>
      <div className="tabular-nums font-black text-sm">{value}</div>
    </div>
  );
}
