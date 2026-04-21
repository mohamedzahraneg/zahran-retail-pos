import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Clock, MoonStar } from 'lucide-react';
import { Coordinates, CalculationMethod, PrayerTimes } from 'adhan';

// Cairo — good enough for all of Egypt (a few minutes' tolerance).
const CAIRO = new Coordinates(30.0444, 31.2357);
const PARAMS = CalculationMethod.Egyptian();

type PrayerKey = 'fajr' | 'dhuhr' | 'asr' | 'maghrib' | 'isha';

const ORDER: Array<{ key: PrayerKey; label: string }> = [
  { key: 'fajr', label: 'الفجر' },
  { key: 'dhuhr', label: 'الظهر' },
  { key: 'asr', label: 'العصر' },
  { key: 'maghrib', label: 'المغرب' },
  { key: 'isha', label: 'العشاء' },
];

function fmtTime(d: Date) {
  return d.toLocaleTimeString('ar-EG', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Africa/Cairo',
  });
}

function fmtHijri(d: Date) {
  try {
    return new Intl.DateTimeFormat('ar-EG-u-ca-islamic-umalqura', {
      timeZone: 'Africa/Cairo',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(d);
  } catch {
    return '';
  }
}

function fmtDay(d: Date) {
  return d.toLocaleDateString('ar-EG', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Africa/Cairo',
  });
}

function fmtClock(d: Date) {
  return d.toLocaleTimeString('ar-EG', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZone: 'Africa/Cairo',
  });
}

/**
 * Header strip: live clock with seconds, Gregorian + Hijri date, and the
 * next prayer time. Also toasts + plays a soft beep when each prayer
 * enters — once per prayer per day (dedup via localStorage).
 */
export function PrayerStrip() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const today = useMemo(
    () => new PrayerTimes(CAIRO, now, PARAMS),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [now.toDateString()],
  );

  // Fire a toast + beep when a prayer has just started. Runs every
  // second but only inside the first minute after each prayer, and
  // only once per prayer per day. Wrapped in try/catch so any
  // localStorage / adhan hiccup can't break the render loop.
  useEffect(() => {
    try {
      for (const { key, label } of ORDER) {
        const t = today?.[key] as Date | undefined;
        if (!t || !(t instanceof Date) || isNaN(t.getTime())) continue;
        const diffMs = now.getTime() - t.getTime();
        if (diffMs < 0 || diffMs > 60_000) continue;
        const stamp = `${t.toDateString()}:${key}`;
        const ls = `zahran_prayer_fired_${stamp}`;
        try {
          if (localStorage.getItem(ls)) continue;
          localStorage.setItem(ls, '1');
        } catch {
          /* private mode / quota — just fire the toast this tick */
        }
        toast(`حان الآن موعد ${label}`, {
          icon: '🕌',
          duration: 8000,
          style: {
            background: '#ecfccb',
            color: '#365314',
            fontWeight: 700,
          },
        });
        try {
          const AC =
            (window as any).AudioContext || (window as any).webkitAudioContext;
          if (!AC) continue;
          const ctx = new AC();
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.type = 'sine';
          o.frequency.value = 660;
          o.connect(g);
          g.connect(ctx.destination);
          g.gain.setValueAtTime(0.0001, ctx.currentTime);
          g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.05);
          g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1.1);
          o.start();
          o.stop(ctx.currentTime + 1.1);
        } catch {
          /* audio blocked — silent beep is fine */
        }
      }
    } catch {
      /* outer safety — never throw from this effect */
    }
  }, [now, today]);

  // Next prayer = earliest in ORDER whose time is still in the future;
  // if all of today's prayers have passed, fall back to tomorrow's fajr.
  const upcoming = ORDER.map((p) => ({
    ...p,
    at: today?.[p.key] as Date | undefined,
  })).filter(
    (p): p is { key: PrayerKey; label: string; at: Date } =>
      !!p.at && p.at instanceof Date && !isNaN(p.at.getTime()) &&
      p.at.getTime() > now.getTime(),
  )[0];

  let nextLabel: string | null = null;
  let nextTime: Date | null = null;
  if (upcoming) {
    nextLabel = upcoming.label;
    nextTime = upcoming.at;
  } else {
    // Tomorrow's fajr
    const t = new Date(now);
    t.setDate(t.getDate() + 1);
    const tomorrow = new PrayerTimes(CAIRO, t, PARAMS);
    nextLabel = 'الفجر';
    nextTime = tomorrow.fajr;
  }

  const fmtCountdown = (ms: number) => {
    if (ms <= 0) return '—';
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(
      s,
    ).padStart(2, '0')}`;
  };

  // All remaining prayers today (plus tomorrow's fajr if all of today's have passed).
  const remaining = (() => {
    try {
      const list = ORDER.map((p) => ({
        label: p.label,
        at: today?.[p.key] as Date | undefined,
      })).filter(
        (p): p is { label: string; at: Date } =>
          !!p.at && p.at instanceof Date && !isNaN(p.at.getTime()) &&
          p.at.getTime() > now.getTime(),
      );
      if (list.length) return list;
      const t = new Date(now);
      t.setDate(t.getDate() + 1);
      const tomorrow = new PrayerTimes(CAIRO, t, PARAMS);
      return tomorrow?.fajr
        ? [{ label: 'الفجر', at: tomorrow.fajr }]
        : [];
    } catch {
      return [];
    }
  })();

  return (
    <div className="hidden md:flex items-center gap-3 text-xs text-slate-600 flex-wrap">
      <div className="flex items-center gap-1.5 font-bold text-slate-800">
        <Clock size={14} className="text-indigo-500" />
        <span className="tabular-nums">{fmtClock(now)}</span>
      </div>
      <div className="hidden lg:block text-slate-500">{fmtDay(now)}</div>
      <div className="hidden xl:flex items-center gap-1 text-emerald-700">
        <MoonStar size={13} />
        <span>{fmtHijri(now)}</span>
      </div>
      {/* Per-prayer countdown — updates every second */}
      {nextLabel && (
        <div
          className="hidden md:flex items-center gap-1.5 flex-wrap"
          title={ORDER.map(
            (p) => `${p.label} ${fmtTime(today[p.key] as Date)}`,
          ).join(' · ')}
        >
          {remaining.map((p, idx) => {
            const isNext = idx === 0;
            const diff = p.at.getTime() - now.getTime();
            return (
              <span
                key={p.label}
                className={`flex items-center gap-1 rounded-lg px-2 py-1 border ${
                  isNext
                    ? 'bg-emerald-50 border-emerald-300 text-emerald-700 font-bold'
                    : 'bg-slate-50 border-slate-200 text-slate-600'
                }`}
              >
                <span>{p.label}</span>
                <span className="tabular-nums">{fmtTime(p.at)}</span>
                <span className="text-[10px] opacity-80 tabular-nums">
                  {fmtCountdown(diff)}
                </span>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
