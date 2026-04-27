/**
 * LiveClockCard.test.tsx — PR-ESS-2A-UI-1
 *
 * Pins:
 *   · Initial render produces day-name / full-date / time markup
 *   · Cairo timezone is used (regardless of the runner's TZ)
 *   · The seconds field updates after a 1-second tick
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { LiveClockCard } from '../LiveClockCard';

describe('<LiveClockCard />', () => {
  beforeEach(() => {
    // Anchor "now" to a deterministic instant so the formatted output
    // is stable regardless of when the test runs.
    // 2026-04-27T12:34:56Z = 15:34:56 in Africa/Cairo (UTC+03, no DST).
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-27T12:34:56Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders day name + full date + time + Cairo timezone hint', () => {
    render(<LiveClockCard />);

    // Day name in Arabic — 2026-04-27 (in Cairo) is a Monday.
    expect(screen.getByTestId('live-clock-day').textContent).toMatch(/الإثنين|الاثنين/);

    // Full date contains the year 2026.
    const dateText = screen.getByTestId('live-clock-date').textContent ?? '';
    // ar-EG locale outputs Arabic-Indic digits (٢٠٢٦); accept either form.
    expect(dateText).toMatch(/2026|٢٠٢٦/);

    // Time text contains seconds (3 colon-separated groups counting hour, minute, second
    // — Arabic-Indic digits or Latin digits depending on environment).
    const timeText = screen.getByTestId('live-clock-time').textContent ?? '';
    // Should match a HH:MM:SS pattern (digits in either script, optional am/pm).
    // We just assert there are at least two ':' separators.
    expect((timeText.match(/[:٫٬]/g) ?? []).length).toBeGreaterThanOrEqual(2);

    expect(screen.getByText(/Africa\/Cairo/)).toBeInTheDocument();
  });

  it('updates the displayed time after a 1-second tick', () => {
    render(<LiveClockCard />);

    const initial = screen.getByTestId('live-clock-time').textContent;

    // Advance the simulated clock by 1.5s; the interval fires once.
    act(() => {
      vi.advanceTimersByTime(1500);
    });

    const updated = screen.getByTestId('live-clock-time').textContent;
    expect(updated).not.toBe(initial);
  });

  it('uses Africa/Cairo even when system time is far from Egypt', () => {
    // Anchor at 2026-04-27 23:30 UTC. In Cairo (UTC+03) that's 02:30
    // the *next day* (2026-04-28, Tuesday).
    vi.setSystemTime(new Date('2026-04-27T23:30:00Z'));
    render(<LiveClockCard />);

    expect(screen.getByTestId('live-clock-day').textContent).toMatch(/الثلاثاء/);
  });
});
