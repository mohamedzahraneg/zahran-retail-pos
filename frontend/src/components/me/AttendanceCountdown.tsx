/**
 * AttendanceCountdown — PR-ESS-2A
 * ────────────────────────────────────────────────────────────────────
 *
 * Live timer card shown on the /me self-service profile when the
 * employee is checked in. Displays:
 *   · elapsed time since clock-in (MM:SS or HH:MM:SS)
 *   · remaining time until scheduled end of work day
 *
 * Scheduled end of work day is derived in this priority order:
 *   1. `profile.shift_end_time` — explicit "HH:MM" set by the manager
 *      via Team → Edit Profile (migration 041 column).
 *   2. `clock_in + profile.target_hours_day` — duration-based fallback
 *      when no explicit shift end is set (migration 040 column,
 *      defaults to 8h).
 *
 * When `remaining > 0` the card renders in calm slate/blue tones with
 * an Arabic "متبقي X ساعات Y دقائق" label. When `remaining <= 0` the
 * card flips to a soft amber banner showing "انتهى وقت العمل منذ ..."
 * and stops the live tick (the timer keeps running internally so the
 * elapsed-since-end overflow stays correct, but we don't redraw the
 * positive countdown anymore).
 *
 * IMPORTANT: this is a presentation-only countdown. The backend remains
 * the source of truth for actual attendance records (clock-in /
 * clock-out timestamps, payable-day accrual). A few seconds of clock
 * skew between the browser and the server are acceptable.
 */

import { useEffect, useMemo, useState } from 'react';
import { Clock, Hourglass, AlertCircle } from 'lucide-react';

interface Profile {
  shift_start_time?: string | null;
  shift_end_time?: string | null;
  /** Numeric hours per day. Default 8 from migration 040. */
  target_hours_day?: number | string | null;
}

export interface AttendanceCountdownProps {
  /**
   * The current user's clock-in ISO string. When `null` the component
   * renders nothing (the parent should swap in a "تسجيل حضور" card
   * instead).
   */
  clockInISO: string | null;
  /** Clock-out ISO string. When set, the user is checked out. */
  clockOutISO?: string | null;
  /** Profile row from /me/dashboard's `profile` block. */
  profile: Profile | null | undefined;
}

interface TimeBreakdown {
  hours: number;
  minutes: number;
  seconds: number;
  totalMs: number;
}

function fmtHM(b: TimeBreakdown): string {
  if (b.hours > 0) {
    return `${b.hours} ساعة ${String(b.minutes).padStart(2, '0')} دقيقة`;
  }
  return `${b.minutes} دقيقة`;
}

