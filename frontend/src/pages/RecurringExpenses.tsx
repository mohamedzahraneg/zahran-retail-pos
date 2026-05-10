import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
// PR-FE-IDEM-FINAL-OPS (Sprint 5 / FE-IDEM PR 8) — per-click reset
// hooks for the two recurring-expenses mutation routes:
//   · runM        → POST /recurring-expenses/:id/run
//   · processDueM → POST /recurring-expenses/process-due
// Independent keys; each row-button click on "توليد الآن" mints a new
// key for the run flow, and each click on the page-level "معالجة
// المستحق" button mints a new key for the process-due flow.
import {
  resetRecurringRunIdempotencyKey,
  resetRecurringProcessDueIdempotencyKey,
} from '@/lib/final-ops-idempotency';
import {
  Repeat,
  Plus,
  Pause,
  Play,
  Trash2,
  Zap,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Clock,
  X,
  DollarSign,
  History,
  FileText,
  CalendarClock,
  CalendarOff,
} from 'lucide-react';
import {
  recurringExpensesApi,
  RecurringExpense,
  RecurringExpenseRun,
  CreateRecurringExpenseInput,
  Frequency,
} from '@/api/recurringExpenses.api';
import { accountingApi } from '@/api/accounting.api';
import { settingsApi } from '@/api/settings.api';

const FREQUENCY_LABEL: Record<Frequency, string> = {
  daily: 'يومي',
  weekly: 'أسبوعي',
  biweekly: 'كل أسبوعين',
  monthly: 'شهري',
  quarterly: 'ربع سنوي',
  semiannual: 'نصف سنوي',
  annual: 'سنوي',
  custom_days: 'مخصص',
};

// ─── Generation-behavior model ──────────────────────────────────────
//
// PR-A v2 — collapse the three confusing booleans
//   (auto_post · auto_paid · require_approval)
// into one "سلوك التوليد" radio with four self-describing options.
// The radio value is FE-only; the payload sent to the BE keeps the
// existing three flags so no schema / API change is needed.

type GenerationBehavior =
  | 'draft'        // مسودة للمراجعة — operator opens + approves manually
  | 'auto_post'    // اعتماد تلقائي بدون دفع — JE posted DR-expense / CR-AP
  | 'auto_paid'    // اعتماد ودفع تلقائي — JE posted + cash leg fires
  | 'approval';    // يحتاج اعتماد ثم دفع — lands in approval inbox

interface BehaviorFlags {
  auto_post: boolean;
  auto_paid: boolean;
  require_approval: boolean;
}

const BEHAVIOR_LABEL: Record<GenerationBehavior, string> = {
  draft: 'مسودة للمراجعة',
  auto_post: 'اعتماد تلقائي بدون دفع',
  auto_paid: 'اعتماد ودفع تلقائي',
  approval: 'يحتاج اعتماد ثم دفع',
};

const BEHAVIOR_HINT: Record<GenerationBehavior, string> = {
  draft:
    'يُولَّد المصروف كمسودة بدون اعتماد ولا حركة نقدية. تظهر في قائمة المصروفات لمراجعتها يدويًا.',
  auto_post:
    'يُولَّد ويُعتمد آليًا. يُسجَّل القيد المحاسبي (مدين: المصروف / دائن: حساب الموردين) دون خصم نقدية.',
  auto_paid:
    'يُولَّد ويُعتمد آليًا ويُخصم من الخزنة المحددة فورًا (مدين: المصروف / دائن: الخزنة).',
  approval:
    'يُولَّد كطلب اعتماد ويظهر في صندوق الاعتمادات. عند الاعتماد يُسجَّل القيد ويُخصم من الخزنة إن كان نقديًا.',
};

export function flagsToBehavior(f: Pick<RecurringExpense, 'auto_post' | 'auto_paid' | 'require_approval'>): GenerationBehavior {
  if (f.require_approval) return 'approval';
  if (f.auto_post && f.auto_paid) return 'auto_paid';
  if (f.auto_post) return 'auto_post';
  return 'draft';
}

