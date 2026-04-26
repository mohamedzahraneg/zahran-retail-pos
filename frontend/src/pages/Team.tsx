import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Users,
  Users2,
  Wallet,
  Search,
  DollarSign,
  Clock,
  ListPlus,
  Gift,
  Minus,
  ClipboardList,
  CheckCircle2,
  XCircle,
  Settings,
  Eye,
  ArrowLeft,
  Banknote,
  Receipt,
  TrendingDown,
  CalendarCheck,
  FileBarChart,
  Wallet2,
} from 'lucide-react';
import {
  employeesApi,
  TeamRow,
  EmployeeRequest,
  EmployeeDashboard,
} from '@/api/employees.api';
import { attendanceApi } from '@/api/attendance.api';
import { commissionsApi } from '@/api/commissions.api';
import { useAuthStore } from '@/stores/auth.store';
// PR-T2 — redesigned attendance / wage approval tab. Lives in its own
// file to keep Team.tsx focused on the workspace shell. The legacy
// AdminAttendancePanel is left untouched for the legacy ?tab=
// fallback paths (deletion deferred to PR-T6).
import { AttendanceWageTab } from '@/components/team/AttendanceWageTab';
// PR-T3 — redesigned per-employee accounts tab. The no-employee
// fallback (?section=accounts without ?employee) keeps rendering the
// legacy team-wide <Payroll /> embedded in the SectionHeader wrapper
// for compatibility — that's the team-wide balances view until the
// final PR-T6 cleanup.
import { AccountsMovementsTab } from '@/components/team/AccountsMovementsTab';
// PR-T4 — Approvals + audit history tab. Handles both team-wide and
// per-employee modes. Replaces the legacy PendingInbox visual layout
// (PendingInbox function still exists in this file but is no longer
// rendered — PR-T6 cleanup will remove it).
import { ApprovalsAuditTab } from '@/components/team/ApprovalsAuditTab';
// PR-T4.1 — overview redesign per
// employee_overview_sales_performance_design.html, focused
// adjustments tab, and the Actions dropdown (task assignment etc.).
import { EmployeeOverviewTab } from '@/components/team/EmployeeOverviewTab';
import { EmployeeReportsTab } from '@/components/team/EmployeeReportsTab';
import { AdjustmentsTab } from '@/components/team/AdjustmentsTab';
// Payroll / حسابات الموظفين is now a tab inside /team (consolidation).
// The component is rendered verbatim — no design change. Its own
// useQuery hooks share the global TanStack cache, so mutations
// elsewhere in Team (BonusForm, DeductionForm) continue to live-
// refresh both tabs.
import Payroll from './Payroll';
// Attendance — same story (PR-2). Embedded as the "الحضور" tab.
// The standalone /attendance route is kept as a permanent redirect.
import { AttendanceBody } from './Attendance';
// AdminAttendancePanel is now rendered inside the team drawer (this PR)
// instead of on /me. Same component, same backend endpoints, same
// permission gate. The /me page no longer shows admin-on-behalf tools.
import { AdminAttendancePanel } from './EmployeeProfile';

const EGP = (n: number | string) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

const FREQ_LABEL = {
  daily: 'يومي',
  weekly: 'أسبوعي',
  monthly: 'شهري',
} as const;

