import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  MessageCircle,
  MessageSquare,
  Mail,
  Send,
  RefreshCcw,
  RotateCcw,
  X,
  Play,
  FileText,
  CheckCircle2,
  XCircle,
  Clock,
  Ban,
} from 'lucide-react';
import {
  notificationsApi,
  NotificationRecord,
  NotificationStatus,
  NotificationChannel,
  NotificationTemplate,
} from '@/api/notifications.api';

const CHANNEL_ICONS: Record<NotificationChannel, any> = {
  whatsapp: MessageCircle,
  sms: MessageSquare,
  email: Mail,
};

const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  whatsapp: 'واتساب',
  sms: 'SMS',
  email: 'بريد',
};

const STATUS_META: Record<
  NotificationStatus,
  { label: string; color: string; icon: any }
> = {
  queued: { label: 'في الانتظار', color: 'bg-slate-100 text-slate-600', icon: Clock },
  sending: { label: 'يتم الإرسال', color: 'bg-sky-100 text-sky-700', icon: Send },
  sent: { label: 'تم الإرسال', color: 'bg-emerald-100 text-emerald-700', icon: CheckCircle2 },
  failed: { label: 'فشل', color: 'bg-rose-100 text-rose-700', icon: XCircle },
  cancelled: { label: 'ملغاة', color: 'bg-slate-100 text-slate-500', icon: Ban },
};

function fmtDate(iso?: string | null) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-US', {
      dateStyle: 'short',
      timeStyle: 'short',
    });
  } catch {
    return iso;
  }
}