export function behaviorToFlags(b: GenerationBehavior): BehaviorFlags {
  switch (b) {
    case 'draft':
      return { auto_post: false, auto_paid: false, require_approval: false };
    case 'auto_post':
      return { auto_post: true, auto_paid: false, require_approval: false };
    case 'auto_paid':
      return { auto_post: true, auto_paid: true, require_approval: false };
    case 'approval':
      // Stay false on auto_post so runOne() does not try to bypass
      // the approval inbox; the inserted expense row preserves the
      // template's cashbox so the post-approval engine call posts
      // the cash leg correctly.
      return { auto_post: false, auto_paid: false, require_approval: true };
  }
}

// ─── Due-status filter ──────────────────────────────────────────────

type DueFilter =
  | 'all'
  | 'due_now'
  | 'due_7d'
  | 'overdue'
  | 'paused'
  | 'ended';

const DUE_FILTER_LABEL: Record<DueFilter, string> = {
  all: 'الكل',
  due_now: 'مستحقة الآن',
  due_7d: 'خلال 7 أيام',
  overdue: 'متأخرة',
  paused: 'موقوفة',
  ended: 'منتهية',
};

/** Pure helper — applied client-side to the rows returned by the list
 *  endpoint.  Operates on `due_status` + `days_overdue` + `status`
 *  fields the BE already exposes, so no schema change is required. */
export function filterRowsByDue(
  rows: ReadonlyArray<RecurringExpense>,
  filter: DueFilter,
): RecurringExpense[] {
  if (filter === 'all') return rows.filter((r) => r.status !== 'ended');
  if (filter === 'paused') return rows.filter((r) => r.status === 'paused');
  if (filter === 'ended') return rows.filter((r) => r.status === 'ended');
  if (filter === 'overdue')
    return rows.filter(
      (r) =>
        r.status === 'active' &&
        r.due_status === 'due' &&
        (r.days_overdue ?? 0) > 0,
    );
  if (filter === 'due_now')
    return rows.filter(
      (r) =>
        r.status === 'active' &&
        r.due_status === 'due' &&
        (r.days_overdue ?? 0) <= 0,
    );
  // due_7d — upcoming OR due-but-not-overdue
  return rows.filter(
    (r) =>
      r.status === 'active' &&
      (r.due_status === 'upcoming' ||
        (r.due_status === 'due' && (r.days_overdue ?? 0) <= 0)),
  );
}

// ─── Page ────────────────────────────────────────────────────────────

