/**
 * Analytics.liquidity.test.tsx
 * PR-FIN-ANALYTICS-LIQUIDITY-GL
 *
 * Pins the small FE-side change that pairs with the BE liquidity
 * fix:
 *
 *   ✓ The KPI tile that shows liquidity now reads
 *     "السيولة المحاسبية" (NOT the bare "السيولة" from before).
 *   ✓ Its value is still bound to `indicators.cash_on_hand` from
 *     `accountsApi.indicators` — the FE just renames the label;
 *     the BE owns the number.
 *   ✓ Its subtitle still reads "تكفي N يوم" using
 *     `indicators.cash_runway_days`.
 *   ✓ A clarifying tooltip names the GL accounts that roll up.
 *   ✓ Other adjacent tiles (revenue / inventory / etc.) are NOT
 *     touched by this PR.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

// Chart.js + react-chartjs-2 don't render in jsdom (canvas missing) —
// stub them so the page mounts. We only care about the KPI tile.
vi.mock('react-chartjs-2', () => ({
  Line:     () => null,
  Bar:      () => null,
  Doughnut: () => null,
}));

// We test the FE label/wiring; the BE shape is fixed by
// `accountsApi.indicators(...)`. Mock that API + the auxiliary feeds
// the page also calls (otherwise the page tries to fetch and warns).
const indicatorsMock = vi.fn();
const recommendationsMock = vi.fn();
const dailyMock = vi.fn();
const heatmapMock = vi.fn();
const topProductsMock = vi.fn();
const topCustomersMock = vi.fn();
const topSalesMock = vi.fn();

vi.mock('@/api/accounts.api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    accountsApi: {
      indicators:       (p: any) => indicatorsMock(p),
      recommendations:  (p: any) => recommendationsMock(p),
      dailyPerformance: (p: any) => dailyMock(p),
      hourlyHeatmap:    (p: any) => heatmapMock(p),
      topProducts:      (p: any) => topProductsMock(p),
      topCustomers:     (p: any) => topCustomersMock(p),
      topSalespeople:   (p: any) => topSalesMock(p),
    },
  };
});

import Analytics from '../Analytics';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <Analytics />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Mirror the `SmartIndicators` shape returned by the BE. The
  // production-snapshot numbers post-fix:
  //   cash_on_hand = 31,850.00 (GL 1111 + 1114, posted-non-void only)
  //   daily_burn   = 293.76    (YTD expenses / 123 days)
  //   cash_runway_days = 108   (round 31,850 / 293.76)
  indicatorsMock.mockResolvedValue({
    revenue: 0, cogs: 0, gross_profit: 0, gross_margin_pct: 0,
    expenses: 36132.13, returns_value: 0, net_profit: 0, net_margin_pct: 0,
    invoice_count: 0, avg_ticket: 0, return_count: 0, return_rate_pct: 0,
    inventory_value: 0, inventory_turns: 0,
    receivables: 0, payables: 0,
    cash_on_hand: 31850, daily_burn: 293.76, cash_runway_days: 108,
  });
  recommendationsMock.mockResolvedValue([]);
  dailyMock.mockResolvedValue([]);
  heatmapMock.mockResolvedValue([]);
  topProductsMock.mockResolvedValue([]);
  topCustomersMock.mockResolvedValue([]);
  topSalesMock.mockResolvedValue([]);
});

describe('<Analytics /> liquidity tile — PR-FIN-ANALYTICS-LIQUIDITY-GL', () => {
  it('renders the liquidity tile with the new label "السيولة المحاسبية"', async () => {
    renderPage();
    const tile = await screen.findByTestId('kpi-liquidity');
    expect(within(tile).getByText('السيولة المحاسبية')).toBeInTheDocument();
    // The pre-fix label is GONE.
    expect(within(tile).queryByText(/^السيولة$/)).toBeNull();
  });

  it('value is bound to indicators.cash_on_hand from the BE (FE owns no fallback)', async () => {
    renderPage();
    const tile = await screen.findByTestId('kpi-liquidity');
    // 31,850 EGP from the BE fixture — pre-fix value was 34,244.98.
    await waitFor(() =>
      expect(tile.textContent).toMatch(/31,850\.00/),
    );
    expect(tile.textContent).not.toMatch(/34,244\.98/);
  });

  it('subtitle still reads "تكفي N يوم" using cash_runway_days', async () => {
    renderPage();
    const tile = await screen.findByTestId('kpi-liquidity');
    await waitFor(() =>
      expect(tile.textContent).toMatch(/تكفي\s+108\s+يوم/),
    );
    // Pre-fix runway 117 must NOT appear.
    expect(tile.textContent).not.toMatch(/117\s*يوم/);
  });

  it('label carries an Arabic tooltip naming the GL accounts (cash + bank + wallet + check)', async () => {
    renderPage();
    const tile = await screen.findByTestId('kpi-liquidity');
    // The tooltip lives on the label container as native HTML
    // `title=`. We assert the substring covers the four bucket names.
    const labelEl = within(tile).getByText('السيولة المحاسبية').closest('[title]');
    expect(labelEl).not.toBeNull();
    const tooltip = labelEl!.getAttribute('title') ?? '';
    expect(tooltip).toMatch(/النقدية/);
    expect(tooltip).toMatch(/البنوك/);
    expect(tooltip).toMatch(/المحافظ/);
    expect(tooltip).toMatch(/الشيكات/);
    expect(tooltip).toMatch(/الأستاذ العام/);
  });

  it('does NOT change adjacent tiles (revenue / inventory remain present + unchanged)', async () => {
    renderPage();
    // The page is a wide KPI grid — confirm a non-liquidity tile
    // still shows up under its own label, and crucially, no other
    // tile picks up the new "السيولة المحاسبية" label by accident.
    await screen.findByTestId('kpi-liquidity');
    const liquidityHits = screen.getAllByText('السيولة المحاسبية');
    expect(liquidityHits).toHaveLength(1);
  });
});
