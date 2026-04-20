import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  History,
  Activity,
  Database,
  User as UserIcon,
  Search,
  X,
} from 'lucide-react';
import { auditApi, type ChangeLog } from '@/api/audit.api';

const OPERATIONS: Record<'I' | 'U' | 'D', { label: string; color: string }> = {
  I: { label: 'إضافة', color: 'bg-emerald-50 text-emerald-700' },
  U: { label: 'تعديل', color: 'bg-blue-50 text-blue-700' },
  D: { label: 'حذف', color: 'bg-rose-50 text-rose-700' },
};

const deviceSummary = (meta: any): string => {
  if (!meta || typeof meta !== 'object') return '—';
  const d = meta.device || {};
  const browser = d.browser || meta.browser;
  const os = d.os || meta.os;
  const type = d.device_type || meta.device_type || 'desktop';
  const icon = type === 'mobile' ? '📱' : type === 'tablet' ? '📱' : '💻';
  const parts = [browser, os].filter(Boolean);
  return parts.length ? `${icon} ${parts.join(' · ')}` : icon + ' —';
};

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const time = d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
  const day = d.toLocaleDateString('ar-EG', { weekday: 'long' });
  return { date, time, day };
};

const parseActionLabel = (
  action: string,
): { op: 'I' | 'U' | 'D' | null; table: string | null } => {
  // "إضافة invoices" / "تعديل invoices" / "حذف invoices"
  const m = action.match(/^(إضافة|تعديل|حذف)\s+(.+)$/);
  if (m) {
    const op = m[1] === 'إضافة' ? 'I' : m[1] === 'تعديل' ? 'U' : 'D';
    return { op, table: m[2] };
  }
  return { op: null, table: null };
};