export default function RecurringExpenses() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<RecurringExpense | null>(null);
  const [dueFilter, setDueFilter] = useState<DueFilter>('all');
  const [drawerId, setDrawerId] = useState<string | null>(null);

  // The list query always fetches non-ended templates; client-side
  // filter pills slice further (avoids a query-key explosion).  The
  // `ended` filter triggers a separate query with `status=ended` so
  // the list still works for historical templates.
  const listParams =
    dueFilter === 'ended'
      ? { status: 'ended' as const }
      : ({} as Record<string, never>);
  const { data: itemsRaw = [], isLoading } = useQuery({
    queryKey: ['recurring-expenses', dueFilter === 'ended' ? 'ended' : 'active'],
    queryFn: () => recurringExpensesApi.list(listParams),
  });

  const items = useMemo(
    () => filterRowsByDue(itemsRaw, dueFilter),
    [itemsRaw, dueFilter],
  );

  const { data: stats } = useQuery({
    queryKey: ['recurring-expenses-stats'],
    queryFn: recurringExpensesApi.stats,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['recurring-expenses'] });
    qc.invalidateQueries({ queryKey: ['recurring-expenses-stats'] });
    if (drawerId) qc.invalidateQueries({ queryKey: ['recurring-expense', drawerId] });
  };

  const pauseM = useMutation({
    mutationFn: (id: string) => recurringExpensesApi.pause(id),
    onSuccess: () => { toast.success('تم الإيقاف المؤقت'); invalidate(); },
  });
  const resumeM = useMutation({
    mutationFn: (id: string) => recurringExpensesApi.resume(id),
    onSuccess: () => { toast.success('تم الاستئناف'); invalidate(); },
  });
  const removeM = useMutation({
    mutationFn: (id: string) => recurringExpensesApi.remove(id),
    onSuccess: () => { toast.success('تم الإنهاء'); invalidate(); },
  });
  const runM = useMutation({
    mutationFn: (id: string) => recurringExpensesApi.run(id),
    onSuccess: (r: any) => {
      if (r.generated) toast.success('تم توليد المصروف');
      else toast(`${r.reason || 'لم يُولد'}`);
      invalidate();
    },
    onError: (e: any) => toast.error(e?.message || 'فشل التوليد'),
  });
  const processDueM = useMutation({
    mutationFn: () => recurringExpensesApi.processDue(),
    onSuccess: (r) => {
      toast.success(`تم: ${r.ok} نجاح · ${r.failed} فشل (من ${r.total})`);
      invalidate();
    },
  });

  return (
    <div className="space-y-6" dir="rtl" data-testid="recurring-expenses-page">
      {/* Header — title pinned to the right at all breakpoints (RTL).
          PR-A: no lg:order-* swap that flipped the title left on
          desktop. */}
      <header
        className="flex items-start justify-between gap-3 flex-wrap"
        data-testid="recurring-expenses-header"
      >
        <div className="order-1 flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-brand-50 dark:bg-brand-900/40 text-brand-700 dark:text-brand-300 flex items-center justify-center shrink-0">
            <Repeat size={20} />
          </div>
          <div className="text-right">
            <h1 className="text-2xl font-black text-slate-800 dark:text-slate-100">
              المصروفات الدورية
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 max-w-2xl leading-relaxed">
              قوالب المصروفات المتكررة (إيجار، اشتراكات، كهرباء…). كل
              قالب يولّد مصروفًا عاديًا في الموعد المحدد ويسير في نفس
              مسار العمل: مسودة / اعتماد / دفع.
            </p>
          </div>
        </div>

        <div className="order-2 flex items-center gap-2">
          <button
            className="btn-secondary"
            disabled={processDueM.isPending}
            data-testid="recurring-process-due-btn"
            onClick={() => {
              // PR-FE-IDEM-FINAL-OPS — fresh Idempotency-Key per click
              // intent for the page-level "process all due" batch.
              resetRecurringProcessDueIdempotencyKey();
              processDueM.mutate();
            }}
          >
            {processDueM.isPending ? (
              <RefreshCw size={16} className="animate-spin" />
            ) : (
              <Zap size={16} />
            )}
            <span>معالجة المستحق</span>
          </button>
          <button
            className="btn-primary"
            data-testid="recurring-new-template-btn"
            onClick={() => {
              setEditing(null);
              setShowForm(true);
            }}
          >
            <Plus size={16} /> قالب جديد
          </button>
        </div>
      </header>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3" data-testid="recurring-stats">
          <StatCard label="نشطة" value={stats.active_templates} color="bg-emerald-100 text-emerald-800" icon={<CheckCircle2 size={16} />} />
          <StatCard label="متوقفة" value={stats.paused_templates} color="bg-amber-100 text-amber-800" icon={<Pause size={16} />} />
          <StatCard label="مستحقة الآن" value={stats.due_now} color="bg-rose-100 text-rose-800" icon={<AlertTriangle size={16} />} />
          <StatCard label="خلال 7 أيام" value={stats.due_next_7_days} color="bg-sky-100 text-sky-800" icon={<Clock size={16} />} />
          <StatCard
            label="الالتزامات (تقديري)"
            value={Number(stats.monthly_commitment_estimate).toLocaleString('en-EG')}
            color="bg-brand-100 text-brand-800"
            icon={<DollarSign size={16} />}
          />
        </div>
      )}

      {/* Due-status filter pills */}
      <div
        className="card p-3 flex flex-wrap items-center gap-2"
        data-testid="recurring-filters"
      >
        <span className="text-xs font-bold text-slate-500 ms-1">عرض:</span>
        {(Object.keys(DUE_FILTER_LABEL) as DueFilter[]).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setDueFilter(k)}
            data-testid={`recurring-filter-${k}`}
            className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
              dueFilter === k
                ? 'bg-brand-600 text-white shadow-sm'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200'
            }`}
          >
            {DUE_FILTER_LABEL[k]}
          </button>
        ))}
        <span
          className="text-[10px] text-slate-400 dark:text-slate-500 ms-auto"
          data-testid="recurring-filter-count"
        >
          {items.length} عنصر
        </span>
      </div>

      {/* List */}
      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="p-10 text-center text-slate-400">
            <RefreshCw className="animate-spin mx-auto mb-2" />
            جارٍ التحميل…
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            isFilterEmpty={itemsRaw.length > 0}
            onCreate={() => {
              setEditing(null);
              setShowForm(true);
            }}
          />
        ) : (
          <table className="min-w-full text-sm" data-testid="recurring-table">
            <thead className="bg-slate-50 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              <tr>
                <th className="text-right px-3 py-2">الرمز</th>
                <th className="text-right px-3 py-2">الاسم</th>
                <th className="text-right px-3 py-2">الفئة</th>
                <th className="text-right px-3 py-2">التكرار</th>
                <th className="text-right px-3 py-2">المبلغ</th>
                <th className="text-right px-3 py-2">التاريخ القادم</th>
                <th className="text-right px-3 py-2">الحالة</th>
                <th className="text-right px-3 py-2">عدد المرّات</th>
                <th className="text-right px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                  <td className="px-3 py-2 font-mono text-xs">{r.code}</td>
                  <td className="px-3 py-2 font-bold">{r.name_ar}</td>
                  <td className="px-3 py-2">{r.category_name || '—'}</td>
                  <td className="px-3 py-2">{FREQUENCY_LABEL[r.frequency]}</td>
                  <td className="px-3 py-2 font-mono">
                    {Number(r.amount).toLocaleString('en-EG')} ج.م
                  </td>
                  <td className="px-3 py-2">
                    <DueBadge
                      date={r.next_run_date}
                      status={r.due_status}
                      daysOverdue={r.days_overdue}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-3 py-2 text-center">{r.runs_count}</td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1 justify-end">
                      <button
                        className="icon-btn"
                        title="عرض السجل"
                        data-testid={`recurring-history-${r.id}`}
                        onClick={() => setDrawerId(r.id)}
                      >
                        <History size={14} />
                      </button>
                      <button
                        className="icon-btn"
                        title="توليد الآن"
                        data-testid={`recurring-run-${r.id}`}
                        onClick={() => {
                          // PR-FE-IDEM-FINAL-OPS — fresh
                          // Idempotency-Key per click intent.
                          resetRecurringRunIdempotencyKey();
                          runM.mutate(r.id);
                        }}
                        disabled={r.status !== 'active' || runM.isPending}
                      >
                        <Zap size={14} />
                      </button>
                      <button
                        className="icon-btn"
                        title="تعديل"
                        onClick={() => {
                          setEditing(r);
                          setShowForm(true);
                        }}
                      >
                        <FileText size={14} />
                      </button>
                      {r.status === 'active' ? (
                        <button
                          className="icon-btn"
                          title="إيقاف مؤقت"
                          onClick={() => pauseM.mutate(r.id)}
                        >
                          <Pause size={14} />
                        </button>
                      ) : r.status === 'paused' ? (
                        <button
                          className="icon-btn"
                          title="استئناف"
                          onClick={() => resumeM.mutate(r.id)}
                        >
                          <Play size={14} />
                        </button>
                      ) : null}
                      <button
                        className="icon-btn text-rose-600"
                        title="إنهاء"
                        onClick={() => {
                          if (confirm(`إنهاء القالب "${r.name_ar}"؟`)) removeM.mutate(r.id);
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showForm && (
        <RecurringExpenseFormModal
          onClose={() => setShowForm(false)}
          editing={editing}
          onSaved={() => {
            invalidate();
            setShowForm(false);
          }}
        />
      )}

      {drawerId && (
        <RunsHistoryDrawer
          templateId={drawerId}
          onClose={() => setDrawerId(null)}
        />
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
  icon,
}: {
  label: string;
  value: number | string;
  color: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className={`rounded-xl p-3 ${color}`}>
      <div className="text-xs opacity-80 flex items-center gap-1">
        {icon} {label}
      </div>
      <div className="font-black text-2xl mt-1">{value}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    active: 'bg-emerald-100 text-emerald-800',
    paused: 'bg-amber-100 text-amber-800',
    ended: 'bg-slate-200 text-slate-700',
  };
  const label: Record<string, string> = {
    active: 'نشطة',
    paused: 'متوقفة',
    ended: 'منتهية',
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${map[status] || ''}`}>
      {label[status] || status}
    </span>
  );
}