export default function Notifications() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'queue' | 'templates'>('queue');
  const [filterStatus, setFilterStatus] = useState<NotificationStatus | ''>('');
  const [filterChannel, setFilterChannel] = useState<NotificationChannel | ''>('');
  const [sendOpen, setSendOpen] = useState(false);
  const [editTemplate, setEditTemplate] = useState<NotificationTemplate | null>(null);
  const [detailRow, setDetailRow] = useState<NotificationRecord | null>(null);

  const { data: list = [] } = useQuery({
    queryKey: ['notifications', filterStatus, filterChannel],
    queryFn: () =>
      notificationsApi.list({
        status: filterStatus || undefined,
        channel: filterChannel || undefined,
        limit: 200,
      }),
  });

  const { data: stats } = useQuery({
    queryKey: ['notifications-stats'],
    queryFn: notificationsApi.stats,
  });

  const { data: templates = [] } = useQuery({
    queryKey: ['notification-templates'],
    queryFn: notificationsApi.templates,
    enabled: tab === 'templates',
  });

  const processM = useMutation({
    mutationFn: () => notificationsApi.processQueue(50),
    onSuccess: (res) => {
      toast.success(`تمت معالجة ${res.processed} رسالة`);
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['notifications-stats'] });
    },
  });

  const retryM = useMutation({
    mutationFn: notificationsApi.retry,
    onSuccess: () => {
      toast.success('أُعيدت المحاولة');
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  const cancelM = useMutation({
    mutationFn: notificationsApi.cancel,
    onSuccess: () => {
      toast.success('ألغيت الرسالة');
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  const sendNowM = useMutation({
    mutationFn: notificationsApi.sendNow,
    onSuccess: () => {
      toast.success('تم الإرسال');
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الإرسال'),
  });

  const counts = stats?.by_status.reduce(
    (acc, s) => ({ ...acc, [s.status]: s.count }),
    {} as Record<string, number>,
  ) || {};

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <MessageCircle size={28} className="text-brand-600" />
          <h2 className="text-2xl font-black text-slate-800">
            الإشعارات (واتساب / SMS)
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => processM.mutate()}
            className="btn-secondary text-sm"
            disabled={processM.isPending}
          >
            <Play size={14} />
            معالجة الطابور
          </button>
          <button onClick={() => setSendOpen(true)} className="btn-primary text-sm">
            <Send size={14} />
            إرسال فوري
          </button>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard
          label="اليوم"
          value={stats?.today_count ?? 0}
          icon={Send}
          color="text-brand-600 bg-brand-50"
        />
        <StatCard
          label="مُرسلة"
          value={counts.sent || 0}
          icon={CheckCircle2}
          color="text-emerald-600 bg-emerald-50"
        />
        <StatCard
          label="في الانتظار"
          value={counts.queued || 0}
          icon={Clock}
          color="text-slate-600 bg-slate-100"
        />
        <StatCard
          label="فشل"
          value={counts.failed || 0}
          icon={XCircle}
          color="text-rose-600 bg-rose-50"
        />
        <StatCard
          label="ملغاة"
          value={counts.cancelled || 0}
          icon={Ban}
          color="text-slate-500 bg-slate-50"
        />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-200">
        {(['queue', 'templates'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-bold border-b-2 transition -mb-px ${
              tab === t
                ? 'border-brand-600 text-brand-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {t === 'queue' ? 'الطابور' : 'القوالب'}
          </button>
        ))}
      </div>

      {tab === 'queue' && (
        <>
          {/* Filters */}
          <div className="card p-3 flex flex-wrap items-center gap-2">
            <select
              className="input w-auto py-1.5"
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value as any)}
            >
              <option value="">كل الحالات</option>
              {(Object.keys(STATUS_META) as NotificationStatus[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_META[s].label}
                </option>
              ))}
            </select>
            <select
              className="input w-auto py-1.5"
              value={filterChannel}
              onChange={(e) => setFilterChannel(e.target.value as any)}
            >
              <option value="">كل القنوات</option>
              {(Object.keys(CHANNEL_LABELS) as NotificationChannel[]).map((c) => (
                <option key={c} value={c}>
                  {CHANNEL_LABELS[c]}
                </option>
              ))}
            </select>
          </div>

          <div className="card overflow-hidden">
            <table className="w-full">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr className="text-xs text-slate-500 font-bold">
                  <th className="text-right p-3">القناة</th>
                  <th className="text-right p-3">المستقبل</th>
                  <th className="text-right p-3">نموذج</th>
                  <th className="text-center p-3">الحالة</th>
                  <th className="text-right p-3">تاريخ الإرسال</th>
                  <th className="text-center p-3">محاولات</th>
                  <th className="text-center p-3">إجراءات</th>
                </tr>
              </thead>
              <tbody>
                {list.map((n) => {
                  const ChannelIcon = CHANNEL_ICONS[n.channel];
                  const meta = STATUS_META[n.status];
                  const StatusIcon = meta.icon;
                  return (
                    <tr
                      key={n.id}
                      className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer"
                      onClick={() => setDetailRow(n)}
                    >
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <ChannelIcon size={16} className="text-slate-600" />
                          <span className="text-sm">{CHANNEL_LABELS[n.channel]}</span>
                        </div>
                      </td>
                      <td className="p-3 font-mono text-xs text-slate-700">
                        {n.recipient}
                      </td>
                      <td className="p-3 text-xs text-slate-500">
                        {n.template_code || '—'}
                      </td>
                      <td className="p-3 text-center">
                        <span
                          className={`chip ${meta.color} inline-flex items-center gap-1`}
                        >
                          <StatusIcon size={12} />
                          {meta.label}
                        </span>
                      </td>
                      <td className="p-3 text-xs text-slate-600">
                        {fmtDate(n.sent_at || n.created_at)}
                      </td>
                      <td className="p-3 text-center text-xs">{n.attempts}</td>
                      <td
                        className="p-3 text-center"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="flex items-center justify-center gap-1">
                          {n.status === 'queued' && (
                            <button
                              title="إرسال الآن"
                              className="btn-ghost p-1.5"
                              onClick={() => sendNowM.mutate(n.id)}
                            >
                              <Send size={13} />
                            </button>
                          )}
                          {n.status === 'failed' && (
                            <button
                              title="إعادة المحاولة"
                              className="btn-ghost p-1.5"
                              onClick={() => retryM.mutate(n.id)}
                            >
                              <RotateCcw size={13} />
                            </button>
                          )}
                          {(n.status === 'queued' || n.status === 'failed') && (
                            <button
                              title="إلغاء"
                              className="btn-ghost p-1.5 text-rose-600"
                              onClick={() => cancelM.mutate(n.id)}
                            >
                              <X size={13} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {!list.length && (
                  <tr>
                    <td
                      colSpan={7}
                      className="text-center py-12 text-slate-400"
                    >
                      لا توجد إشعارات
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'templates' && (
        <div className="card overflow-hidden">
          <div className="p-4 border-b border-slate-200 flex items-center justify-between">
            <h3 className="font-bold">قوالب الإشعارات</h3>
            <button
              className="btn-secondary text-sm"
              onClick={() =>
                setEditTemplate({
                  id: '',
                  code: '',
                  name_ar: '',
                  channel: 'whatsapp',
                  subject: '',
                  body: '',
                  is_active: true,
                  created_at: '',
                  updated_at: '',
                })
              }
            >
              قالب جديد
            </button>
          </div>
          <div className="divide-y divide-slate-100">
            {templates.map((t) => {
              const ChannelIcon = CHANNEL_ICONS[t.channel];
              return (
                <div
                  key={t.id}
                  className="p-4 flex items-start gap-3 hover:bg-slate-50"
                >
                  <ChannelIcon size={20} className="text-slate-500 mt-1" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-bold">{t.name_ar}</span>
                      <span className="text-xs font-mono text-slate-500">
                        {t.code}
                      </span>
                      {!t.is_active && (
                        <span className="chip bg-slate-100 text-slate-500">
                          معطل
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500 whitespace-pre-wrap mt-1 line-clamp-3">
                      {t.body}
                    </div>
                  </div>
                  <button
                    className="btn-ghost text-xs"
                    onClick={() => setEditTemplate(t)}
                  >
                    <FileText size={14} />
                    تحرير
                  </button>
                </div>
              );
            })}
            {!templates.length && (
              <div className="text-center py-12 text-slate-400">
                لا توجد قوالب
              </div>
            )}
          </div>
        </div>
      )}

      {sendOpen && <SendAdHocModal onClose={() => setSendOpen(false)} />}
      {editTemplate && (
        <TemplateEditorModal
          template={editTemplate}
          onClose={() => setEditTemplate(null)}
        />
      )}
      {detailRow && (
        <NotificationDetailModal
          row={detailRow}
          onClose={() => setDetailRow(null)}
        />
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  icon: Icon,
  color,
}: {
  label: string;
  value: number;
  icon: any;
  color: string;
}) {
  return (
    <div className="card p-4 flex items-center gap-3">
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${color}`}>
        <Icon size={20} />
      </div>
      <div>
        <div className="text-xs text-slate-500">{label}</div>
        <div className="text-xl font-black text-slate-800">{value}</div>
      </div>
    </div>
  );
}

function SendAdHocModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [channel, setChannel] = useState<NotificationChannel>('whatsapp');
  const [recipient, setRecipient] = useState('');
  const [body, setBody] = useState('');

  const sendM = useMutation({
    mutationFn: () =>
      notificationsApi.sendAdHoc({ channel, recipient, body }),
    onSuccess: () => {
      toast.success('تم الإرسال');
      qc.invalidateQueries({ queryKey: ['notifications'] });
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الإرسال'),
  });

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="card max-w-md w-full p-6 space-y-3">
        <h3 className="text-xl font-black">إرسال إشعار فوري</h3>
        <div>
          <label className="label">القناة</label>
          <div className="flex gap-2">
            {(['whatsapp', 'sms', 'email'] as NotificationChannel[]).map((c) => {
              const Icon = CHANNEL_ICONS[c];
              return (
                <button
                  key={c}
                  onClick={() => setChannel(c)}
                  className={`flex-1 p-3 rounded-lg font-semibold flex items-center justify-center gap-2 ${
                    channel === c
                      ? 'bg-brand-600 text-white'
                      : 'bg-slate-100 text-slate-700'
                  }`}
                >
                  <Icon size={16} />
                  {CHANNEL_LABELS[c]}
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <label className="label">
            {channel === 'email' ? 'البريد الإلكتروني' : 'رقم الهاتف (E.164)'}
          </label>
          <input
            className="input"
            placeholder={channel === 'email' ? 'name@domain.com' : '+20100...'}
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
          />
        </div>
        <div>
          <label className="label">النص</label>
          <textarea
            className="input"
            rows={5}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </div>
        <div className="flex gap-2 pt-2">
          <button className="flex-1 btn-secondary" onClick={onClose}>
            إلغاء
          </button>
          <button
            className="flex-1 btn-primary"
            disabled={!recipient || !body || sendM.isPending}
            onClick={() => sendM.mutate()}
          >
            {sendM.isPending ? 'جارٍ الإرسال...' : 'إرسال'}
          </button>
        </div>
      </div>
    </div>
  );
}

function TemplateEditorModal({
  template,
  onClose,
}: {
  template: NotificationTemplate;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState(template);

  const saveM = useMutation({
    mutationFn: () => notificationsApi.upsertTemplate(form),
    onSuccess: () => {
      toast.success('تم الحفظ');
      qc.invalidateQueries({ queryKey: ['notification-templates'] });
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الحفظ'),
  });

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="card max-w-xl w-full p-6 space-y-3 max-h-[90vh] overflow-y-auto">
        <h3 className="text-xl font-black">
          {template.id ? 'تحرير قالب' : 'قالب جديد'}
        </h3>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">الرمز (code)</label>
            <input
              className="input font-mono"
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
              disabled={!!template.id}
            />
          </div>
          <div>
            <label className="label">الاسم</label>
            <input
              className="input"
              value={form.name_ar}
              onChange={(e) => setForm({ ...form, name_ar: e.target.value })}
            />
          </div>
        </div>

        <div>
          <label className="label">القناة</label>
          <select
            className="input"
            value={form.channel}
            onChange={(e) =>
              setForm({ ...form, channel: e.target.value as NotificationChannel })
            }
          >
            {(Object.keys(CHANNEL_LABELS) as NotificationChannel[]).map((c) => (
              <option key={c} value={c}>
                {CHANNEL_LABELS[c]}
              </option>
            ))}
          </select>
        </div>

        {form.channel === 'email' && (
          <div>
            <label className="label">الموضوع</label>
            <input
              className="input"
              value={form.subject || ''}
              onChange={(e) => setForm({ ...form, subject: e.target.value })}
            />
          </div>
        )}

        <div>
          <label className="label">النص (placeholders: {`{{var_name}}`})</label>
          <textarea
            className="input font-mono text-sm"
            rows={10}
            value={form.body}
            onChange={(e) => setForm({ ...form, body: e.target.value })}
          />
          <div className="text-xs text-slate-500 mt-1">
            المتغيرات المتاحة عادةً:
            <code className="mx-1">{'{{customer_name}}'}</code>,
            <code className="mx-1">{'{{doc_no}}'}</code>,
            <code className="mx-1">{'{{grand_total}}'}</code>,
            <code className="mx-1">{'{{shop_name}}'}</code>
          </div>
        </div>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={form.is_active}
            onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
          />
          <span>مفعل</span>
        </label>

        <div className="flex gap-2 pt-2">
          <button className="flex-1 btn-secondary" onClick={onClose}>
            إلغاء
          </button>
          <button
            className="flex-1 btn-primary"
            onClick={() => saveM.mutate()}
            disabled={!form.code || !form.name_ar || !form.body || saveM.isPending}
          >
            {saveM.isPending ? 'جارٍ الحفظ...' : 'حفظ'}
          </button>
        </div>
      </div>
    </div>
  );
}

function NotificationDetailModal({
  row,
  onClose,
}: {
  row: NotificationRecord;
  onClose: () => void;
}) {
  const meta = STATUS_META[row.status];
  const StatusIcon = meta.icon;
  const ChannelIcon = CHANNEL_ICONS[row.channel];

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="card max-w-xl w-full p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xl font-black flex items-center gap-2">
            <ChannelIcon size={20} className="text-brand-600" />
            تفاصيل الإشعار
          </h3>
          <button className="btn-ghost" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="space-y-2 text-sm">
          <Row label="الحالة">
            <span className={`chip ${meta.color} inline-flex items-center gap-1`}>
              <StatusIcon size={12} />
              {meta.label}
            </span>
          </Row>
          <Row label="القناة">{CHANNEL_LABELS[row.channel]}</Row>
          <Row label="المستقبل">
            <span className="font-mono">{row.recipient}</span>
          </Row>
          {row.template_code && (
            <Row label="القالب">
              <span className="font-mono">{row.template_code}</span>
            </Row>
          )}
          {row.subject && <Row label="الموضوع">{row.subject}</Row>}
          {row.reference_type && (
            <Row label="المرجع">
              {row.reference_type} — <code className="text-xs">{row.reference_id}</code>
            </Row>
          )}
          <Row label="محاولات">{row.attempts}</Row>
          <Row label="أنشئ">{fmtDate(row.created_at)}</Row>
          {row.sent_at && <Row label="أُرسل">{fmtDate(row.sent_at)}</Row>}
          {row.provider && <Row label="المزود">{row.provider}</Row>}
          {row.provider_msg_id && (
            <Row label="معرّف المزود">
              <code className="text-xs">{row.provider_msg_id}</code>
            </Row>
          )}
          {row.last_error && (
            <div className="bg-rose-50 border border-rose-200 rounded-lg p-3 text-rose-700 text-xs">
              <strong>خطأ:</strong> {row.last_error}
            </div>
          )}
          <div>
            <div className="text-xs text-slate-500 mb-1">النص:</div>
            <pre className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs whitespace-pre-wrap">
              {row.body}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-slate-100 pb-1">
      <div className="text-slate-500 text-xs">{label}</div>
      <div className="text-slate-800 text-sm text-left">{children}</div>
    </div>
  );
}
