/**
 * Sidebar.placeholders.test.tsx — PR-FIN-SIDEBAR-1
 *
 * History — every placeholder originally tracked by this file has
 * been activated:
 *   · PR-FIN-3 flipped "كشف الحسابات" → /finance/statements
 *   · PR-FE-ACCOUNTING-ZAKAT-FRAMING flipped "الزكاة"
 *     → /finance/zakat (framing/planning shell — pages/Zakat.tsx)
 *   · PR-FE-ACCOUNTING-FINANCIAL-REPORTS-FRAMING flipped
 *     "التقارير المالية" → /finance/reports
 *     (framing/planning shell — pages/FinancialReports.tsx)
 *   · PR-FE-ACCOUNTING-FINANCIAL-MOVEMENTS-FRAMING flipped
 *     "تتبع الحركات المالية" → /audit/financial-movements
 *     (framing/planning shell — pages/FinancialMovements.tsx)
 *
 * After PR-FE-ACCOUNTING-FINANCIAL-MOVEMENTS-FRAMING the financial
 * group has ZERO remaining placeholder items. This file is now a
 * **regression guard**:
 *   · Every previously-flipped item must still render as a router
 *     `<a>` (catches accidental flips back to placeholder)
 *   · No `sidebar-placeholder-*` element exists for any of the
 *     four historical placeholder routes (catches accidental
 *     reintroduction)
 *
 * The placeholder rendering branch in Sidebar.tsx (`placeholder: true`
 * → "قريبًا" pill + tooltip + aria-disabled) is still exercised by
 * any future placeholder added in another sidebar group; the branch
 * itself is unchanged by this PR.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Sidebar } from '../layout/Sidebar';
import { useAuthStore } from '@/stores/auth.store';

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

describe('<Sidebar /> — financial group placeholders (post-flip regression guard)', () => {
  beforeEach(() => {
    // Admin has wildcard `*` → sees every item, so any placeholder
    // that accidentally regresses would show up under this user.
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
  });

  // The four historical placeholder routes — each MUST now render
  // as a router `<a>` and must NOT have a corresponding
  // `sidebar-placeholder-*` element in the DOM.
  const HISTORICAL_PLACEHOLDERS_NOW_ACTIVE = [
    { label: 'كشف الحسابات', to: '/finance/statements' },
    { label: 'الزكاة', to: '/finance/zakat' },
    { label: 'التقارير المالية', to: '/finance/reports' },
    { label: 'تتبع الحركات المالية', to: '/audit/financial-movements' },
  ];

  it.each(HISTORICAL_PLACEHOLDERS_NOW_ACTIVE)(
    '$label renders as a router link <a> (not a placeholder element)',
    ({ to }) => {
      renderSidebar();
      // The active link MUST exist…
      const anchor = document.querySelector(
        `a[href="${to}"]`,
      ) as HTMLAnchorElement | null;
      expect(anchor).not.toBeNull();
      // …and the placeholder element MUST NOT exist for the same
      // route. If a future regression flips one back to placeholder,
      // this assertion fails immediately.
      expect(
        screen.queryByTestId(`sidebar-placeholder-${to}`),
      ).toBeNull();
    },
  );

  it('all 13 active items in the financial group render as <a> (regression guard)', () => {
    renderSidebar();
    // The complete set of active items in the "الحسابات والمالية"
    // top-level group after the four flips above. If ANY of these
    // accidentally flips into a placeholder, the test fails.
    const active = [
      'لوحة التحكم',
      'الحسابات',
      'كشف الحسابات',
      'الصندوق اليومي',
      'الخزائن والبنوك',
      'المصروفات اليومية',
      'المصاريف الدورية',
      'برج المراقبة المالية',
      'التحليلات الذكية',
      'فتح الحسابات',
      'الزكاة',
      'التقارير المالية',
      // PR-FE-ACCOUNTING-FINANCIAL-MOVEMENTS-FRAMING — also active.
      'تتبع الحركات المالية',
      // PR-FIX-EXPENSE-APPROVALS-DISCOVERABILITY — graduated back into
      // the sidebar so users with accounts.approval.decide /
      // accounts.approval.manage can find pending expense approvals.
      'موافقات المصاريف',
    ];
    for (const label of active) {
      const els = screen.getAllByText(label);
      const link = els.find((el) => el.closest('a'));
      expect(link, `expected "${label}" to be a router link`).toBeDefined();
    }
  });
});

// ─── PR-FIX-EXPENSE-APPROVALS-DISCOVERABILITY — sidebar visibility ──
//
// The موافقات المصاريف entry routes to /financial-controls and is
// gated on (accounts.approval.decide OR accounts.approval.manage).
// Previously the route was reachable only by typing the URL, which is
// why pending approvals were invisible to managers/accountants.

describe('<Sidebar /> — موافقات المصاريف visibility', () => {
  function loginWith(permissions: string[]) {
    useAuthStore.setState({
      accessToken: 'tok',
      refreshToken: 'tok',
      user: {
        id: 'u-1',
        username: 'tester',
        role: 'manager',
        permissions,
      } as any,
    });
  }

  it('renders the link when user has accounts.approval.decide', () => {
    loginWith([
      'expenses.daily.create', // gates the المصروفات subheader
      'accounts.approval.decide',
    ]);
    renderSidebar();
    const anchor = document.querySelector(
      'a[href="/financial-controls"]',
    ) as HTMLAnchorElement | null;
    expect(anchor).not.toBeNull();
    expect(anchor!.textContent).toContain('موافقات المصاريف');
  });

  it('renders the link when user has accounts.approval.manage', () => {
    loginWith([
      'expenses.daily.create',
      'accounts.approval.manage',
    ]);
    renderSidebar();
    const anchor = document.querySelector(
      'a[href="/financial-controls"]',
    ) as HTMLAnchorElement | null;
    expect(anchor).not.toBeNull();
    expect(anchor!.textContent).toContain('موافقات المصاريف');
  });

  it('hides the link when user lacks both approval permissions', () => {
    loginWith([
      'expenses.daily.create', // sees the subheader but NOT the new item
      'expenses.daily.edit.request',
    ]);
    renderSidebar();
    expect(
      document.querySelector('a[href="/financial-controls"]'),
    ).toBeNull();
    expect(screen.queryByText('موافقات المصاريف')).toBeNull();
  });

  it('renders the link for admin (wildcard permission)', () => {
    loginWith(['*']);
    renderSidebar();
    const anchor = document.querySelector(
      'a[href="/financial-controls"]',
    ) as HTMLAnchorElement | null;
    expect(anchor).not.toBeNull();
    expect(anchor!.getAttribute('href')).toBe('/financial-controls');
  });
});