function DueBadge({
  date,
  status,
  daysOverdue,
}: {
  date: string;
  status?: string;
  daysOverdue?: number;
}) {
  const cls =
    status === 'due'
      ? 'bg-rose-100 text-rose-800'
      : status === 'upcoming'
      ? 'bg-amber-100 text-amber-800'
      : 'bg-slate-100 text-slate-600';
  return (
    <div>
      <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${cls}`}>
        {date}
      </span>
      {status === 'due' && daysOverdue != null && daysOverdue > 0 && (
        <div className="text-[10px] text-rose-700 mt-0.5">
          متأخر {daysOverdue} يوم
        </div>
      )}
    </div>
  );
}

// ─── Empty state ────────────────────────────────────────────────────

function EmptyState({
  isFilterEmpty,
  onCreate,
}: {
  isFilterEmpty: boolean;
  onCreate: () => void;
}) {
  if (isFilterEmpty) {
    // Items exist but the current filter eliminated all of them.
    return (
      <div
        className="p-10 text-center text-slate-400"
        data-testid="recurring-empty-filter"
      >
        لا توجد قوالب تطابق هذا الفلتر — جرّب فلترًا آخر.
      </div>
    );
  }
  return (
    <div
      className="p-6 lg:p-8"
      data-testid="recurring-empty"
      dir="rtl"
    >
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-brand-50 text-brand-700 flex items-center justify-center shrink-0">
          <Repeat size={20} />
        </div>
        <div className="flex-1">
          <div className="text-sm font-bold text-slate-700 dark:text-slate-200">
            ابدأ بإضافة قالب مصروف دوري
          </div>
          <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
            قوالب المصروفات الدورية تتحول إلى مصروفات عادية في الموعد
            المحدد، وتسير في نفس مسار الاعتماد والدفع المعتاد. لا توجد
            مسارات محاسبية موازية.
          </div>
        </div>
      </div>

      <ol
        className="mt-5 grid grid-cols-1 sm:grid-cols-3 gap-3 text-right"
        data-testid="recurring-empty-steps"
      >
        <Step n={1} title="أضف قالب مصروف دوري">
          اختر الفئة والخزنة والمبلغ، ثم حدد التكرار (شهري / أسبوعي /
          مخصص...). يمكن تعديل القالب أو إيقافه لاحقًا في أي وقت.
        </Step>
        <Step n={2} title="راجع الاستحقاق القادم">
          النظام يحسب التاريخ القادم تلقائيًا ويعرضه هنا. التنبيهات
          تظهر قبل الاستحقاق بعدد الأيام الذي تحدده.
        </Step>
        <Step n={3} title="ولّد المصروف أو اتركه تلقائيًا">
          اضغط "توليد الآن" يدويًا، أو فعّل "اعتماد تلقائي" ليقوم
          النظام بالتوليد كل يوم في الساعة 8 صباحًا. المصروف يدخل قائمة
          المصروفات العادية بنفس مسار الاعتماد والدفع.
        </Step>
      </ol>

      <div className="mt-5 flex justify-center">
        <button
          type="button"
          className="btn-primary"
          data-testid="recurring-empty-cta"
          onClick={onCreate}
        >
          <Plus size={16} /> قالب جديد
        </button>
      </div>
    </div>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li
      className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3"
      data-testid={`recurring-empty-step-${n}`}
    >
      <div className="flex items-center gap-2">
        <span className="w-6 h-6 rounded-full bg-brand-100 dark:bg-brand-900/40 text-brand-700 dark:text-brand-300 flex items-center justify-center text-[11px] font-black">
          {n}
        </span>
        <span className="text-xs font-bold text-slate-800 dark:text-slate-100">
          {title}
        </span>
      </div>
      <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1.5 leading-relaxed">
        {children}
      </p>
    </li>
  );
}

// ─── Runs history drawer ────────────────────────────────────────────

function RunsHistoryDrawer({
  templateId,
  onClose,
}: {
  templateId: string;
  onClose: () => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['recurring-expense', templateId],
    queryFn: () => recurringExpensesApi.get(templateId),
  });

  return (
    <div
      className="fixed inset-0 bg-black/50 z-50 flex items-start justify-end"
      onClick={onClose}
      data-testid="recurring-history-drawer"
    >
      <div
        className="bg-white dark:bg-slate-900 h-full w-full max-w-md overflow-auto shadow-2xl"
        dir="rtl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-slate-100 dark:border-slate-800 sticky top-0 bg-white dark:bg-slate-900 z-10">
          <div className="flex items-center gap-2">
            <History size={18} className="text-brand-600" />
            <h3 className="font-black text-base">سجل التنفيذ</h3>
          </div>
          <button className="icon-btn" onClick={onClose} data-testid="recurring-history-close">
            <X size={18} />
          </button>
        </div>

        {isLoading ? (
          <div className="p-10 text-center text-slate-400">
            <RefreshCw className="animate-spin mx-auto mb-2" />
            جارٍ التحميل…
          </div>
        ) : error ? (
          <div className="p-6 text-center text-rose-700">
            <AlertTriangle className="mx-auto mb-2" /> تعذّر التحميل
          </div>
        ) : data ? (
          <div>
            <div className="p-4 border-b border-slate-100 dark:border-slate-800 space-y-2">
              <div className="text-sm font-bold text-slate-800 dark:text-slate-100">
                {data.name_ar}
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400 flex flex-wrap gap-3">
                <span className="inline-flex items-center gap-1">
                  <CalendarClock size={12} />
                  القادم: {data.next_run_date}
                </span>
                <span className="inline-flex items-center gap-1">
                  <DollarSign size={12} />
                  {Number(data.amount).toLocaleString('en-EG')} ج.م
                </span>
                <span className="inline-flex items-center gap-1">
                  <Repeat size={12} />
                  {FREQUENCY_LABEL[data.frequency]}
                </span>
              </div>
            </div>
            <div className="p-4" data-testid="recurring-history-runs">
              {data.runs.length === 0 ? (
                <div className="py-8 text-center text-slate-400 text-sm flex flex-col items-center gap-2">
                  <CalendarOff size={20} />
                  لم يُنفَّذ هذا القالب بعد.
                </div>
              ) : (
                <ul className="space-y-2">
                  {data.runs.map((run) => (
                    <RunRow key={run.id} run={run} />
                  ))}
                </ul>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function RunRow({ run }: { run: RecurringExpenseRun }) {
  const statusCls =
    run.status === 'generated'
      ? 'bg-emerald-100 text-emerald-800'
      : run.status === 'failed'
      ? 'bg-rose-100 text-rose-800'
      : run.status === 'skipped'
      ? 'bg-amber-100 text-amber-800'
      : 'bg-slate-100 text-slate-700';
  const statusLabel =
    run.status === 'generated'
      ? 'تم التوليد'
      : run.status === 'failed'
      ? 'فشل'
      : run.status === 'skipped'
      ? 'تم التخطي'
      : 'يدوي';
  return (
    <li
      className="rounded-xl border border-slate-200 dark:border-slate-700 p-3"
      data-testid="recurring-history-run"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-1">
          <div className="text-xs font-bold text-slate-700 dark:text-slate-200 flex items-center gap-1">
            <CalendarClock size={11} /> {run.scheduled_for}
          </div>
          {run.expense_no && (
            <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
              {run.expense_no}
            </div>
          )}
          <div className="text-[11px] text-slate-500 dark:text-slate-400">
            {Number(run.amount).toLocaleString('en-EG')} ج.م
          </div>
        </div>
        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${statusCls}`}>
          {statusLabel}
        </span>
      </div>
      {run.error_message && (
        <div className="mt-2 text-[11px] text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-900/20 rounded p-2 flex items-start gap-1">
          <AlertTriangle size={11} className="mt-0.5 flex-shrink-0" />
          {run.error_message}
        </div>
      )}
    </li>
  );
}