function fmtHours(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}س ${String(m).padStart(2, '0')}د`;
}

function fmtWhen(s?: string) {
  if (!s) return '';
  const d = new Date(s);
  const dow = d.toLocaleDateString('ar-EG', {
    timeZone: 'Africa/Cairo',
    weekday: 'long',
  });
  const rest = d.toLocaleString('ar-EG', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
  return `${dow} · ${rest}`;
}

/**
 * إدارة فريق العمل — unified Team Management workspace (PR-T1).
 *
 * Layout:
 *   ┌─ Header (title + subtitle) ─────────────────────────────────┐
 *   │ KPI strip — 6 cards (real data from /employees/team +       │
 *   │  /attendance/summary today)                                  │
 *   │ ┌─────────────────┬──────────────────────────────────────┐  │
 *   │ │ Employee list   │ Profile panel                        │  │
 *   │ │ (search +       │  · header (avatar/info/balance)       │  │
 *   │ │  cards)         │  · mini-stats (4 cards)               │  │
 *   │ │                 │  · tabs (ملخص + 5 placeholders)       │  │
 *   │ └─────────────────┴──────────────────────────────────────┘  │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * Backward compat: the legacy ?tab=attendance / ?tab=accounts query
 * params are preserved so the /attendance and /payroll route redirects
 * keep working unchanged. New users land on the unified workspace by
 * default. The legacy embedded views (AttendanceBody / Payroll) will
 * be removed in PR-T6 once the new tabs are fully migrated.
 */
export default function Team() {
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const [searchParams, setSearchParams] = useSearchParams();
  // PR-T1.1 — `?section=` is the new param name (matches user spec).
  // `?tab=` is read for legacy URL compat (sidebar bookmarks etc.).
  // Both map onto the same set of profile-internal tabs; the new
  // shell is ALWAYS rendered (no full-page fallback to old standalone
  // Payroll/AttendanceBody pages).
  const rawSection = searchParams.get('section') ?? searchParams.get('tab');

  // Pending approvals — rendered inside the profile's موافقات tab.
  const { data: pending = [] } = useQuery({
    queryKey: ['employees-pending'],
    queryFn: () => employeesApi.pendingRequests(),
    enabled: hasPermission('employee.requests.approve'),
    refetchInterval: 30_000,
  });

  const { data: team = [] } = useQuery({
    queryKey: ['employees-team'],
    queryFn: () => employeesApi.team(),
    refetchInterval: 60_000,
  });

  // Today's attendance summary — drives the "حاضر اليوم" KPI.
  const today = useMemo(() => {
    const d = new Date();
    return d.toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' }); // YYYY-MM-DD
  }, []);
  const { data: todayRows = [] } = useQuery({
    queryKey: ['attendance-summary-today', today],
    queryFn: () => attendanceApi.summary(today, today),
    enabled: hasPermission('attendance.view_team'),
    refetchInterval: 60_000,
  });
  // attendance/summary returns one row per (user, day) with
  // present_minutes > 0 when clocked in. Count distinct present users.
  const presentToday = useMemo(() => {
    const set = new Set<string>();
    for (const r of (todayRows as any[]) || []) {
      if ((r?.minutes ?? r?.present_minutes ?? 0) > 0 && r?.user_id) {
        set.add(String(r.user_id));
      }
    }
    return set.size;
  }, [todayRows]);

  // Sign convention — gl_balance > 0 means employee owes company;
  // < 0 means company owes employee. We aggregate per-direction so
  // KPIs match the wording the user expects.
  const totals = useMemo(() => {
    let totalEmployees = team.length;
    let totalPayable = 0;     // company owes employees (sum of negative gl)
    let totalEmployeeDebt = 0; // employees owe company (proxy for "سلف")
    let totalAdvancesMonth = 0;
    let totalBonusesMonth = 0;
    for (const t of team as TeamRow[]) {
      const gl = Number(t.gl_balance || 0);
      if (gl < -0.01) totalPayable += -gl;
      else if (gl > 0.01) totalEmployeeDebt += gl;
      totalAdvancesMonth += Number(t.advances_this_month || 0);
      totalBonusesMonth += Number(t.bonuses_this_month || 0);
    }
    return {
      totalEmployees,
      totalPayable,
      totalEmployeeDebt,
      totalAdvancesMonth,
      totalBonusesMonth,
      // المتبقي للموظفين = صافي ما تدين به الشركة لفريق العمل
      netRemaining: totalPayable - totalEmployeeDebt,
    };
  }, [team]);

  // Selected employee — controlled via ?employee=<id> for deep-link.
  const selectedId = searchParams.get('employee');
  const selected = useMemo(
    () => (team as TeamRow[]).find((t) => t.id === selectedId) || null,
    [team, selectedId],
  );
  const setSelectedId = (id: string | null) => {
    const sp = new URLSearchParams(searchParams);
    if (id) sp.set('employee', id);
    else sp.delete('employee');
    setSearchParams(sp, { replace: true });
  };

  // Auto-select the first employee ONLY when:
  //   · the user didn't deep-link to a section (otherwise the section
  //     was meant as a team-wide view — see EmployeeProfilePanel below
  //     for the no-employee + section path), AND
  //   · the team has rows.
  // Saves a click on the most common landing path (/team default).
  useEffect(() => {
    if (!selectedId && !rawSection && team.length > 0) {
      setSelectedId((team as TeamRow[])[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team.length, selectedId, rawSection]);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3 border-b border-slate-200 pb-4">
        <div>
          <h2 className="text-2xl font-black text-slate-800 flex items-center gap-2">
            <Users className="text-indigo-600" size={26} />
            إدارة فريق العمل
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            ملفات الموظفين · الحضور · اليوميات · الحسابات · السلف · التقارير
          </p>
        </div>
      </div>

      {/* KPI strip — 6 cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <KpiCard
          icon={<Users2 size={20} />}
          tone="blue"
          label="عدد الموظفين"
          value={totals.totalEmployees.toString()}
          sub={
            hasPermission('attendance.view_team')
              ? `حاضر اليوم: ${presentToday}`
              : undefined
          }
        />
        <KpiCard
          icon={<CheckCircle2 size={20} />}
          tone="green"
          label="حاضر اليوم"
          value={
            hasPermission('attendance.view_team')
              ? presentToday.toString()
              : 'غير متاح'
          }
          sub={
            hasPermission('attendance.view_team') && totals.totalEmployees > 0
              ? `${Math.round((presentToday / totals.totalEmployees) * 100)}% من الفريق`
              : undefined
          }
        />
        <KpiCard
          icon={<Wallet size={20} />}
          tone="orange"
          label="إجمالي المستحقات"
          value={EGP(totals.totalPayable)}
          sub="شركة مدينة لفريق العمل"
        />
        <KpiCard
          icon={<DollarSign size={20} />}
          tone="red"
          label="إجمالي السلف"
          value={EGP(totals.totalEmployeeDebt)}
          sub="موظفون مدينون للشركة"
        />
        <KpiCard
          icon={<TrendingDown size={20} />}
          tone="purple"
          label="إجمالي الخصومات"
          value="غير متاح"
          sub="سيُحسب في PR-T3"
        />
        <KpiCard
          icon={<Banknote size={20} />}
          tone="green"
          label="المتبقي للموظفين"
          value={EGP(totals.netRemaining)}
          sub="صافي مستحق بعد السلف"
        />
      </div>

      {/* PR-T4.4 — collapsible employee list:
          Desktop: 320px panel toggles into a 56px rail (icon-only)
          via the listOpen state, persisted in localStorage so the
          user's preference survives reloads.
          Mobile/tablet: list becomes a drawer (fixed overlay) opened
          by the "فتح قائمة الموظفين" button rendered above the
          profile panel. */}
      <CollapsibleTeamLayout
        team={team as TeamRow[]}
        selectedId={selectedId}
        onSelect={setSelectedId}
        presentTodayIds={
          new Set(
            ((todayRows as any[]) || [])
              .filter((r) => (r?.minutes ?? r?.present_minutes ?? 0) > 0)
              .map((r) => String(r.user_id)),
          )
        }
        rightPanel={
          <EmployeeProfilePanel
            row={selected}
            pending={pending as EmployeeRequest[]}
            initialSection={rawSection}
          />
        }
      />
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 * Reusable shells — no fake data, no accounting changes
 * ───────────────────────────────────────────────────────────────── */

function KpiCard({
  icon,
  tone,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  tone: 'blue' | 'green' | 'red' | 'orange' | 'purple';
  label: string;
  value: string;
  sub?: string;
}) {
  const toneMap: Record<string, { bg: string; fg: string; tile: string }> = {
    blue:   { bg: 'bg-blue-50',   fg: 'text-blue-700',    tile: 'bg-blue-100' },
    green:  { bg: 'bg-emerald-50', fg: 'text-emerald-700', tile: 'bg-emerald-100' },
    red:    { bg: 'bg-rose-50',   fg: 'text-rose-700',    tile: 'bg-rose-100' },
    orange: { bg: 'bg-amber-50',  fg: 'text-amber-700',   tile: 'bg-amber-100' },
    purple: { bg: 'bg-violet-50', fg: 'text-violet-700',  tile: 'bg-violet-100' },
  };
  const t = toneMap[tone];
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 flex items-center justify-between gap-3 shadow-sm">
      <div className="min-w-0">
        <div className="text-xs font-bold text-slate-500">{label}</div>
        <div className={`text-xl font-black mt-1 ${t.fg} truncate tabular-nums`}>
          {value}
        </div>
        {sub && (
          <div className="text-[11px] text-slate-400 mt-0.5">{sub}</div>
        )}
      </div>
      <div className={`shrink-0 w-11 h-11 rounded-xl ${t.tile} ${t.fg} flex items-center justify-center`}>
        {icon}
      </div>
    </div>
  );
}

function CollapsibleTeamLayout({
  team,
  selectedId,
  onSelect,
  presentTodayIds,
  rightPanel,
}: {
  team: TeamRow[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  presentTodayIds: Set<string>;
  rightPanel: React.ReactNode;
}) {
  // Persist desktop expand/collapse preference. Initial value reads
  // localStorage synchronously so we don't flicker on first render.
  const [desktopOpen, setDesktopOpen] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem('team:listOpen');
      return v == null ? true : v === '1';
    } catch {
      return true;
    }
  });
  const persistDesktop = (next: boolean) => {
    setDesktopOpen(next);
    try { localStorage.setItem('team:listOpen', next ? '1' : '0'); } catch {}
  };

  // Mobile drawer is independent (always closed by default).
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = () => setDrawerOpen(false);

  return (
    <>
      {/* Desktop layout: 320px panel OR 56px rail. Hidden under lg. */}
      <div
        className="hidden lg:grid gap-5"
        style={{
          gridTemplateColumns: desktopOpen ? '320px 1fr' : '56px 1fr',
        }}
      >
        {desktopOpen ? (
          <EmployeeListPanel
            team={team}
            selectedId={selectedId}
            onSelect={onSelect}
            presentTodayIds={presentTodayIds}
            onCollapse={() => persistDesktop(false)}
          />
        ) : (
          <CollapsedRail
            count={team.length}
            onExpand={() => persistDesktop(true)}
          />
        )}
        {rightPanel}
      </div>

      {/* Mobile/tablet layout: full-width content + a button that
          opens the list as an overlay drawer. */}
      <div className="lg:hidden space-y-3">
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          className="w-full inline-flex items-center justify-between gap-2 px-4 py-3 rounded-xl bg-white border border-slate-200 text-sm font-bold text-slate-700 shadow-sm"
        >
          <span className="inline-flex items-center gap-2">
            <Users size={15} className="text-indigo-600" />
            فتح قائمة الموظفين
          </span>
          <span className="text-[11px] text-slate-400 font-normal">
            {team.length} موظف
          </span>
        </button>
        {rightPanel}
      </div>

      {drawerOpen && (
        <div
          className="lg:hidden fixed inset-0 z-50 bg-black/40"
          onClick={closeDrawer}
        >
          <aside
            className="absolute top-0 right-0 bottom-0 w-[88vw] max-w-[340px] bg-slate-50 shadow-2xl overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
            dir="rtl"
          >
            <div className="px-3 pt-3 pb-1 flex items-center justify-between">
              <h3 className="text-base font-black text-slate-800">الموظفون</h3>
              <button
                type="button"
                onClick={closeDrawer}
                className="p-2 rounded-lg hover:bg-slate-200/60 text-slate-600"
                title="إغلاق"
              >
                ✕
              </button>
            </div>
            <div className="p-3">
              <EmployeeListPanel
                team={team}
                selectedId={selectedId}
                onSelect={(id) => {
                  onSelect(id);
                  closeDrawer();
                }}
                presentTodayIds={presentTodayIds}
                /* No collapse button on mobile — the X handles it. */
              />
            </div>
          </aside>
        </div>
      )}
    </>
  );
}

function CollapsedRail({
  count,
  onExpand,
}: {
  count: number;
  onExpand: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onExpand}
      className="rounded-2xl border border-slate-200 bg-white shadow-sm p-3 flex flex-col items-center gap-3 h-fit hover:bg-slate-50 transition"
      title="إظهار قائمة الموظفين"
    >
      <Users size={18} className="text-indigo-600" />
      <span
        className="text-[11px] font-black text-slate-700 leading-tight"
        style={{ writingMode: 'vertical-rl' }}
      >
        الموظفون
      </span>
      <span className="text-[10px] text-slate-400 tabular-nums">{count}</span>
    </button>
  );
}

function EmployeeListPanel({
  team,
  selectedId,
  onSelect,
  presentTodayIds,
  onCollapse,
}: {
  team: TeamRow[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  presentTodayIds: Set<string>;
  onCollapse?: () => void;
}) {
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    if (!q) return team;
    const needle = q.trim().toLowerCase();
    return team.filter(
      (t) =>
        t.full_name?.toLowerCase().includes(needle) ||
        t.username?.toLowerCase().includes(needle) ||
        t.employee_no?.toLowerCase().includes(needle),
    );
  }, [team, q]);

  return (
    <aside className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm h-fit max-h-[calc(100vh-220px)] overflow-y-auto">
      <div className="flex items-center justify-between mb-3 px-1">
        <h3 className="text-base font-black text-slate-800">الموظفون</h3>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-slate-400">{team.length}</span>
          {onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              className="p-1 rounded hover:bg-slate-100 text-slate-500"
              title="طي القائمة"
            >
              ←
            </button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 px-2 py-2 mb-3 rounded-xl border border-slate-200 bg-slate-50">
        <Search size={14} className="text-slate-400" />
        <input
          className="bg-transparent flex-1 text-sm outline-none placeholder:text-slate-400"
          placeholder="ابحث عن موظف…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        {filtered.map((t) => (
          <EmployeeCard
            key={t.id}
            row={t}
            active={t.id === selectedId}
            presentToday={presentTodayIds.has(t.id)}
            onClick={() => onSelect(t.id)}
          />
        ))}
        {!filtered.length && (
          <div className="text-center text-xs text-slate-400 py-8">لا نتائج</div>
        )}
      </div>
      <button
        type="button"
        disabled
        title="سيتم تفعيلها في PR-T2"
        className="w-full mt-4 rounded-xl border border-dashed border-indigo-300 text-indigo-500 bg-white py-3 text-sm font-bold cursor-not-allowed opacity-60"
      >
        + إضافة موظف جديد
      </button>
    </aside>
  );
}

function EmployeeCard({
  row,
  active,
  presentToday,
  onClick,
}: {
  row: TeamRow;
  active: boolean;
  presentToday: boolean;
  onClick: () => void;
}) {
  const gl = Number(row.gl_balance || 0);
  const isPayable = gl < -0.01; // company owes employee
  const isDebt = gl > 0.01;     // employee owes company
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-right rounded-2xl border bg-white p-3 transition focus:outline-none ${
        active
          ? 'border-violet-300 ring-4 ring-violet-50'
          : 'border-slate-200 hover:border-slate-300'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`w-2.5 h-2.5 rounded-full shrink-0 ${
              presentToday ? 'bg-emerald-500' : 'bg-slate-300'
            }`}
            title={presentToday ? 'حاضر اليوم' : 'لم يُسجَّل حضور'}
          />
          <div className="min-w-0">
            <div className="font-black text-slate-800 text-sm truncate">
              {row.full_name || row.username}
            </div>
            <div className="text-[11px] text-slate-500 truncate">
              {row.role_name || row.job_title || '—'}
            </div>
          </div>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
        <span className="font-mono">{row.employee_no}</span>
        <span>{Math.round(Number(row.minutes_this_month || 0) / 60)}س / الشهر</span>
      </div>
      <div
        className={`mt-2 text-sm font-black ${
          isPayable
            ? 'text-emerald-700'
            : isDebt
              ? 'text-rose-700'
              : 'text-slate-500'
        }`}
      >
        {isPayable
          ? `مستحق له ${EGP(-gl)}`
          : isDebt
            ? `مدين للشركة ${EGP(gl)}`
            : 'متوازن'}
      </div>
    </button>
  );
}

type ProfileTab =
  | 'summary'
  | 'attendance'
  | 'accounts'
  | 'advances'
  | 'approvals'
  | 'reports';

// Map a `?section=` URL value (incl. legacy `?tab=` aliases) onto a
// profile-internal tab key. Unknown values fall back to the summary
// tab so deep-links never land on an empty view.
function sectionToTab(section: string | null | undefined): ProfileTab {
  switch (section) {
    case 'attendance': return 'attendance';
    case 'accounts':   return 'accounts';
    case 'advances':   return 'advances';
    case 'approvals':  return 'approvals';
    case 'reports':    return 'reports';
    case 'summary':
    case 'overview':
    default:           return 'summary';
  }
}

function EmployeeProfilePanel({
  row,
  pending,
  initialSection,
}: {
  row: TeamRow | null;
  pending: EmployeeRequest[];
  initialSection?: string | null;
}) {
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const [tab, setTab] = useState<ProfileTab>(() => sectionToTab(initialSection));

  // Re-sync the active tab when the URL section changes (e.g. user
  // clicks a sidebar link or arrives via /attendance redirect after
  // already having the workspace open).
  useEffect(() => {
    setTab(sectionToTab(initialSection));
  }, [initialSection]);

  const { data: dash } = useQuery({
    queryKey: ['employee-user-dashboard', row?.id],
    queryFn: () => employeesApi.userDashboard(row!.id),
    enabled: !!row?.id,
  });

  // PR-T1.1 — when no employee is selected AND the URL requested a
  // section (e.g. /attendance redirect → /team?section=attendance),
  // render the team-wide legacy view INSIDE the new shell so users
  // never see the old standalone page layout. The header + KPI strip +
  // employee list (rendered by the parent) stay visible above/beside.
  if (!row) {
    // PR-T3.1 — no-employee + section deep-links no longer render the
    // legacy team-wide <Payroll /> or <AttendanceBody embedded /> as a
    // raw embed. Both components were standalone old-page layouts that
    // showed up wrapped in the new shell, but the wrapping was thin
    // and users still perceived the old UX. The new behaviour matches
    // the spec: a clean placeholder that prompts the user to pick an
    // employee. Team-wide views move into PR-T4 (approvals) / PR-T5
    // (reports) where they get a proper redesign.
    if (initialSection === 'attendance') {
      return (
        <NoEmployeePlaceholder
          title="الحضور واليوميات"
          message="اختر موظفًا من القائمة لعرض حضوره واعتماد يومياته. عرض الفريق الكامل سيتم نقله بتصميم موحّد في PR-T4 / PR-T5."
        />
      );
    }
    if (initialSection === 'accounts') {
      return (
        <NoEmployeePlaceholder
          title="الحسابات والحركات"
          message="اختر موظفًا من القائمة لعرض كشف حسابه ومستحقاته. تقرير الفريق الموحّد سيتم نقله في PR-T5."
        />
      );
    }
    if (initialSection === 'approvals') {
      // PR-T4 — team-wide approvals view: shows the cross-team pending
      // requests inbox in the new design (no employee-scoped audit
      // history because that requires a user_id).
      return <ApprovalsAuditTab />;
    }
    return (
      <section className="rounded-2xl border border-slate-200 bg-white shadow-sm flex flex-col items-center justify-center text-center p-12 min-h-[420px]">
        <Users2 size={42} className="text-slate-300 mb-3" />
        <h3 className="text-lg font-black text-slate-700">اختر موظفًا</h3>
        <p className="text-sm text-slate-500 mt-1">
          ابحث في القائمة على اليمين أو اختر موظفًا لعرض ملفه.
        </p>
      </section>
    );
  }

  const gl = Number(row.gl_balance || 0);
  const isPayable = gl < -0.01;
  const isDebt = gl > 0.01;

  const profileTabs: Array<{ key: ProfileTab; label: string; icon: React.ReactNode }> = [
    { key: 'summary',    label: 'نظرة عامة',            icon: <ClipboardList size={14} /> },
    { key: 'attendance', label: 'الحضور واليوميات',     icon: <CalendarCheck size={14} /> },
    { key: 'accounts',   label: 'الحسابات والحركات',    icon: <Wallet2 size={14} /> },
    { key: 'advances',   label: 'السلف والخصومات',      icon: <Receipt size={14} /> },
    { key: 'approvals',  label: 'الموافقات والتعديلات', icon: <CheckCircle2 size={14} /> },
    { key: 'reports',    label: 'التقارير',             icon: <FileBarChart size={14} /> },
  ];

  return (
    <section className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      {/* PR-T4.1 — Employee header (compact). The 3 dead action
          buttons that lived here in PR-T1 (اعتماد يومية / صرف
          مستحقات / تسجيل حركة) were removed: each action now lives
          inside its owning tab. Right side has the focused Actions
          dropdown (إسناد مهمة + تقرير موظف). */}
      <div className="p-5 border-b border-slate-100">
        <div className="grid grid-cols-1 md:grid-cols-[110px_1fr_auto] gap-4 items-start border border-slate-200 rounded-2xl p-4">
          <div className="w-24 h-24 rounded-full bg-gradient-to-br from-slate-200 to-slate-50 border border-slate-200" />
          <div>
            <h3 className="text-2xl font-black text-slate-800 flex items-center gap-2 flex-wrap">
              {row.full_name || row.username}
              <span className="text-[11px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full px-2 py-0.5">
                نشط
              </span>
            </h3>
            <div className="text-sm text-slate-500 mt-0.5">
              {row.role_name || row.job_title || '—'}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3 text-xs text-slate-500">
              <InfoItem
                label="تاريخ التعيين"
                value={dash?.profile?.hire_date || 'غير متاح'}
              />
              <InfoItem
                label="الرقم الوظيفي"
                value={row.employee_no || '—'}
              />
              <InfoItem
                label="حالة اليوم"
                value={
                  hasPermission('attendance.view_team')
                    ? dash?.attendance?.today
                      ? 'حاضر'
                      : 'لم يُسجَّل حضور'
                    : 'غير متاح'
                }
              />
              {/* PR-T4.6 — color-coded balance pill: green when company
                  owes employee, red when employee owes company. Replaces
                  the plain text label that all looked identical regardless
                  of direction. */}
              <div>
                <div>الرصيد النهائي</div>
                <div className="mt-0.5">
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-black border ${
                      isPayable
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : isDebt
                          ? 'bg-rose-50 text-rose-700 border-rose-200'
                          : 'bg-slate-50 text-slate-600 border-slate-200'
                    }`}
                    title="من v_employee_gl_balance"
                  >
                    {isPayable
                      ? `مستحق له · ${EGP(-gl)}`
                      : isDebt
                        ? `مدين للشركة · ${EGP(gl)}`
                        : 'متوازن'}
                  </span>
                </div>
              </div>
            </div>
          </div>
          <ProfileActions row={row} dash={dash} />
        </div>
      </div>

      {/* PR-T4.1 — Tab bar moved UP, directly under the employee
          header. Was previously below the mini-stats cards (which
          made the page feel scrollable for no reason). Pills on
          desktop, soft horizontal scroll on small screens with
          scrollbar hidden via the .no-scrollbar utility (added to
          tailwind in this PR for parity). */}
      <nav
        className="flex items-center gap-1 border-b border-slate-200 px-5 overflow-x-auto"
        style={{ scrollbarWidth: 'none' }}
      >
        {profileTabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`px-4 py-3 -mb-px border-b-2 text-sm font-bold transition flex items-center gap-2 whitespace-nowrap ${
              tab === t.key
                ? 'border-indigo-600 text-indigo-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </nav>

      <div className="p-5">
        {tab === 'summary' && <EmployeeOverviewTab employee={row} />}
        {tab === 'attendance' && <AttendanceWageTab employee={row} />}
        {tab === 'accounts' && <AccountsMovementsTab employee={row} />}
        {/* PR-T4.1 — السلف والخصومات is now a FOCUSED tab (3 separate
            tables for advances / deductions / bonuses + 4 focused
            summary cards + 3 focused action buttons). Was duplicating
            the full ledger from accounts in PR-T3 — now distinct. */}
        {tab === 'advances' && <AdjustmentsTab employee={row} />}
        {tab === 'approvals' && <ApprovalsAuditTab employee={row} />}
        {tab === 'reports' && <EmployeeReportsTab employee={row} />}
      </div>
    </section>
  );
}

function ActionButton({
  label,
  tone,
  allowed,
  disabledReason,
}: {
  label: string;
  tone: 'green' | 'white';
  allowed: boolean;
  disabledReason: string;
}) {
  if (!allowed) return null; // permission-aware: hide when not allowed
  const cls =
    tone === 'green'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : 'bg-white text-slate-700 border-slate-200';
  return (
    <button
      type="button"
      disabled
      title={disabledReason}
      className={`px-3 py-2 rounded-xl text-sm font-bold border ${cls} cursor-not-allowed opacity-60`}
    >
      {label}
    </button>
  );
}

function InfoItem({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div>
      <div>{label}</div>
      <div className="font-bold text-slate-700 mt-0.5" title={hint}>{value}</div>
    </div>
  );
}

function MiniStat({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone: 'blue' | 'green' | 'red' | 'orange' | 'purple';
  hint?: string;
}) {
  const fg: Record<string, string> = {
    blue:   'text-blue-700',
    green:  'text-emerald-700',
    red:    'text-rose-700',
    orange: 'text-amber-700',
    purple: 'text-violet-700',
  };
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="text-[11px] font-bold text-slate-500">{label}</div>
      <div className={`text-lg font-black mt-1 tabular-nums ${fg[tone]}`}>
        {value}
      </div>
      {hint && (
        <div className="text-[10px] text-slate-400 mt-0.5">{hint}</div>
      )}
    </div>
  );
}

function ProfileActions({ row, dash }: { row: TeamRow; dash?: EmployeeDashboard }) {
  // PR-T4.6 — restored "تعديل الملف" alongside إسناد مهمة + إجراءات
  // in one clean strip.
  // PR-T5 — تقرير الموظف now opens the new reports tab via URL
  // navigation (react-router's setSearchParams keeps the
  // EmployeeProfilePanel's initialSection in sync).
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const [, setSearchParams] = useSearchParams();
  const canEditProfile = hasPermission('employee.profile.manage');
  const canAssignTask = hasPermission('employee.tasks.assign');
  const [openMenu, setOpenMenu] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  return (
    <div className="relative flex items-center gap-2 flex-wrap">
      {canEditProfile && (
        <button
          type="button"
          onClick={() => setEditOpen(true)}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-50 text-emerald-700 border border-emerald-200 text-sm font-bold hover:bg-emerald-100"
          title="تعديل بيانات الموظف وإعدادات العمولة والتارجت"
        >
          <Settings size={14} />
          تعديل الملف
        </button>
      )}
      {canAssignTask && (
        <button
          type="button"
          onClick={() => setTaskOpen(true)}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-50 text-indigo-700 border border-indigo-200 text-sm font-bold hover:bg-indigo-100"
          title="إنشاء مهمة جديدة لهذا الموظف"
        >
          <ClipboardList size={14} />
          إسناد مهمة
        </button>
      )}
      <button
        type="button"
        onClick={() => setOpenMenu((v) => !v)}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white border border-slate-200 text-slate-700 text-sm font-bold hover:bg-slate-50"
      >
        إجراءات
        <span className="text-[10px]">▾</span>
      </button>
      {openMenu && (
        <div
          className="absolute top-12 left-0 z-30 bg-white border border-slate-200 rounded-xl shadow-lg w-56 p-1.5 text-sm"
          onMouseLeave={() => setOpenMenu(false)}
        >
          {/* PR-T5 — تقرير الموظف is now active. Clicking it navigates
              to the reports tab; the EmployeeProfilePanel re-syncs the
              tab from the URL section param. The reports tab opens at
              the comprehensive report card by default. */}
          <button
            type="button"
            onClick={() => {
              setOpenMenu(false);
              setSearchParams((prev) => {
                const next = new URLSearchParams(prev);
                next.set('employee', row.id);
                next.set('section', 'reports');
                return next;
              });
            }}
            className="w-full text-right px-3 py-2 rounded-lg text-slate-700 hover:bg-slate-50 flex items-center justify-between"
            title="فتح تبويب التقارير — شامل / حضور / حسابات / سلف / مبيعات / موافقات"
          >
            <span>تقرير الموظف</span>
            <span className="text-[10px] text-slate-400">شامل</span>
          </button>
          {!canAssignTask && (
            <div className="px-3 py-2 text-[11px] text-slate-400">
              ليست لديك صلاحية إسناد المهام (employee.tasks.assign).
            </div>
          )}
          {!canEditProfile && (
            <div className="px-3 py-2 text-[11px] text-slate-400">
              ليست لديك صلاحية تعديل الملفات (employee.profile.manage).
            </div>
          )}
        </div>
      )}
      {editOpen && (
        <EditProfileModal
          row={row}
          dash={dash}
          onClose={() => setEditOpen(false)}
        />
      )}
      {taskOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 flex items-start justify-center p-4 overflow-y-auto"
          onClick={() => setTaskOpen(false)}
        >
          <div
            className="w-full max-w-lg bg-white rounded-2xl shadow-2xl my-6"
            onClick={(e) => e.stopPropagation()}
            dir="rtl"
          >
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h3 className="text-lg font-black text-slate-800">إسناد مهمة</h3>
                <div className="text-xs text-slate-500 mt-0.5">
                  {row.full_name || row.username}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setTaskOpen(false)}
                className="p-1.5 rounded hover:bg-slate-100 text-slate-500"
                title="إغلاق"
              >
                ✕
              </button>
            </div>
            <div className="p-5">
              <TaskForm userId={row.id} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * PR-T4.6 — full Edit Profile modal. Combines the legacy ProfileForm
 * (HR fields like job title, hire date, salary, shift hours) with a
 * new SellerSettingsForm (commission rate, target system, target
 * amount, after-target rate). Both forms post atomically to their
 * respective endpoints; modal closes once both succeed.
 *
 * Permission gate at the caller level (employee.profile.manage), so
 * if the modal is rendered the operator can edit everything inside.
 */
function EditProfileModal({
  row,
  dash,
  onClose,
}: {
  row: TeamRow;
  dash?: EmployeeDashboard;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-40 bg-black/40 flex items-start justify-center p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl bg-white rounded-2xl shadow-2xl my-6"
        onClick={(e) => e.stopPropagation()}
        dir="rtl"
      >
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between sticky top-0 bg-white">
          <div>
            <h3 className="text-lg font-black text-slate-800">تعديل الملف</h3>
            <div className="text-xs text-slate-500 mt-0.5">
              {row.full_name || row.username}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded hover:bg-slate-100 text-slate-500"
            title="إغلاق"
          >
            ✕
          </button>
        </div>
        <div className="p-5 space-y-5">
          <section>
            <h4 className="text-sm font-black text-slate-700 mb-2">
              بيانات الموظف الأساسية
            </h4>
            <ProfileForm userId={row.id} dash={dash} />
          </section>
          <section>
            <h4 className="text-sm font-black text-slate-700 mb-2">
              إعدادات البائع (عمولة وتارجت)
            </h4>
            <SellerSettingsForm userId={row.id} />
          </section>
        </div>
      </div>
    </div>
  );
}

/**
 * PR-T4.6 — seller settings form. Pre-fills from
 * /commissions/:id/seller-settings, posts back via the same endpoint
 * (PATCH). Three fields:
 *   - نسبة العمولة (الأساسية)        commission_rate %
 *   - نظام تارجت (تفعيل / إيقاف)     toggle
 *     - قيمة التارجت                   commission_target_amount
 *     - نسبة بعد التارجت               commission_after_target_rate %
 *
 * When the toggle is OFF, both target fields are cleared (sent as
 * null). When it's ON, target_amount is required (> 0) and
 * after-target rate is optional (defaults to commission_rate when
 * not set, surfaced via Overview's estimated-commission widget).
 */
function SellerSettingsForm({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const { data: settings } = useQuery({
    queryKey: ['commissions-seller-settings', userId],
    queryFn: () => commissionsApi.getSellerSettings(userId),
  });

  // Form state — strings for inputs, then narrowed at save time.
  const [isSeller, setIsSeller] = useState<boolean>(false);
  const [rate, setRate] = useState('');
  const [mode, setMode] = useState<
    'general' | 'after_target' | 'over_target' | 'general_plus_over_target'
  >('general');
  const [period, setPeriod] = useState<'none' | 'daily' | 'weekly' | 'monthly'>(
    'none',
  );
  const [targetAmount, setTargetAmount] = useState('');
  const [afterRate, setAfterRate] = useState('');
  const [overRate, setOverRate] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');

  useEffect(() => {
    if (!settings) return;
    setIsSeller(settings.is_salesperson === true);
    setRate(String(Number(settings.commission_rate || 0)));
    setMode((settings.commission_mode as any) || 'general');
    setPeriod((settings.sales_target_period as any) || 'none');
    setTargetAmount(
      settings.sales_target_amount != null ? String(settings.sales_target_amount) : '',
    );
    setAfterRate(
      settings.commission_after_target_rate != null
        ? String(settings.commission_after_target_rate)
        : '',
    );
    setOverRate(
      settings.over_target_commission_rate != null
        ? String(settings.over_target_commission_rate)
        : '',
    );
    setEffectiveFrom(
      settings.effective_from ? settings.effective_from.slice(0, 10) : '',
    );
  }, [settings]);

  const targetEnabled = period !== 'none';
  const showAfterRate = mode === 'after_target';
  const showOverRate =
    mode === 'over_target' || mode === 'general_plus_over_target';

  const save = useMutation({
    mutationFn: () =>
      commissionsApi.updateSellerSettings(userId, {
        is_salesperson: isSeller,
        commission_rate: rate === '' ? undefined : Number(rate),
        commission_mode: mode,
        sales_target_period: period,
        sales_target_amount: targetEnabled
          ? targetAmount === ''
            ? null
            : Number(targetAmount)
          : null,
        commission_after_target_rate:
          showAfterRate && afterRate !== '' ? Number(afterRate) : null,
        over_target_commission_rate:
          showOverRate && overRate !== '' ? Number(overRate) : null,
        effective_from: effectiveFrom === '' ? null : effectiveFrom,
      }),
    onSuccess: () => {
      toast.success('تم حفظ إعدادات البائع');
      qc.invalidateQueries({ queryKey: ['commissions-seller-settings', userId] });
      qc.invalidateQueries({ queryKey: ['commissions-detail'] });
      qc.invalidateQueries({ queryKey: ['commissions-summary'] });
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الحفظ'),
  });

  return (
    <div className="card p-4 space-y-4 text-sm">
      <div className="grid grid-cols-2 gap-3">
        <Field label="هل الموظف بائع؟">
          <label className="inline-flex items-center gap-2 mt-1.5">
            <input
              type="checkbox"
              checked={isSeller}
              onChange={(e) => setIsSeller(e.target.checked)}
            />
            <span className="text-xs font-bold text-slate-600">
              {isSeller
                ? 'نعم — يطبق نظام عمولة وتارجت'
                : 'لا — تخفي إعدادات البائع'}
            </span>
          </label>
        </Field>
        <Field label="نسبة العمولة الأساسية (%)">
          <input
            type="number"
            step="0.01"
            min="0"
            max="100"
            className="input w-full"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            placeholder="0"
            disabled={!isSeller}
          />
        </Field>
      </div>
      {isSeller && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="نوع العمولة">
              <select
                className="input w-full"
                value={mode}
                onChange={(e) => setMode(e.target.value as any)}
              >
                <option value="general">نسبة عامة من كل المبيعات</option>
                <option value="after_target">
                  نسبة بعد تحقيق التارجت فقط
                </option>
                <option value="over_target">نسبة على الأوفر تارجت فقط</option>
                <option value="general_plus_over_target">
                  نسبة عامة + نسبة إضافية على الأوفر تارجت
                </option>
              </select>
            </Field>
            <Field label="نظام التارجت">
              <select
                className="input w-full"
                value={period}
                onChange={(e) => setPeriod(e.target.value as any)}
              >
                <option value="none">بدون تارجت</option>
                <option value="daily">تارجت يومي</option>
                <option value="weekly">تارجت أسبوعي</option>
                <option value="monthly">تارجت شهري</option>
              </select>
            </Field>
          </div>
          {targetEnabled && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 rounded-xl border border-emerald-100 bg-emerald-50/40 p-3">
              <Field label={`قيمة التارجت (ج.م) — ${
                period === 'daily' ? 'يومي'
                  : period === 'weekly' ? 'أسبوعي'
                  : 'شهري'
              }`}>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  className="input w-full"
                  value={targetAmount}
                  onChange={(e) => setTargetAmount(e.target.value)}
                  placeholder="0"
                />
              </Field>
              {showAfterRate && (
                <Field label="نسبة العمولة بعد التارجت (%)">
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                    className="input w-full"
                    value={afterRate}
                    onChange={(e) => setAfterRate(e.target.value)}
                    placeholder={rate || '0'}
                  />
                </Field>
              )}
              {showOverRate && (
                <Field label="نسبة الأوفر تارجت (%)">
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                    className="input w-full"
                    value={overRate}
                    onChange={(e) => setOverRate(e.target.value)}
                    placeholder="0"
                  />
                </Field>
              )}
              <div className="md:col-span-3 text-[11px] text-emerald-900/70 leading-relaxed">
                {mode === 'general' &&
                  'العمولة = إجمالي المبيعات × النسبة الأساسية. التارجت يستخدم لإظهار نسبة التحقيق فقط.'}
                {mode === 'after_target' &&
                  'العمولة = إجمالي المبيعات × النسبة بعد التارجت — فقط إذا تم تحقيق التارجت.'}
                {mode === 'over_target' &&
                  'العمولة = (المبيعات − التارجت) × نسبة الأوفر تارجت. صفر إذا لم يُحقق التارجت.'}
                {mode === 'general_plus_over_target' &&
                  'العمولة = (المبيعات × النسبة الأساسية) + (المبيعات − التارجت) × نسبة الأوفر تارجت.'}
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="تاريخ بداية تطبيق الإعداد (اختياري)">
              <input
                type="date"
                className="input w-full"
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
              />
            </Field>
          </div>
        </>
      )}
      <div className="flex justify-end">
        <button
          className="btn-primary"
          disabled={save.isPending}
          onClick={() => save.mutate()}
        >
          <Settings size={14} /> حفظ إعدادات البائع
        </button>
      </div>
    </div>
  );
}

function NoEmployeePlaceholder({
  title,
  message,
}: {
  title: string;
  message: string;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white shadow-sm flex flex-col items-center justify-center text-center p-12 min-h-[420px]">
      <Users2 size={42} className="text-slate-300 mb-3" />
      <h3 className="text-lg font-black text-slate-700">{title}</h3>
      <p className="text-sm text-slate-500 mt-2 max-w-md leading-relaxed">
        {message}
      </p>
    </section>
  );
}

function SectionHeader({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="px-5 py-4 border-b border-slate-100">
      <h3 className="text-base font-black text-slate-800">{title}</h3>
      <p className="text-xs text-slate-500 mt-1">{hint}</p>
    </div>
  );
}

function PlaceholderPanel({
  title,
  message,
  link,
}: {
  title: string;
  message: string;
  link?: { to: string; label: string };
}) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center">
      <h4 className="text-base font-black text-slate-700">{title}</h4>
      <p className="text-sm text-slate-500 mt-2 leading-relaxed">{message}</p>
      {link && (
        <a
          href={link.to}
          className="inline-flex items-center gap-1.5 mt-4 px-3 py-2 rounded-xl bg-white border border-slate-200 text-slate-700 text-xs font-bold hover:bg-slate-100"
        >
          {link.label}
        </a>
      )}
    </div>
  );
}

function TeamTab({ pending }: { pending: EmployeeRequest[] }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState<TeamRow | null>(null);

  const { data: team = [] } = useQuery({
    queryKey: ['employees-team'],
    queryFn: () => employeesApi.team(),
    refetchInterval: 60_000,
  });

  const filtered = useMemo(() => {
    if (!q) return team;
    const needle = q.trim().toLowerCase();
    return team.filter(
      (t: TeamRow) =>
        t.full_name?.toLowerCase().includes(needle) ||
        t.username?.toLowerCase().includes(needle) ||
        t.employee_no?.toLowerCase().includes(needle),
    );
  }, [team, q]);

  return (
    <div className="space-y-5">
      {pending.length > 0 && (
        <PendingInbox requests={pending} />
      )}

      <div className="card p-4">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div className="flex items-center gap-2 flex-1 max-w-md">
            <Search size={14} className="text-slate-400" />
            <input
              className="input flex-1"
              placeholder="بحث بالاسم / اسم المستخدم / كود الموظف"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="text-xs text-slate-500">
            عدد الموظفين: <span className="font-bold">{team.length}</span>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs">
              <tr>
                <th className="p-3 text-right">الموظف</th>
                <th className="p-3 text-center">الدور</th>
                <th className="p-3 text-center">الراتب</th>
                <th className="p-3 text-center" title="الهدف اليومي بالساعات من إعدادات الموظف">
                  الهدف اليومي
                </th>
                <th className="p-3 text-center">ساعات الشهر</th>
                <th className="p-3 text-center" title="مجموع الإضافي على الأيام المغلقة (فعلي − هدف)">
                  إضافي الشهر
                </th>
                <th className="p-3 text-center" title="مجموع النقص عن الهدف على الأيام المغلقة">
                  نقص الشهر
                </th>
                <th className="p-3 text-center" title="مجموع التأخير عن بداية الوردية بعد فترة السماح">
                  تأخير
                </th>
                <th className="p-3 text-center" title="مجموع الانصراف المبكر قبل نهاية الوردية">
                  انصراف مبكر
                </th>
                <th className="p-3 text-center">سلف الشهر</th>
                <th className="p-3 text-center">حوافز الشهر</th>
                <th className="p-3 text-center">مهام / طلبات</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((t) => (
                <tr key={t.id} className="hover:bg-slate-50">
                  <td className="p-3">
                    <div className="font-bold text-slate-800">
                      {t.full_name || t.username}
                    </div>
                    <div className="text-[10px] font-mono text-slate-400 flex items-center gap-1.5 mt-0.5">
                      <span>{t.employee_no}</span>
                      {t.job_title && <span>· {t.job_title}</span>}
                    </div>
                  </td>
                  <td className="p-3 text-center text-xs">
                    <span className="chip bg-indigo-50 border-indigo-200 text-indigo-700">
                      {t.role_name || '—'}
                    </span>
                  </td>
                  <td className="p-3 text-center tabular-nums font-mono">
                    {EGP(t.salary_amount)}
                    <div className="text-[10px] text-slate-400">
                      {FREQ_LABEL[t.salary_frequency]}
                    </div>
                  </td>
                  <td className="p-3 text-center tabular-nums text-slate-700">
                    {t.target_hours_day != null
                      ? `${Number(t.target_hours_day)}س`
                      : '—'}
                  </td>
                  <td className="p-3 text-center tabular-nums">
                    {fmtHours(Number(t.minutes_this_month || 0))}
                  </td>
                  <td className="p-3 text-center tabular-nums text-emerald-700 font-bold">
                    {Number(t.overtime_minutes_this_month) > 0
                      ? `+${fmtHours(Number(t.overtime_minutes_this_month))}`
                      : '—'}
                  </td>
                  <td className="p-3 text-center tabular-nums text-rose-700 font-bold">
                    {Number(t.shortage_minutes_this_month) > 0
                      ? `−${fmtHours(Number(t.shortage_minutes_this_month))}`
                      : '—'}
                  </td>
                  <td className="p-3 text-center tabular-nums text-amber-700">
                    {Number(t.late_minutes_this_month) > 0
                      ? `${Number(t.late_minutes_this_month)}د`
                      : '—'}
                  </td>
                  <td className="p-3 text-center tabular-nums text-amber-700">
                    {Number(t.early_leave_minutes_this_month) > 0
                      ? `${Number(t.early_leave_minutes_this_month)}د`
                      : '—'}
                  </td>
                  <td className="p-3 text-center tabular-nums font-mono text-amber-700">
                    {EGP(t.advances_this_month)}
                  </td>
                  <td className="p-3 text-center tabular-nums font-mono text-emerald-700">
                    {EGP(t.bonuses_this_month)}
                  </td>
                  <td className="p-3 text-center text-xs">
                    {Number(t.open_tasks) > 0 && (
                      <span className="chip bg-indigo-50 text-indigo-700 border-indigo-200 mx-0.5">
                        {t.open_tasks} مهمة
                      </span>
                    )}
                    {Number(t.pending_requests) > 0 && (
                      <span className="chip bg-amber-50 text-amber-700 border-amber-200 mx-0.5">
                        {t.pending_requests} طلب
                      </span>
                    )}
                  </td>
                  <td className="p-3">
                    <button
                      className="p-1.5 rounded hover:bg-brand-50 text-slate-500 hover:text-brand-600"
                      onClick={() => setActive(t)}
                      title="فتح الملف"
                    >
                      <Eye size={14} />
                    </button>
                  </td>
                </tr>
              ))}
              {!filtered.length && (
                <tr>
                  <td colSpan={13} className="p-10 text-center text-slate-400">
                    لا نتائج
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {active && (
        <EmployeeDetailDrawer
          row={active}
          onClose={() => setActive(null)}
        />
      )}
    </div>
  );
}

/* ───────── Pending-requests inbox ───────── */

const KIND_LABEL: Record<string, string> = {
  advance: 'سلفة',
  leave: 'إجازة',
  overtime_extension: 'تمديد ساعات إضافية',
  other: 'أخرى',
};

function PendingInbox({ requests }: { requests: EmployeeRequest[] }) {
  const qc = useQueryClient();
  const [rejectTarget, setRejectTarget] = useState<EmployeeRequest | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const decide = useMutation({
    mutationFn: ({
      id,
      decision,
      reason,
    }: {
      id: string | number;
      decision: 'approved' | 'rejected';
      reason?: string;
    }) => employeesApi.decideRequest(id, { decision, reason }),
    onSuccess: (_r, v) => {
      toast.success(
        v.decision === 'approved' ? 'تم اعتماد الطلب' : 'تم رفض الطلب',
      );
      qc.invalidateQueries({ queryKey: ['employees-pending'] });
      qc.invalidateQueries({ queryKey: ['employees-team'] });
      setRejectTarget(null);
      setRejectReason('');
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل تنفيذ القرار'),
  });

  return (
    <div className="card p-5 border-2 border-amber-200 bg-amber-50/40">
      <div className="flex items-center gap-2 mb-3">
        <ClipboardList className="text-amber-600" size={18} />
        <h3 className="font-black text-amber-800">
          طلبات تنتظر اعتمادك ({requests.length})
        </h3>
      </div>
      <div className="space-y-2">
        {requests.map((r) => (
          <div
            key={r.id}
            className="bg-white border border-amber-200 rounded-lg p-3 text-xs"
          >
            <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <span className="chip bg-amber-100 text-amber-700 border-amber-200 font-bold text-[10px]">
                  {KIND_LABEL[r.kind]}
                </span>
                <span className="font-bold text-slate-800">
                  {r.user_name || r.username}
                </span>
                {r.employee_no && (
                  <span className="font-mono text-[10px] text-slate-400">
                    {r.employee_no}
                  </span>
                )}
                {r.amount != null && (
                  <span className="font-mono text-slate-700">
                    {EGP(r.amount)}
                  </span>
                )}
              </div>
              <span className="text-slate-500 tabular-nums">
                {fmtWhen(r.created_at)}
              </span>
            </div>
            {r.reason && (
              <div className="text-slate-600 mb-2">السبب: {r.reason}</div>
            )}
            {(r.starts_at || r.ends_at) && (
              <div className="text-slate-600 mb-2 tabular-nums">
                {r.starts_at && <>من {fmtWhen(r.starts_at)}</>}
                {r.ends_at && <> · إلى {fmtWhen(r.ends_at)}</>}
              </div>
            )}
            <div className="flex items-center gap-2">
              <button
                className="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-[11px]"
                disabled={decide.isPending}
                onClick={() =>
                  decide.mutate({ id: r.id, decision: 'approved' })
                }
              >
                <CheckCircle2 size={12} /> اعتماد
              </button>
              <button
                className="px-3 py-1.5 rounded bg-rose-600 hover:bg-rose-700 text-white font-bold text-[11px]"
                disabled={decide.isPending}
                onClick={() => {
                  setRejectTarget(r);
                  setRejectReason('');
                }}
              >
                <XCircle size={12} /> رفض
              </button>
            </div>
          </div>
        ))}
      </div>

      {rejectTarget && (
        <div
          className="fixed inset-0 bg-black/40 z-[60] flex items-center justify-center p-4"
          onClick={() => {
            if (!decide.isPending) {
              setRejectTarget(null);
              setRejectReason('');
            }
          }}
        >
          <div
            className="bg-white rounded-2xl max-w-md w-full p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h4 className="font-black text-slate-800 mb-2">رفض الطلب</h4>
            <p className="text-xs text-slate-500 mb-3">
              اكتب سبب الرفض — سيظهر لمقدم الطلب.
            </p>
            <textarea
              rows={3}
              className="input w-full"
              placeholder="مثال: تعارض مع مواعيد الفريق / ميزانية غير كافية"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              disabled={decide.isPending}
              autoFocus
            />
            <div className="flex justify-end gap-2 mt-3">
              <button
                className="btn-ghost"
                disabled={decide.isPending}
                onClick={() => {
                  setRejectTarget(null);
                  setRejectReason('');
                }}
              >
                إلغاء
              </button>
              <button
                className="px-4 py-2 rounded-lg bg-rose-600 text-white text-sm font-bold"
                disabled={decide.isPending}
                onClick={() => {
                  if (!rejectReason.trim()) {
                    toast.error('يجب كتابة سبب الرفض');
                    return;
                  }
                  decide.mutate({
                    id: rejectTarget.id,
                    decision: 'rejected',
                    reason: rejectReason.trim(),
                  });
                }}
              >
                تأكيد الرفض
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ───────── Detail drawer ───────── */

type DetailTab =
  | 'overview'
  | 'profile'
  | 'bonus'
  | 'deduction'
  | 'task'
  | 'attendance';

function EmployeeDetailDrawer({
  row,
  onClose,
}: {
  row: TeamRow;
  onClose: () => void;
}) {
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const [tab, setTab] = useState<DetailTab>('overview');

  const { data: dash } = useQuery({
    queryKey: ['employee-user-dashboard', row.id],
    queryFn: () => employeesApi.userDashboard(row.id),
  });

  const tabs: Array<{ key: DetailTab; label: string; show: boolean }> = [
    { key: 'overview', label: 'نظرة عامة', show: true },
    {
      // Admin attendance + wage tools (clock-in / clock-out on behalf,
      // تثبيت يومية, صرف يومية). Moved here from /me in this PR so
      // self-service profiles never expose admin-on-behalf controls.
      key: 'attendance',
      label: 'حضور / يومية',
      show: hasPermission('employee.attendance.manage'),
    },
    {
      key: 'profile',
      label: 'تعديل الملف',
      show: hasPermission('employee.profile.manage'),
    },
    {
      key: 'bonus',
      label: 'حافز / مكافأة',
      show: hasPermission('employee.bonuses.manage'),
    },
    {
      key: 'deduction',
      label: 'خصم',
      show: hasPermission('employee.deductions.manage'),
    },
    {
      key: 'task',
      label: 'إسناد مهمة',
      show: hasPermission('employee.tasks.assign'),
    },
  ];

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex" onClick={onClose}>
      <div
        className="mr-auto w-full max-w-2xl bg-slate-50 h-full overflow-y-auto shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        dir="rtl"
      >
        <div className="sticky top-0 bg-white border-b border-slate-200 p-4 flex items-center justify-between z-10">
          <div>
            <h3 className="font-black text-slate-800">
              {row.full_name || row.username}
            </h3>
            <div className="text-xs text-slate-500 font-mono">
              {row.employee_no} · {row.role_name}
            </div>
          </div>
          <button
            className="p-2 rounded hover:bg-slate-100"
            onClick={onClose}
            title="إغلاق"
          >
            <ArrowLeft size={16} />
          </button>
        </div>

        <div className="px-4 pt-3">
          <div className="inline-flex rounded-lg bg-slate-200 p-1 flex-wrap">
            {tabs
              .filter((t) => t.show)
              .map((t) => (
                <button
                  key={t.key}
                  className={`px-3 py-1.5 rounded-md text-xs font-bold ${
                    tab === t.key
                      ? 'bg-white text-indigo-700 shadow-sm'
                      : 'text-slate-600'
                  }`}
                  onClick={() => setTab(t.key)}
                >
                  {t.label}
                </button>
              ))}
          </div>
        </div>

        <div className="p-4 space-y-4">
          {tab === 'overview' && <OverviewTab dash={dash} />}
          {tab === 'attendance' && (
            <AdminAttendancePanel
              userId={row.id}
              fullName={row.full_name || row.username}
              dailyAmount={Number(row.salary_amount || 0)}
              liveGlBalance={Number(row.gl_balance || 0)}
            />
          )}
          {tab === 'profile' && <ProfileForm userId={row.id} dash={dash} />}
          {tab === 'bonus' && <BonusForm userId={row.id} />}
          {tab === 'deduction' && <DeductionForm userId={row.id} />}
          {tab === 'task' && <TaskForm userId={row.id} />}
        </div>
      </div>
    </div>
  );
}

function OverviewTab({ dash }: { dash?: EmployeeDashboard }) {
  if (!dash)
    return <div className="text-center text-slate-400 py-10">جارٍ التحميل…</div>;
  const { salary, attendance, tasks, requests } = dash;
  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <div className="bg-white border border-slate-200 rounded-lg p-3">
          <div className="text-slate-500 text-[11px]">ساعات الشهر</div>
          <div className="font-black text-indigo-700 tabular-nums">
            {fmtHours(attendance.month.minutes)}
          </div>
          <div className="text-slate-400 text-[10px]">
            {attendance.month.days} يوم
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-3">
          <div className="text-slate-500 text-[11px]">مستحق</div>
          <div className="font-black text-emerald-700 tabular-nums">
            {EGP(salary.accrued)}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-3">
          <div className="text-slate-500 text-[11px]">سلف الشهر</div>
          <div className="font-black text-amber-700 tabular-nums">
            {EGP(salary.advances_month)}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-3">
          {/* Canonical headline — from v_employee_gl_balance.
              Positive = employee owes company; negative = company owes
              employee. Was `salary.net` (source-derived). */}
          <div className="text-slate-500 text-[11px]">الرصيد النهائي من القيود</div>
          <div
            className={`font-black tabular-nums ${
              salary.gl_balance > 0.01
                ? 'text-rose-700'
                : salary.gl_balance < -0.01
                  ? 'text-emerald-700'
                  : 'text-slate-700'
            }`}
          >
            {salary.gl_balance > 0.01
              ? `مدين للشركة ${EGP(salary.gl_balance)}`
              : salary.gl_balance < -0.01
                ? `مستحق له ${EGP(-salary.gl_balance)}`
                : 'متوازن'}
          </div>
          <div className="text-slate-400 text-[10px] mt-0.5">
            الصافي من الرواتب {EGP(salary.net)}
          </div>
        </div>
      </div>

      <div className="card p-4">
        <h4 className="font-bold text-slate-800 mb-2 flex items-center gap-2 text-sm">
          <Clock size={14} /> مهام مفتوحة ({tasks.length})
        </h4>
        {tasks.length === 0 ? (
          <div className="text-xs text-slate-400">لا مهام مفتوحة</div>
        ) : (
          <ul className="space-y-1 text-xs">
            {tasks.map((t) => (
              <li
                key={t.id}
                className="flex items-center justify-between border-b border-slate-100 last:border-0 py-1"
              >
                <span className="font-bold text-slate-700">{t.title}</span>
                <span className="chip bg-slate-50 border-slate-200 text-slate-600 text-[10px]">
                  {t.status === 'pending'
                    ? 'لم يستلم'
                    : t.status === 'acknowledged'
                      ? 'مستلمة'
                      : t.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card p-4">
        <h4 className="font-bold text-slate-800 mb-2 text-sm">
          طلبات معلّقة ({requests.length})
        </h4>
        {requests.length === 0 ? (
          <div className="text-xs text-slate-400">لا توجد طلبات</div>
        ) : (
          <ul className="space-y-1 text-xs">
            {requests.map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between border-b border-slate-100 last:border-0 py-1"
              >
                <span>
                  {KIND_LABEL[r.kind]} {r.amount != null && `— ${EGP(r.amount)}`}
                </span>
                <span className="text-slate-400">{fmtWhen(r.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function ProfileForm({
  userId,
  dash,
}: {
  userId: string;
  dash?: EmployeeDashboard;
}) {
  const qc = useQueryClient();
  const p = dash?.profile;
  const [employeeNo, setEmployeeNo] = useState(p?.employee_no || '');
  const [jobTitle, setJobTitle] = useState(p?.job_title || '');
  const [hireDate, setHireDate] = useState(p?.hire_date || '');
  const [salaryAmount, setSalaryAmount] = useState(
    String(p?.salary_amount ?? ''),
  );
  const [salaryFrequency, setSalaryFrequency] = useState<
    'daily' | 'weekly' | 'monthly'
  >((p?.salary_frequency as any) || 'monthly');
  const [targetDay, setTargetDay] = useState(
    String(p?.target_hours_day ?? ''),
  );
  const [targetWeek, setTargetWeek] = useState(
    String(p?.target_hours_week ?? ''),
  );
  const [overtimeRate, setOvertimeRate] = useState(
    String(p?.overtime_rate ?? ''),
  );
  const [shiftStart, setShiftStart] = useState(
    (p?.shift_start_time as string) || '',
  );
  const [shiftEnd, setShiftEnd] = useState(
    (p?.shift_end_time as string) || '',
  );
  const [lateGrace, setLateGrace] = useState(
    String(p?.late_grace_min ?? ''),
  );

  const save = useMutation({
    mutationFn: () =>
      employeesApi.updateProfile(userId, {
        employee_no: employeeNo || undefined,
        job_title: jobTitle || undefined,
        hire_date: hireDate || undefined,
        salary_amount: salaryAmount ? Number(salaryAmount) : undefined,
        salary_frequency: salaryFrequency,
        target_hours_day: targetDay ? Number(targetDay) : undefined,
        target_hours_week: targetWeek ? Number(targetWeek) : undefined,
        overtime_rate: overtimeRate ? Number(overtimeRate) : undefined,
        shift_start_time: shiftStart ? shiftStart.slice(0, 5) : undefined,
        shift_end_time: shiftEnd ? shiftEnd.slice(0, 5) : undefined,
        late_grace_min: lateGrace ? Number(lateGrace) : undefined,
      }),
    onSuccess: () => {
      toast.success('تم حفظ الملف');
      qc.invalidateQueries({ queryKey: ['employees-team'] });
      qc.invalidateQueries({ queryKey: ['employee-user-dashboard', userId] });
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الحفظ'),
  });

  return (
    <div className="card p-4 space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-3">
        <Field label="كود الموظف">
          <input
            className="input w-full"
            value={employeeNo}
            onChange={(e) => setEmployeeNo(e.target.value)}
          />
        </Field>
        <Field label="المسمى الوظيفي">
          <input
            className="input w-full"
            value={jobTitle}
            onChange={(e) => setJobTitle(e.target.value)}
          />
        </Field>
        <Field label="تاريخ التعيين">
          <input
            type="date"
            className="input w-full"
            value={hireDate ? hireDate.slice(0, 10) : ''}
            onChange={(e) => setHireDate(e.target.value)}
          />
        </Field>
        <Field label="تواتر الصرف">
          <select
            className="input w-full"
            value={salaryFrequency}
            onChange={(e) => setSalaryFrequency(e.target.value as any)}
          >
            <option value="monthly">شهري</option>
            <option value="weekly">أسبوعي</option>
            <option value="daily">يومي</option>
          </select>
        </Field>
        <Field label="قيمة الراتب (ج.م)">
          <input
            type="number"
            step="0.01"
            className="input w-full"
            value={salaryAmount}
            onChange={(e) => setSalaryAmount(e.target.value)}
          />
        </Field>
        <Field label="الساعات المستهدفة في اليوم">
          <input
            type="number"
            step="0.25"
            className="input w-full"
            value={targetDay}
            onChange={(e) => setTargetDay(e.target.value)}
          />
        </Field>
        <Field label="الساعات المستهدفة في الأسبوع">
          <input
            type="number"
            step="0.5"
            className="input w-full"
            value={targetWeek}
            onChange={(e) => setTargetWeek(e.target.value)}
          />
        </Field>
        <Field label="معدل ساعة الإضافي (×)">
          <input
            type="number"
            step="0.1"
            className="input w-full"
            value={overtimeRate}
            onChange={(e) => setOvertimeRate(e.target.value)}
          />
        </Field>
        <Field label="بداية الوردية">
          <input
            type="time"
            className="input w-full"
            value={shiftStart}
            onChange={(e) => setShiftStart(e.target.value)}
          />
        </Field>
        <Field label="نهاية الوردية">
          <input
            type="time"
            className="input w-full"
            value={shiftEnd}
            onChange={(e) => setShiftEnd(e.target.value)}
          />
        </Field>
        <Field label="سماحة التأخير (بالدقائق)">
          <input
            type="number"
            min="0"
            className="input w-full"
            value={lateGrace}
            onChange={(e) => setLateGrace(e.target.value)}
          />
        </Field>
      </div>
      <div className="flex justify-end">
        <button
          className="btn-primary"
          disabled={save.isPending}
          onClick={() => save.mutate()}
        >
          <Settings size={14} /> حفظ الملف
        </button>
      </div>
    </div>
  );
}

function BonusForm({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState('');
  const [kind, setKind] = useState('bonus');
  const [note, setNote] = useState('');
  const [date, setDate] = useState('');

  const { data: history = [] } = useQuery({
    queryKey: ['employee-bonuses', userId],
    queryFn: () =>
      employeesApi.team().then(() => null).catch(() => null), // placeholder
    enabled: false,
  });
  void history;

  const add = useMutation({
    mutationFn: () =>
      employeesApi.addBonus(userId, {
        amount: Number(amount),
        kind,
        note: note || undefined,
        bonus_date: date || undefined,
      }),
    onSuccess: () => {
      toast.success('تم إضافة الحافز');
      setAmount('');
      setNote('');
      qc.invalidateQueries({ queryKey: ['employees-team'] });
      qc.invalidateQueries({ queryKey: ['employee-user-dashboard', userId] });
      // Any employee mutation must refresh every canonical-balance
      // consumer — Payroll page, Financial Ledger card, dashboard —
      // so the GL headline + gl_entries update immediately.
      qc.invalidateQueries({ queryKey: ['payroll-balances'] });
      qc.invalidateQueries({ queryKey: ['payroll-list'] });
      qc.invalidateQueries({ queryKey: ['employee-ledger'] });
      qc.invalidateQueries({ queryKey: ['employee-dashboard'] });
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الإضافة'),
  });

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Gift className="text-emerald-600" size={18} />
        <h4 className="font-bold text-slate-800 text-sm">
          إضافة حافز / مكافأة / ساعة إضافية
        </h4>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="القيمة (ج.م)">
          <input
            type="number"
            step="0.01"
            className="input w-full"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
        <Field label="النوع">
          <select
            className="input w-full"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="bonus">مكافأة</option>
            <option value="incentive">حافز أداء</option>
            <option value="overtime">ساعات إضافية</option>
            <option value="other">أخرى</option>
          </select>
        </Field>
        <Field label="التاريخ">
          <input
            type="date"
            className="input w-full"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
        <Field label="ملاحظات">
          <input
            className="input w-full"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="اختياري"
          />
        </Field>
      </div>
      <div className="flex justify-end">
        <button
          className="btn-primary bg-emerald-600 hover:bg-emerald-700"
          disabled={add.isPending || !amount}
          onClick={() => add.mutate()}
        >
          <ListPlus size={14} /> إضافة
        </button>
      </div>
    </div>
  );
}

function DeductionForm({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState('');

  const add = useMutation({
    mutationFn: () =>
      employeesApi.addDeduction(userId, {
        amount: Number(amount),
        reason,
        deduction_date: date || undefined,
      }),
    onSuccess: () => {
      toast.success('تم إضافة الخصم');
      setAmount('');
      setReason('');
      qc.invalidateQueries({ queryKey: ['employees-team'] });
      qc.invalidateQueries({ queryKey: ['employee-user-dashboard', userId] });
      qc.invalidateQueries({ queryKey: ['payroll-balances'] });
      qc.invalidateQueries({ queryKey: ['payroll-list'] });
      qc.invalidateQueries({ queryKey: ['employee-ledger'] });
      qc.invalidateQueries({ queryKey: ['employee-dashboard'] });
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الإضافة'),
  });

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Minus className="text-rose-600" size={18} />
        <h4 className="font-bold text-slate-800 text-sm">إضافة خصم</h4>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="القيمة (ج.م)">
          <input
            type="number"
            step="0.01"
            className="input w-full"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
        <Field label="التاريخ">
          <input
            type="date"
            className="input w-full"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
        <div className="col-span-2">
          <Field label="السبب">
            <textarea
              rows={2}
              className="input w-full"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="مثال: مخالفة مواعيد / خصم مخزون / إلخ"
            />
          </Field>
        </div>
      </div>
      <div className="flex justify-end">
        <button
          className="btn-primary bg-rose-600 hover:bg-rose-700"
          disabled={add.isPending || !amount || !reason.trim()}
          onClick={() => add.mutate()}
        >
          <Minus size={14} /> تأكيد الخصم
        </button>
      </div>
    </div>
  );
}

function TaskForm({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<
    'low' | 'normal' | 'high' | 'urgent'
  >('normal');
  const [dueAt, setDueAt] = useState('');

  const add = useMutation({
    mutationFn: () =>
      employeesApi.createTask({
        user_id: userId,
        title,
        description: description || undefined,
        priority,
        due_at: dueAt || undefined,
      }),
    onSuccess: () => {
      toast.success('تم إسناد المهمة');
      setTitle('');
      setDescription('');
      setDueAt('');
      qc.invalidateQueries({ queryKey: ['employees-team'] });
      qc.invalidateQueries({ queryKey: ['employee-user-dashboard', userId] });
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الإسناد'),
  });

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <ListPlus className="text-indigo-600" size={18} />
        <h4 className="font-bold text-slate-800 text-sm">إسناد مهمة جديدة</h4>
      </div>
      <Field label="العنوان">
        <input
          className="input w-full"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="مثال: جرد رف الأحذية · الدور الثاني"
        />
      </Field>
      <Field label="تفاصيل">
        <textarea
          rows={3}
          className="input w-full"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="الأولوية">
          <select
            className="input w-full"
            value={priority}
            onChange={(e) => setPriority(e.target.value as any)}
          >
            <option value="low">منخفضة</option>
            <option value="normal">عادية</option>
            <option value="high">هامة</option>
            <option value="urgent">عاجلة</option>
          </select>
        </Field>
        <Field label="موعد الإنجاز">
          <input
            type="datetime-local"
            className="input w-full"
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
          />
        </Field>
      </div>
      <div className="flex justify-end">
        <button
          className="btn-primary"
          disabled={add.isPending || !title.trim()}
          onClick={() => add.mutate()}
        >
          <ListPlus size={14} /> إسناد
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs text-slate-600 font-bold mb-1 block">
        {label}
      </span>
      {children}
    </label>
  );
}
