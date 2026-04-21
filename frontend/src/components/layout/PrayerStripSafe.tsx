import { Component, ReactNode, Suspense, lazy } from 'react';

// Lazy-load the real strip so a broken adhan import can't take down
// the whole AppLayout — the chunk only loads after the layout mounts.
const PrayerStripImpl = lazy(() =>
  import('./PrayerStrip').then((m) => ({ default: m.PrayerStrip })),
);

class PrayerStripBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    // eslint-disable-next-line no-console
    console.warn('[PrayerStrip] suppressed error', err);
  }
  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

/**
 * Top-bar strip for clock / Hijri date / prayer countdowns, wrapped
 * in an error boundary + suspense. If the underlying component (or
 * its adhan dependency) blows up, the rest of the app keeps working.
 */
export function PrayerStripSafe() {
  return (
    <PrayerStripBoundary>
      <Suspense fallback={null}>
        <PrayerStripImpl />
      </Suspense>
    </PrayerStripBoundary>
  );
}