// ─── Form Modal ────────────────────────────────────────────────────

function RecurringExpenseFormModal({
  editing,
  onClose,
  onSaved,
}: {
  editing: RecurringExpense | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<CreateRecurringExpenseInput>({
    code: editing?.code || '',
    name_ar: editing?.name_ar || '',
    name_en: editing?.name_en || '',
    category_id: editing?.category_id || '',
    warehouse_id: editing?.warehouse_id || '',
    cashbox_id: editing?.cashbox_id || undefined,
    amount: editing?.amount || 0,
    payment_method: editing?.payment_method || 'cash',
    vendor_name: editing?.vendor_name || '',
    description: editing?.description || '',
    frequency: editing?.frequency || 'monthly',
    custom_interval_days: editing?.custom_interval_days,
    day_of_month: editing?.day_of_month,
    start_date: editing?.start_date || new Date().toISOString().slice(0, 10),
    end_date: editing?.end_date,
    auto_post: editing?.auto_post ?? true,
    auto_paid: editing?.auto_paid ?? false,
    notify_days_before: editing?.notify_days_before ?? 3,
    require_approval: editing?.require_approval ?? false,
  });

  // Initialize behavior radio from existing flags (or sensible default
  // for new templates: "اعتماد ودفع تلقائي" → most common workflow).
  const [behavior, setBehavior] = useState<GenerationBehavior>(() =>
    editing ? flagsToBehavior(editing) : 'auto_paid',
  );

  const onBehaviorChange = (b: GenerationBehavior) => {
    setBehavior(b);
    setForm((f) => ({ ...f, ...behaviorToFlags(b) }));
  };

  const { data: categories = [] } = useQuery({
    queryKey: ['expense-categories'],
    queryFn: accountingApi.categories,
  });

  const { data: warehouses = [] } = useQuery({
    queryKey: ['warehouses'],
    queryFn: async () => {
      try {
        return await settingsApi.listWarehouses();
      } catch {
        return [];
      }
    },
  });

  const saveM = useMutation({
    mutationFn: () =>
      editing
        ? recurringExpensesApi.update(editing.id, form)
        : recurringExpensesApi.create(form),
    onSuccess: () => {
      toast.success(editing ? 'تم التحديث' : 'تم الإنشاء');
      onSaved();
    },
    onError: (e: any) => toast.error(e?.message || 'فشل الحفظ'),
  });

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-900 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-auto" dir="rtl">
        <div className="flex items-center justify-between p-4 border-b border-slate-100 dark:border-slate-800">
          <h3 className="font-black text-lg">
            {editing ? 'تعديل قالب مصروف' : 'قالب مصروف دوري جديد'}
          </h3>
          <button className="icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="الرمز" required>
              <input
                className="input"
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
                placeholder="RENT-CAIRO-01"
              />
            </Field>
            <Field label="الاسم بالعربية" required>
              <input
                className="input"
                value={form.name_ar}
                onChange={(e) => setForm({ ...form, name_ar: e.target.value })}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="الفئة" required>
              <select
                className="input"
                value={form.category_id}
                onChange={(e) => setForm({ ...form, category_id: e.target.value })}
              >
                <option value="">— اختر —</option>
                {categories.map((c: any) => (
                  <option key={c.id} value={c.id}>
                    {c.name_ar}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="المخزن" required>
              <select
                className="input"
                value={form.warehouse_id}
                onChange={(e) => setForm({ ...form, warehouse_id: e.target.value })}
              >
                <option value="">— اختر —</option>
                {warehouses.map((w: any) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Field label="المبلغ" required>
              <input
                type="number"
                className="input"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: Number(e.target.value) })}
              />
            </Field>
            <Field label="طريقة الدفع">
              <select
                className="input"
                value={form.payment_method}
                onChange={(e) => setForm({ ...form, payment_method: e.target.value })}
              >
                <option value="cash">نقدي</option>
                <option value="card">بطاقة</option>
                <option value="instapay">انستاباي</option>
                <option value="wallet">محفظة</option>
                <option value="bank_transfer">حوالة</option>
              </select>
            </Field>
            <Field label="اسم المستفيد">
              <input
                className="input"
                value={form.vendor_name || ''}
                onChange={(e) => setForm({ ...form, vendor_name: e.target.value })}
              />
            </Field>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Field label="التكرار" required>
              <select
                className="input"
                value={form.frequency}
                onChange={(e) => setForm({ ...form, frequency: e.target.value as Frequency })}
              >
                {(Object.keys(FREQUENCY_LABEL) as Frequency[]).map((f) => (
                  <option key={f} value={f}>
                    {FREQUENCY_LABEL[f]}
                  </option>
                ))}
              </select>
            </Field>
            {form.frequency === 'custom_days' && (
              <Field label="كل كم يوم؟">
                <input
                  type="number"
                  className="input"
                  value={form.custom_interval_days || ''}
                  onChange={(e) =>
                    setForm({ ...form, custom_interval_days: Number(e.target.value) })
                  }
                />
              </Field>
            )}
            {['monthly', 'quarterly', 'semiannual', 'annual'].includes(form.frequency) && (
              <Field label="يوم الشهر (1..31)">
                <input
                  type="number"
                  min={1}
                  max={31}
                  className="input"
                  value={form.day_of_month || ''}
                  onChange={(e) =>
                    setForm({ ...form, day_of_month: Number(e.target.value) || undefined })
                  }
                />
              </Field>
            )}
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Field label="تاريخ البداية" required>
              <input
                type="date"
                className="input"
                value={form.start_date}
                onChange={(e) => setForm({ ...form, start_date: e.target.value })}
              />
            </Field>
            <Field label="تاريخ الانتهاء (اختياري)">
              <input
                type="date"
                className="input"
                value={form.end_date || ''}
                onChange={(e) => setForm({ ...form, end_date: e.target.value })}
              />
            </Field>
            <Field label="تنبيه قبل (أيام)">
              <input
                type="number"
                className="input"
                value={form.notify_days_before}
                onChange={(e) =>
                  setForm({ ...form, notify_days_before: Number(e.target.value) })
                }
              />
            </Field>
          </div>

          <Field label="الوصف">
            <textarea
              className="input"
              rows={2}
              value={form.description || ''}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </Field>

          {/* Generation-behavior radio group — collapses the
              auto_post / auto_paid / require_approval triplet into
              one self-describing choice. */}
          <fieldset
            className="rounded-xl border border-slate-200 dark:border-slate-700 p-3"
            data-testid="recurring-behavior-fieldset"
          >
            <legend className="text-xs font-bold text-slate-600 dark:text-slate-300 px-1">
              سلوك التوليد
            </legend>
            <div className="space-y-2 mt-1">
              {(Object.keys(BEHAVIOR_LABEL) as GenerationBehavior[]).map((b) => (
                <label
                  key={b}
                  className={`flex items-start gap-2 rounded-lg p-2.5 cursor-pointer border transition-colors ${
                    behavior === b
                      ? 'border-brand-300 bg-brand-50 dark:bg-brand-900/30'
                      : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'
                  }`}
                >
                  <input
                    type="radio"
                    name="generation-behavior"
                    value={b}
                    checked={behavior === b}
                    onChange={() => onBehaviorChange(b)}
                    data-testid={`recurring-behavior-${b}`}
                    className="mt-1"
                  />
                  <div>
                    <div className="text-sm font-bold text-slate-800 dark:text-slate-100">
                      {BEHAVIOR_LABEL[b]}
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
                      {BEHAVIOR_HINT[b]}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <div className="p-4 border-t border-slate-100 dark:border-slate-800 flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>إلغاء</button>
          <button
            className="btn-primary"
            data-testid="recurring-save-btn"
            disabled={saveM.isPending || !form.code || !form.name_ar || !form.category_id || !form.warehouse_id}
            onClick={() => saveM.mutate()}
          >
            {saveM.isPending ? 'جارٍ الحفظ…' : editing ? 'تحديث' : 'حفظ'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-xs font-bold text-slate-600 dark:text-slate-300 block mb-1">
        {label} {required && <span className="text-rose-500">*</span>}
      </label>
      {children}
    </div>
  );
}
