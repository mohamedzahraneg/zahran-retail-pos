/**
 * Sidebar.treasury.test.tsx — PR-FIN-PAYACCT-4D
 *
 * Pins the post-unification sidebar shape:
 *
 *   ✓ Exactly ONE treasury entry exists ("الخزائن والبنوك" pointing
 *     at /cashboxes — the unified treasury page).
 *   ✓ The standalone "حسابات الدفع" entry from PR-4B is GONE (no
 *     duplicate sidebar row pointing at the same destination).
 *   ✓ /payment-accounts URL is not advertised in the sidebar.
 *
 * Locks the regression: anyone reintroducing a duplicate
 * "حسابات الدفع" sidebar entry fails CI.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Sidebar } from '../layout/Sidebar';
import { useAuthStore } from '@/stores/auth.store';
import { useLayoutStore } from '@/stores/layout.store';

vi.mock('@/api/alerts.api', () => ({
  alertsApi: {
    counts: vi.fn(async () => ({ unread: 0, critical: 0 })),
  },
}));

function renderSidebar() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}>
        <Sidebar />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<Sidebar /> — PR-FIN-PAYACCT-4D treasury entry', () => {
  beforeEach(() => {
    useAuthStore.setState({
      accessToken: 'tok',
      refreshToken: 'tok',
      user: {
        id: 'u-admin',
        username: 'admin',
        role: 'admin',
        permissions: ['*'],
      } as any,
    });
    useLayoutStore.setState({ collapsed: false, mobileOpen: false } as any);
  });

  it('has exactly ONE link pointing to /cashboxes (the unified treasury page)', () => {
    renderSidebar();
    const links = screen.getAllByRole('link', { name: /الخزائن|cashboxes/i });
    const treasuryLinks = links.filter(
      (a) => a.getAttribute('href') === '/cashboxes',
    );
    expect(treasuryLinks).toHaveLength(1);
  });

  it('does NOT render the standalone "حسابات الدفع" entry from PR-4B', () => {
    renderSidebar();
    // The PR-4B label was exactly "حسابات الدفع" pointing at
    // /payment-accounts. Neither should appear in the sidebar.
    expect(
      screen.queryByRole('link', { name: 'حسابات الدفع' }),
    ).toBeNull();
  });

  it('does NOT advertise /payment-accounts as a sidebar link (URL legacy redirect only)', () => {
    renderSidebar();
    const links = screen.getAllByRole('link');
    const paLinks = links.filter(
      (a) => a.getAttribute('href') === '/payment-accounts',
    );
    expect(paLinks).toHaveLength(0);
  });

  it('the surviving treasury entry uses the canonical "الخزائن والبنوك" label', () => {
    renderSidebar();
    const link = screen.getByRole('link', { name: /الخزائن والبنوك/ });
    expect(link.getAttribute('href')).toBe('/cashboxes');
  });
});
