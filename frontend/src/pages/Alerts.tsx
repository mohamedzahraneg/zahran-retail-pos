import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Bell,
  AlertTriangle,
  AlertCircle,
  Info,
  CheckCircle2,
  CheckCheck,
  Scan,
  Package,
  Clock,
  Coins,
  DollarSign,
} from 'lucide-react';
import {
  alertsApi,
  Alert,
  AlertSeverity,
  AlertType,
} from '@/api/alerts.api';

const SEV_COLOR: Record<AlertSeverity, string> = {
  critical: 'bg-rose-50 border-rose-200 text-rose-900',
  warning: 'bg-amber-50 border-amber-200 text-amber-900',
  info: 'bg-blue-50 border-blue-200 text-blue-900',
};

const SEV_ICON: Record<AlertSeverity, React.ReactNode> = {
  critical: <AlertCircle className="text-rose-600" />,
  warning: <AlertTriangle className="text-amber-600" />,
  info: <Info className="text-blue-600" />,
};

const TYPE_ICON: Partial<Record<AlertType, React.ReactNode>> = {
  low_stock: <Package size={16} />,
  out_of_stock: <Package size={16} />,
  reservation_expiring: <Clock size={16} />,
  reservation_expired: <Clock size={16} />,
  cash_mismatch: <Coins size={16} />,
  price_below_cost: <DollarSign size={16} />,
  large_discount: <DollarSign size={16} />,
};

const TYPE_LABEL: Record<AlertType, string> = {
  low_stock: 'رصيد منخفض',
  out_of_stock: 'نفاد من المخزون',
  reservation_expiring: 'حجز ينتهي قريباً',
  reservation_expired: 'حجز منتهي',
  loss_product: 'منتج خاسر',
  price_below_cost: 'سعر أقل من التكلفة',
  large_discount: 'خصم كبير',
  cash_mismatch: 'فرق خزينة',
  custom: 'مخصص',
};

const fmtDate = (s: string) =>
  new Date(s).toLocaleString('en-US', {
    dateStyle: 'short',
    timeStyle: 'short',
  });

