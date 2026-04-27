/**
 * LiveClockCard — PR-ESS-2A-UI-1
 * ────────────────────────────────────────────────────────────────────
 *
 * Self-service "التاريخ والوقت" card on the /me top dashboard row.
 *
 * Renders three lines, all formatted in `Africa/Cairo` time:
 *   1. Day name (الأحد، الإثنين …) using ar-EG locale
 *   2. Full date — Arabic month name + day + year
 *   3. Live time HH:MM:SS with am/pm marker, ticking every second
 *
 * Display-only — the frontend clock is NOT a source of truth for
 * attendance accounting. Backend stays authoritative for actual
 * clock-in / clock-out timestamps. A few seconds of clock skew
 * between the browser and the server is acceptable for display.
 */

import { useEffect, useState } from 'react';
import { CalendarDays } from 'lucide-react';

const TZ = 'Africa/Cairo';

function formatDayName(d: Date): string {
  return d.toLocaleDateString('ar-EG', {
    timeZone: TZ,
    weekday: 'long',
  });
}

function formatFullDate(d: Date): string {
  return d.toLocaleDateString('ar-EG', {
    timeZone: TZ,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function formatTime(d: Date): string {
  // 12-hour Arabic-Egypt format with seconds, e.g. "08:45:32 ص".
  return d.toLocaleTimeString('ar-EG', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

export function LiveClockCard() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    // Tick once per second. The interval is paused automatically when
    // the browser tab is hidden (browsers throttle setInterval in
    // background tabs); on resume, the next tick re-sync's.
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div
      className="rounded-2xl border border-indigo-200 bg-indigo-50/70 p-4 shadow-sm flex flex-col gap-2"
      data-testid="live-clock-card"
      dir="rtl"
    >
      <div className="flex items-center gap-2 text-[12px] font-bold text-indigo-900">
        <CalendarDays size={14} />
        <span>التاريخ والوقت</span>
      </div>

      <div className="leading-tight">
        <div
          className="text-sm font-bold text-indigo-900"
          data-testid="live-clock-day"
        >
          {formatDayName(now)}
        </div>
        <div
          className="text-[11px] text-indigo-900/70"
          data-testid="live-clock-date"
        >
          {formatFullDate(now)}
        </div>
      </div>

      <div
        className="text-2xl font-black font-mono tabular-nums text-indigo-700"
        data-testid="live-clock-time"
        // English-Latin numerals via font-mono / tabular-nums; the
        // ar-EG locale by default emits Arabic-Indic digits, which we
        // accept since the user's spec says "Egypt Arabic format".
      >
        {formatTime(now)}
      </div>

      <div className="text-[10px] text-indigo-900/60">
        توقيت القاهرة (Africa/Cairo)
      </div>
    </div>
  );
}