export default function AuditLogPage() {
  const [tab, setTab] = useState<'activity' | 'changes'>('activity');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');
  const [selectedChange, setSelectedChange] = useState<ChangeLog | null>(null);
  const [actionDrillDown, setActionDrillDown] = useState<string | null>(null);
  const [userDrillDown, setUserDrillDown] = useState<{
    user_id: string;
    name: string;
  } | null>(null);

  const { data: stats } = useQuery({
    queryKey: ['audit-stats', from, to],
    queryFn: () => auditApi.stats(from || undefined, to || undefined),
  });

  const { data: activity = [], isLoading: actLoading } = useQuery({
    queryKey: ['audit-activity', from, to],
    queryFn: () =>
      auditApi.activity({
        from: from || undefined,
        to: to || undefined,
        limit: 300,
      }),
    enabled: tab === 'activity',
  });

  const { data: changes = [], isLoading: chgLoading } = useQuery({
    queryKey: ['audit-changes', from, to],
    queryFn: () =>
      auditApi.changes({
        from: from || undefined,
        to: to || undefined,
        limit: 300,
      }),
    enabled: tab === 'changes',
  });

  const filteredActivity = activity.filter((a) => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      a.summary?.toLowerCase().includes(s) ||
      a.action?.toLowerCase().includes(s) ||
      a.entity?.toLowerCase().includes(s) ||
      a.username?.toLowerCase().includes(s) ||
      a.full_name?.toLowerCase().includes(s)
    );
  });

  const filteredChanges = changes.filter((c) => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      c.table_name?.toLowerCase().includes(s) ||
      c.record_id?.toLowerCase().includes(s) ||
      c.username?.toLowerCase().includes(s) ||
      c.full_name?.toLowerCase().includes(s)
    );
  });

  return (
    <div className="p-6 space-y-6" dir="rtl">
      <header className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-black flex items-center gap-2 text-slate-800">
            <History className="w-7 h-7 text-brand-500" />
            سجل النشاط والتدقيق
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            تتبّع كامل لنشاطات المستخدمين والتغييرات في قاعدة البيانات
          </p>
        </div>
      </header>

      {/* Stats */}
      {stats && (
        <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <StatCard
            label="أحداث المستخدمين"
            value={stats.activity_count.toLocaleString('en-US')}
            icon={<Activity className="w-5 h-5 text-brand-500" />}
          />
          <StatCard
            label="تغييرات قاعدة البيانات"
            value={stats.audit_count.toLocaleString('en-US')}
            icon={<Database className="w-5 h-5 text-blue-500" />}
          />
          <div className="card p-4">
            <div className="text-xs text-slate-500 mb-2 flex items-center gap-1">
              <UserIcon className="w-4 h-4" />
              أنشط المستخدمين
            </div>
            <div className="space-y-1">
              {stats.top_users.slice(0, 3).map((u) => (
                <button
                  key={u.user_id}
                  onClick={() =>
                    setUserDrillDown({
                      user_id: u.user_id,
                      name: u.full_name || u.username || 'مستخدم',
                    })
                  }
                  className="w-full flex items-center justify-between text-sm hover:bg-slate-50 rounded px-1 py-0.5 transition"
                  title="اضغط لعرض التفاصيل"
                >
                  <span className="font-medium truncate text-right">
                    {u.full_name || u.username}
                  </span>
                  <span className="font-bold text-brand-600">{u.events}</span>
                </button>
              ))}
              {stats.top_users.length === 0 && (
                <div className="text-xs text-slate-400">لا توجد بيانات</div>
              )}
            </div>
          </div>
          <div className="card p-4">
            <div className="text-xs text-slate-500 mb-2">أكثر الإجراءات</div>
            <div className="space-y-1">
              {stats.top_actions.slice(0, 3).map((a) => (
                <button
                  key={a.action}
                  onClick={() => setActionDrillDown(a.action)}
                  className="w-full flex items-center justify-between text-sm hover:bg-slate-50 rounded px-1 py-0.5 transition"
                  title="اضغط لعرض تفاصيل الإجراء"
                >
                  <span className="font-medium truncate text-right">
                    {a.action}
                  </span>
                  <span className="font-bold text-brand-600">{a.events}</span>
                </button>
              ))}
              {stats.top_actions.length === 0 && (
                <div className="text-xs text-slate-400">لا توجد بيانات</div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Tabs + filters */}
      <div className="card p-4 space-y-4">
        <div className="flex items-center gap-2 border-b border-slate-200 pb-3">
          <button
            onClick={() => setTab('activity')}
            className={`px-4 py-2 rounded-lg font-semibold transition ${
              tab === 'activity'
                ? 'bg-brand-50 text-brand-700'
                : 'text-slate-600 hover:bg-slate-50'
            }`}
          >
            <Activity className="w-4 h-4 inline mr-1" /> نشاطات المستخدمين
          </button>
          <button
            onClick={() => setTab('changes')}
            className={`px-4 py-2 rounded-lg font-semibold transition ${
              tab === 'changes'
                ? 'bg-brand-50 text-brand-700'
                : 'text-slate-600 hover:bg-slate-50'
            }`}
          >
            <Database className="w-4 h-4 inline mr-1" /> تغييرات البيانات
          </button>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-2 bg-slate-50 rounded-lg px-3 py-2 flex-1 min-w-[220px]">
            <Search className="w-4 h-4 text-slate-400" />
            <input
              className="bg-transparent outline-none flex-1"
              placeholder="بحث…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <input
            type="date"
            className="input w-40"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
          <span className="text-slate-400">→</span>
          <input
            type="date"
            className="input w-40"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>

        {tab === 'activity' &&
          (actLoading ? (
            <div className="p-10 text-center text-slate-400">جاري التحميل…</div>
          ) : filteredActivity.length === 0 ? (
            <div className="p-10 text-center text-slate-400">
              لا توجد أحداث مطابقة
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="p-3 text-right">اليوم</th>
                    <th className="p-3 text-right">التاريخ</th>
                    <th className="p-3 text-right">الساعة</th>
                    <th className="p-3 text-right">المستخدم</th>
                    <th className="p-3 text-right">الإجراء</th>
                    <th className="p-3 text-right">الوصف</th>
                    <th className="p-3 text-right">الجهاز</th>
                    <th className="p-3 text-right">IP</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredActivity.map((a) => {
                    const t = fmtDate(a.created_at);
                    return (
                      <tr key={a.id} className="hover:bg-slate-50">
                        <td className="p-3 text-xs">{t.day}</td>
                        <td className="p-3 text-xs font-mono">{t.date}</td>
                        <td className="p-3 text-xs font-mono">{t.time}</td>
                        <td className="p-3 font-medium">
                          {a.full_name || a.username || '—'}
                        </td>
                        <td className="p-3">
                          <span className="px-2 py-1 rounded-md bg-slate-100 text-slate-700 text-xs font-mono">
                            {a.action}
                          </span>
                        </td>
                        <td className="p-3 text-slate-700">
                          {a.summary || '—'}
                          {a.entity && a.entity !== 'other' && (
                            <span className="mr-1 text-[10px] text-slate-400">
                              ({a.entity})
                            </span>
                          )}
                        </td>
                        <td className="p-3 text-xs text-slate-600">
                          {deviceSummary(a.metadata)}
                        </td>
                        <td className="p-3 text-xs text-slate-500 font-mono">
                          {a.ip_address || '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}

        {tab === 'changes' &&
          (chgLoading ? (
            <div className="p-10 text-center text-slate-400">جاري التحميل…</div>
          ) : filteredChanges.length === 0 ? (
            <div className="p-10 text-center text-slate-400">
              لا توجد تغييرات مطابقة
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="p-3 text-right">الوقت</th>
                    <th className="p-3 text-right">الجدول</th>
                    <th className="p-3 text-right">السجل</th>
                    <th className="p-3 text-right">العملية</th>
                    <th className="p-3 text-right">المستخدم</th>
                    <th className="p-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredChanges.map((c) => (
                    <tr key={c.id} className="hover:bg-slate-50">
                      <td className="p-3 text-xs text-slate-500 whitespace-nowrap">
                        {new Date(c.changed_at).toLocaleString('en-US')}
                      </td>
                      <td className="p-3 font-mono text-xs">{c.table_name}</td>
                      <td className="p-3 font-mono text-[11px] text-slate-500 truncate max-w-[180px]">
                        {c.record_id}
                      </td>
                      <td className="p-3">
                        <span
                          className={`px-2 py-1 rounded-full text-xs font-semibold ${OPERATIONS[c.operation].color}`}
                        >
                          {OPERATIONS[c.operation].label}
                        </span>
                      </td>
                      <td className="p-3">
                        {c.full_name || c.username || '—'}
                      </td>
                      <td className="p-3">
                        <button
                          onClick={() => setSelectedChange(c)}
                          className="text-xs text-brand-600 hover:underline font-semibold"
                        >
                          عرض التغيير
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
      </div>

      {selectedChange && (
        <ChangeDiffModal
          change={selectedChange}
          onClose={() => setSelectedChange(null)}
        />
      )}

      {actionDrillDown && (
        <ActionDrillDownModal
          action={actionDrillDown}
          from={from}
          to={to}
          onClose={() => setActionDrillDown(null)}
        />
      )}

      {userDrillDown && (
        <UserDrillDownModal
          user={userDrillDown}
          from={from}
          to={to}
          onClose={() => setUserDrillDown(null)}
        />
      )}
    </div>
  );
}

function ActionDrillDownModal({
  action,
  from,
  to,
  onClose,
}: {
  action: string;
  from: string;
  to: string;
  onClose: () => void;
}) {
  const parsed = parseActionLabel(action);

  const { data: changes = [], isLoading: chgLoading } = useQuery({
    queryKey: ['audit-drill-changes', action, from, to],
    queryFn: () =>
      auditApi.changes({
        table_name: parsed.table || undefined,
        operation: parsed.op || undefined,
        from: from || undefined,
        to: to || undefined,
        limit: 500,
      }),
    enabled: parsed.op !== null,
  });

  const { data: activity = [], isLoading: actLoading } = useQuery({
    queryKey: ['audit-drill-activity', action, from, to],
    queryFn: () =>
      auditApi.activity({
        action,
        from: from || undefined,
        to: to || undefined,
        limit: 500,
      }),
    enabled: parsed.op === null,
  });

  const loading = parsed.op !== null ? chgLoading : actLoading;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="modal-panel w-full max-w-3xl space-y-4 max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold">تفاصيل الإجراء</h2>
            <div className="text-xs text-slate-500 mt-1">
              <span className="font-bold text-brand-600">{action}</span>
              {from || to ? (
                <span className="mr-2">
                  · {from || '—'} ← {to || 'اليوم'}
                </span>
              ) : null}
            </div>
          </div>
          <button onClick={onClose} className="icon-btn">
            <X className="w-5 h-5" />
          </button>
        </div>

        {loading ? (
          <div className="p-10 text-center text-slate-400">جاري التحميل…</div>
        ) : parsed.op !== null ? (
          changes.length === 0 ? (
            <div className="p-10 text-center text-slate-400">
              لا توجد سجلات لهذا الإجراء
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="p-2 text-right">اليوم</th>
                    <th className="p-2 text-right">التاريخ</th>
                    <th className="p-2 text-right">الساعة</th>
                    <th className="p-2 text-right">المستخدم</th>
                    <th className="p-2 text-right">السجل</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {changes.map((c) => {
                    const t = fmtDate(c.changed_at);
                    return (
                      <tr key={c.id} className="hover:bg-slate-50">
                        <td className="p-2 text-xs text-slate-600">{t.day}</td>
                        <td className="p-2 text-xs text-slate-600 font-mono">
                          {t.date}
                        </td>
                        <td className="p-2 text-xs text-slate-600 font-mono">
                          {t.time}
                        </td>
                        <td className="p-2 text-xs">
                          {c.full_name || c.username || '—'}
                        </td>
                        <td className="p-2 text-xs font-mono text-slate-500 truncate max-w-[180px]">
                          {c.record_id}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="mt-3 text-xs text-slate-500">
                إجمالي السجلات:{' '}
                <b className="text-slate-800">{changes.length}</b>
              </div>
            </div>
          )
        ) : activity.length === 0 ? (
          <div className="p-10 text-center text-slate-400">
            لا توجد أحداث لهذا الإجراء
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="p-2 text-right">اليوم</th>
                  <th className="p-2 text-right">التاريخ</th>
                  <th className="p-2 text-right">الساعة</th>
                  <th className="p-2 text-right">المستخدم</th>
                  <th className="p-2 text-right">الوصف</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {activity.map((a) => {
                  const t = fmtDate(a.created_at);
                  return (
                    <tr key={a.id} className="hover:bg-slate-50">
                      <td className="p-2 text-xs">{t.day}</td>
                      <td className="p-2 text-xs font-mono">{t.date}</td>
                      <td className="p-2 text-xs font-mono">{t.time}</td>
                      <td className="p-2 text-xs">
                        {a.full_name || a.username || '—'}
                      </td>
                      <td className="p-2 text-xs">{a.summary || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex justify-end">
          <button onClick={onClose} className="btn-ghost">
            إغلاق
          </button>
        </div>
      </div>
    </div>
  );
}

function UserDrillDownModal({
  user,
  from,
  to,
  onClose,
}: {
  user: { user_id: string; name: string };
  from: string;
  to: string;
  onClose: () => void;
}) {
  const { data: changes = [], isLoading } = useQuery({
    queryKey: ['audit-drill-user-changes', user.user_id, from, to],
    queryFn: () =>
      auditApi.changes({
        changed_by: user.user_id,
        from: from || undefined,
        to: to || undefined,
        limit: 500,
      }),
  });

  const { data: activity = [] } = useQuery({
    queryKey: ['audit-drill-user-activity', user.user_id, from, to],
    queryFn: () =>
      auditApi.activity({
        user_id: user.user_id,
        from: from || undefined,
        to: to || undefined,
        limit: 500,
      }),
  });

  const combined = [
    ...changes.map((c) => ({
      id: `c-${c.id}`,
      at: c.changed_at,
      action:
        c.operation === 'I'
          ? 'إضافة'
          : c.operation === 'U'
            ? 'تعديل'
            : 'حذف',
      target: c.table_name,
      detail: c.record_id,
      device: '—',
      ip: '—',
    })),
    ...activity.map((a) => ({
      id: `a-${a.id}`,
      at: a.created_at,
      action: a.action,
      target: a.entity,
      detail: a.summary || '—',
      device: deviceSummary(a.metadata),
      ip: a.ip_address || '—',
    })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  const logins = activity.filter((a) => a.action === 'login');
  const logouts = activity.filter((a) => a.action === 'logout');

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="modal-panel w-full max-w-3xl space-y-4 max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold flex items-center gap-2">
              <UserIcon className="w-5 h-5 text-brand-500" />
              نشاط المستخدم: {user.name}
            </h2>
            <div className="text-xs text-slate-500 mt-1">
              {from || to ? (
                <span>
                  {from || '—'} ← {to || 'اليوم'}
                </span>
              ) : (
                'آخر 30 يوم'
              )}
            </div>
          </div>
          <button onClick={onClose} className="icon-btn">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Login / logout quick summary */}
        {(logins.length > 0 || logouts.length > 0) && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="card p-3 bg-emerald-50/60 border border-emerald-100">
              <div className="text-xs text-emerald-700 font-bold mb-2">
                آخر تسجيلات الدخول ({logins.length})
              </div>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {logins.slice(0, 5).map((a) => {
                  const t = fmtDate(a.created_at);
                  const success = a.metadata?.success !== false;
                  return (
                    <div
                      key={a.id}
                      className="flex items-center justify-between text-xs"
                    >
                      <div>
                        <span className="font-mono text-slate-700">
                          {t.date} {t.time}
                        </span>
                        <span className="text-slate-500 mr-1">· {t.day}</span>
                        {!success && (
                          <span className="mr-1 text-rose-600 font-bold">
                            فشل
                          </span>
                        )}
                      </div>
                      <div className="text-slate-600 text-left">
                        <div>{deviceSummary(a.metadata)}</div>
                        <div className="font-mono text-[10px] text-slate-400">
                          {a.ip_address || '—'}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="card p-3 bg-slate-50 border border-slate-200">
              <div className="text-xs text-slate-700 font-bold mb-2">
                آخر تسجيلات الخروج ({logouts.length})
              </div>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {logouts.length === 0 ? (
                  <div className="text-xs text-slate-400">لا يوجد</div>
                ) : (
                  logouts.slice(0, 5).map((a) => {
                    const t = fmtDate(a.created_at);
                    return (
                      <div
                        key={a.id}
                        className="flex items-center justify-between text-xs"
                      >
                        <div>
                          <span className="font-mono text-slate-700">
                            {t.date} {t.time}
                          </span>
                          <span className="text-slate-500 mr-1">· {t.day}</span>
                        </div>
                        <div className="text-slate-600 text-left">
                          <div>{deviceSummary(a.metadata)}</div>
                          <div className="font-mono text-[10px] text-slate-400">
                            {a.ip_address || '—'}
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="p-10 text-center text-slate-400">جاري التحميل…</div>
        ) : combined.length === 0 ? (
          <div className="p-10 text-center text-slate-400">
            لا توجد أحداث لهذا المستخدم
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="p-2 text-right">اليوم</th>
                  <th className="p-2 text-right">التاريخ</th>
                  <th className="p-2 text-right">الساعة</th>
                  <th className="p-2 text-right">الإجراء</th>
                  <th className="p-2 text-right">الهدف</th>
                  <th className="p-2 text-right">الجهاز</th>
                  <th className="p-2 text-right">IP</th>
                  <th className="p-2 text-right">التفاصيل</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {combined.map((r) => {
                  const t = fmtDate(r.at);
                  return (
                    <tr key={r.id} className="hover:bg-slate-50">
                      <td className="p-2 text-xs">{t.day}</td>
                      <td className="p-2 text-xs font-mono">{t.date}</td>
                      <td className="p-2 text-xs font-mono">{t.time}</td>
                      <td className="p-2 text-xs font-semibold">{r.action}</td>
                      <td className="p-2 text-xs text-slate-600">{r.target}</td>
                      <td className="p-2 text-xs text-slate-600">{r.device}</td>
                      <td className="p-2 text-xs font-mono text-slate-500">
                        {r.ip}
                      </td>
                      <td className="p-2 text-xs text-slate-500 font-mono truncate max-w-[180px]">
                        {r.detail}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="mt-3 text-xs text-slate-500">
              إجمالي الأحداث:{' '}
              <b className="text-slate-800">{combined.length}</b>
            </div>
          </div>
        )}

        <div className="flex justify-end">
          <button onClick={onClose} className="btn-ghost">
            إغلاق
          </button>
        </div>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="card p-4 flex items-center gap-3">
      <div className="w-10 h-10 rounded-lg bg-slate-50 flex items-center justify-center">
        {icon}
      </div>
      <div>
        <div className="text-xs text-slate-500">{label}</div>
        <div className="text-xl font-black text-slate-800">{value}</div>
      </div>
    </div>
  );
}

function ChangeDiffModal({
  change,
  onClose,
}: {
  change: ChangeLog;
  onClose: () => void;
}) {
  const before = change.old_data || {};
  const after = change.new_data || {};
  const keys = Array.from(
    new Set([...Object.keys(before), ...Object.keys(after)]),
  ).sort();

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="modal-panel w-full max-w-3xl space-y-4 max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold flex items-center gap-2">
              <Database className="w-5 h-5 text-brand-500" />
              تفاصيل التغيير
            </h2>
            <div className="text-xs text-slate-500 mt-1 font-mono">
              {change.table_name} · {change.record_id}
            </div>
          </div>
          <button onClick={onClose} className="icon-btn">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="bg-slate-50 rounded-lg p-3 text-sm grid grid-cols-2 gap-2">
          <div>
            <span className="text-slate-500">الوقت:</span>{' '}
            {new Date(change.changed_at).toLocaleString('en-US')}
          </div>
          <div>
            <span className="text-slate-500">المستخدم:</span>{' '}
            {change.full_name || change.username || '—'}
          </div>
          <div>
            <span className="text-slate-500">العملية:</span>{' '}
            <span
              className={`px-2 py-1 rounded-full text-xs font-semibold ${OPERATIONS[change.operation].color}`}
            >
              {OPERATIONS[change.operation].label}
            </span>
          </div>
        </div>

        <div className="overflow-x-auto border border-slate-200 rounded-lg">
          <table className="w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="p-2 text-right">الحقل</th>
                <th className="p-2 text-right">قبل</th>
                <th className="p-2 text-right">بعد</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {keys.map((k) => {
                const vBefore = before[k];
                const vAfter = after[k];
                const changed = JSON.stringify(vBefore) !== JSON.stringify(vAfter);
                return (
                  <tr key={k} className={changed ? 'bg-amber-50' : ''}>
                    <td className="p-2 font-mono text-xs">{k}</td>
                    <td className="p-2 font-mono text-xs max-w-[260px] truncate text-rose-700">
                      {formatValue(vBefore)}
                    </td>
                    <td className="p-2 font-mono text-xs max-w-[260px] truncate text-emerald-700">
                      {formatValue(vAfter)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex justify-end">
          <button onClick={onClose} className="btn-ghost">
            إغلاق
          </button>
        </div>
      </div>
    </div>
  );
}

function formatValue(v: any): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