function fmtClock(b: TimeBreakdown): string {
  const hh = String(b.hours).padStart(2, '0');
  const mm = String(b.minutes).padStart(2, '0');
  const ss = String(b.seconds).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function breakdown(ms: number): TimeBreakdown {
  const positive = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(positive / 3600);
  const minutes = Math.floor((positive % 3600) / 60);
  const seconds = positive % 60;
  return { hours, minutes, seconds, totalMs: ms };
}

/**
 * Resolves the scheduled end-of-day timestamp for a given clock-in. If
 * the profile has an explicit `shift_end_time`, we anchor to today's
 * Cairo date for that wall-clock time; otherwise we add
 * `target_hours_day` hours to the clock-in moment.
 */
function resolveScheduledEnd(
  clockIn: Date,
  profile: Profile | null | undefined,
): Date {
  const targetHours = Number(profile?.target_hours_day ?? 8);
  const fallback = new Date(clockIn.getTime() + targetHours * 3600 * 1000);

  const shiftEnd = profile?.shift_end_time;
  if (!shiftEnd || typeof shiftEnd !== 'string') return fallback;

  // shiftEnd is "HH:MM" or "HH:MM:SS" — treat it as a wall-clock time
  // in the Africa/Cairo timezone. We construct an ISO string anchored
  // to today's Cairo date and parse it back.
  const match = shiftEnd.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return fallback;

  const [, hh, mm, ss] = match;
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(clockIn);
  // Build "YYYY-MM-DDTHH:MM:SS+03:00" — Cairo is UTC+03 year-round (no
  // DST). If Egypt re-introduces DST we'll need to revisit.
  const isoWithOffset = `${today}T${hh.padStart(2, '0')}:${mm}:${ss ?? '00'}+03:00`;
  const candidate = new Date(isoWithOffset);
  if (Number.isNaN(candidate.getTime())) return fallback;

  // If the resolved scheduled end is BEFORE the clock-in (e.g. the
  // employee clocked in at 22:00 for a night shift ending at 06:00),
  // shift it to the next day.
  if (candidate.getTime() <= clockIn.getTime()) {
    return new Date(candidate.getTime() + 24 * 3600 * 1000);
  }
  return candidate;
}

export function AttendanceCountdown({
  clockInISO,
  clockOutISO,
  profile,
}: AttendanceCountdownProps) {
  const [now, setNow] = useState(() => Date.now());

  // Re-render every second while clocked in. We intentionally tick at
  // 1 Hz so the seconds counter stays smooth — the parent still
  // refetches /me/today on a slower cadence for source-of-truth.
  useEffect(() => {
    if (!clockInISO || clockOutISO) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [clockInISO, clockOutISO]);

  const clockIn = useMemo(
    () => (clockInISO ? new Date(clockInISO) : null),
    [clockInISO],
  );

  const scheduledEnd = useMemo(
    () => (clockIn ? resolveScheduledEnd(clockIn, profile) : null),
    [clockIn, profile],
  );

  if (!clockIn) return null;

  const clockedOut = !!clockOutISO;
  const elapsedMs = (clockedOut ? new Date(clockOutISO!).getTime() : now) - clockIn.getTime();
  const remainingMs = scheduledEnd ? scheduledEnd.getTime() - now : 0;
  const overdue = !clockedOut && scheduledEnd ? remainingMs <= 0 : false;
  const overflowMs = overdue ? -remainingMs : 0;

  const elapsed = breakdown(elapsedMs);
  const remaining = breakdown(remainingMs);
  const overflow = breakdown(overflowMs);

  // Resolved-end Cairo wall clock for display, e.g. "16:00".
  const endLabel = scheduledEnd
    ? new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Africa/Cairo',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(scheduledEnd)
    : null;

  if (clockedOut) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4 shadow-sm">
        <div className="flex items-center gap-2 text-slate-600 text-sm">
          <Clock size={16} />
          <span>
            انصرفت بعد <span className="font-bold tabular-nums">{fmtHM(elapsed)}</span>{' '}
            من بداية الوردية.
          </span>
        </div>
      </div>
    );
  }

  if (overdue) {
    return (
      <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 shadow-sm">
        <div className="flex items-start gap-3">
          <AlertCircle size={18} className="text-amber-700 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold text-amber-900">
              انتهى وقت العمل منذ{' '}
              <span className="tabular-nums">{fmtHM(overflow)}</span>
            </div>
            <div className="text-[11px] text-amber-800/80 mt-1 leading-relaxed">
              زمن الحضور حتى الآن{' '}
              <span className="font-mono tabular-nums">{fmtClock(elapsed)}</span>
              {endLabel ? ` · موعد الانتهاء كان ${endLabel}` : null}.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-blue-200 bg-blue-50/70 p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <Hourglass size={18} className="text-blue-700 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-blue-900">
            متبقي على انتهاء وقت العمل{' '}
            <span className="tabular-nums">{fmtHM(remaining)}</span>
          </div>
          <div className="text-[11px] text-blue-800/80 mt-1 leading-relaxed">
            زمن الحضور حتى الآن{' '}
            <span className="font-mono tabular-nums">{fmtClock(elapsed)}</span>
            {endLabel ? ` · ينتهي ${endLabel}` : null}.
          </div>
        </div>
      </div>
    </div>
  );
}