export default function Alerts() {
  const [filter, setFilter] = useState<'all' | 'unread' | 'unresolved'>(
    'unresolved',
  );
  const [severity, setSeverity] = useState<string>('');
  const qc = useQueryClient();

  const { data: counts } = useQuery({
    queryKey: ['alerts-counts'],
    queryFn: alertsApi.counts,
    refetchInterval: 30_000,
  });

  const { data: alerts = [], isLoading } = useQuery({
    queryKey: ['alerts', filter, severity],
    queryFn: () =>
      alertsApi.list({
        unread: filter === 'unread' ? 'true' : undefined,
        unresolved: filter === 'unresolved' ? 'true' : undefined,
        severity: severity || undefined,
      }),
  });

  const readAllM = useMutation({
    mutationFn: alertsApi.markAllRead,
    onSuccess: (res) => {
      toast.success(`تم تحديد ${res.updated} كمقروء`);
      qc.invalidateQueries({ queryKey: ['alerts'] });
      qc.invalidateQueries({ queryKey: ['alerts-counts'] });
    },
  });

  const resolveM = useMutation({
    mutationFn: (id: number) => alertsApi.resolve(id),
    onSuccess: () => {
      toast.success('تم الحل');
      qc.invalidateQueries({ queryKey: ['alerts'] });
      qc.invalidateQueries({ queryKey: ['alerts-counts'] });
    },
  });

  const scanM = useMutation({
    mutationFn: alertsApi.scan,
    onSuccess: (res) => {
      toast.success(`تم إنشاء ${res.created} تنبيه جديد`);
      qc.invalidateQueries({ queryKey: ['alerts'] });
      qc.invalidateQueries({ queryKey: ['alerts-counts'] });
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الفحص'),
  });

  const grouped = useMemo(() => {
    const g: Record<string, Alert[]> = { critical: [], warning: [], info: [] };
    for (const a of alerts) g[a.severity].push(a);
    return g;
  }, [alerts]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-black text-slate-800 flex items-center gap-2">
            <Bell className="text-brand-600" /> التنبيهات
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            تنبيهات المخزون والورديات والحجوزات
          </p>
        </div>
        <div className="flex gap-2">
          <button
            className="btn-ghost"
            onClick={() => scanM.mutate()}
            disabled={scanM.isPending}
          >
            <Scan size={16} /> {scanM.isPending ? 'جاري…' : 'فحص الآن'}
          </button>
          <button
            className="btn-ghost"
            onClick={() => readAllM.mutate()}
            disabled={readAllM.isPending || (counts?.unread ?? 0) === 0}
          >
            <CheckCheck size={16} /> تحديد الكل كمقروء
          </button>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid md:grid-cols-4 gap-4">
        <Kpi
          title="الإجمالي"
          value={String(counts?.total ?? 0)}
          icon={<Bell className="text-brand-600" />}
          color="bg-brand-50"
        />
        <Kpi
          title="غير مقروء"
          value={String(counts?.unread ?? 0)}
          icon={<Bell className="text-amber-600" />}
          color="bg-amber-50"
        />
        <Kpi
          title="حرجة"
          value={String(counts?.critical ?? 0)}
          icon={<AlertCircle className="text-rose-600" />}
          color="bg-rose-50"
        />
        <Kpi
          title="تحذيرات"
          value={String(counts?.warning ?? 0)}
          icon={<AlertTriangle className="text-amber-600" />}
          color="bg-amber-50"
        />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        <TabBtn active={filter === 'all'} onClick={() => setFilter('all')}>
          الكل
        </TabBtn>
        <TabBtn
          active={filter === 'unread'}
          onClick={() => setFilter('unread')}
        >
          غير مقروء
        </TabBtn>
        <TabBtn
          active={filter === 'unresolved'}
          onClick={() => setFilter('unresolved')}
        >
          غير محلول
        </TabBtn>
        <select
          className="input max-w-[200px] text-sm py-1"
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
        >
          <option value="">كل المستويات</option>
          <option value="critical">حرج</option>
          <option value="warning">تحذير</option>
          <option value="info">معلومة</option>
        </select>
      </div>

      {/* Alerts list */}
      {isLoading ? (
        <div className="card p-8 text-center text-slate-400">
          جاري التحميل…
        </div>
      ) : alerts.length === 0 ? (
        <div className="card p-12 text-center">
          <CheckCircle2 className="mx-auto text-emerald-500 mb-3" size={48} />
          <p className="text-slate-600 font-bold">لا توجد تنبيهات</p>
          <p className="text-slate-400 text-sm">كل شيء تحت السيطرة</p>
        </div>
      ) : (
        <div className="space-y-4">
          {(['critical', 'warning', 'info'] as AlertSeverity[]).map((sev) =>
            grouped[sev].length > 0 ? (
              <div key={sev} className="space-y-2">
                <h3 className="font-bold text-sm text-slate-600 flex items-center gap-2">
                  {SEV_ICON[sev]}
                  {sev === 'critical'
                    ? 'حرجة'
                    : sev === 'warning'
                      ? 'تحذيرات'
                      : 'معلومات'}
                  <span className="text-slate-400">({grouped[sev].length})</span>
                </h3>
                <div className="space-y-2">
                  {grouped[sev].map((a) => (
                    <AlertCard
                      key={a.id}
                      alert={a}
                      onResolve={() => resolveM.mutate(a.id)}
                      resolving={resolveM.isPending}
                    />
                  ))}
                </div>
              </div>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}

function AlertCard({
  alert,
  onResolve,
  resolving,
}: {
  alert: Alert;
  onResolve: () => void;
  resolving: boolean;
}) {
  return (
    <div
      className={`card p-4 border-r-4 ${SEV_COLOR[alert.severity]} ${!alert.is_read ? 'ring-2 ring-brand-200' : ''}`}
    >
      <div className="flex items-start gap-3">
        <div className="mt-1">{SEV_ICON[alert.severity]}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="font-bold text-slate-800">{alert.title}</h4>
            <span className="px-2 py-0.5 bg-white/60 rounded text-xs inline-flex items-center gap-1">
              {TYPE_ICON[alert.alert_type]}
              {TYPE_LABEL[alert.alert_type]}
            </span>
            {!alert.is_read && (
              <span className="px-1.5 py-0.5 bg-brand-600 text-white rounded text-[10px] font-bold">
                جديد
              </span>
            )}
          </div>
          {alert.message && (
            <p className="text-sm text-slate-600 mt-1">{alert.message}</p>
          )}
          <p className="text-xs text-slate-400 mt-1">
            {fmtDate(alert.created_at)}
          </p>
        </div>
        {!alert.is_resolved && (
          <button
            className="btn-ghost text-xs py-1 px-2"
            onClick={onResolve}
            disabled={resolving}
          >
            <CheckCircle2 size={14} /> حل
          </button>
        )}
      </div>
    </div>
  );
}

function Kpi({
  title,
  value,
  icon,
  color,
}: {
  title: string;
  value: string;
  icon: React.ReactNode;
  color: string;
}) {
  return (
    <div className="card p-5 flex items-center gap-4">
      <div className={`p-3 rounded-xl ${color}`}>{icon}</div>
      <div>
        <div className="text-xs text-slate-500">{title}</div>
        <div className="text-2xl font-black text-slate-800">{value}</div>
      </div>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`px-4 py-1.5 rounded-xl text-sm font-bold ${
        active
          ? 'bg-brand-600 text-white shadow'
          : 'bg-white text-slate-700 hover:bg-slate-50'
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
