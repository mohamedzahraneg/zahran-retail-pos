/**
 * Sidebar.placeholders.test.tsx — PR-FIN-SIDEBAR-1
 *
 * Pins the placeholder UX for the four upcoming financial PRs:
 *   · التقارير (PR-FIN-7)
 *   · كشف الحسابات (PR-FIN-3)
 *   · الزكاة (PR-FIN-8)
 *   · تتبع الحركات المالية (PR-FIN-4)
 *
 * Each appears in the sidebar AFTER the existing 9 active items in
 * the "الحسابات والمالية" group, renders as a non-clickable element
 * (NOT an `<a>` tag), shows a "قريبًا" pill, and carries
 * `aria-disabled="true"`.
 *
 * Existing active items (الحسابات / فتح الحسابات / التحليلات الذكية /
 * الصندوق اليومي / الخزائن والبنوك / المصاريف الدورية / المصروفات
 * اليومية / برج المراقبة المالية / لوحة التحكم) must remain rendered
 * as router links — regression guard against accidentally flipping
 * an active item into a placeholder.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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

describe('<Sidebar /> — PR-FIN-SIDEBAR-1 placeholders', () => {
  beforeEach(() => {
    // Admin has wildcard `*` → sees every item including placeholders.
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

  const PLACEHOLDERS = [
    // PR-FIN-3 flipped "كشف الحسابات" from placeholder to active link
    // (/finance/statements). The remaining 3 stay as placeholders
    // until their respective PRs (FIN-7 / FIN-8 / FIN-4) ship.
    // PR-FIN-SIDEBAR-2 renamed the /finance/reports placeholder from
    // "التقارير" to "التقارير المالية" to disambiguate from the
    // global /reports item in the top-level reports sidebar group.
    { label: 'التقارير المالية', to: '/finance/reports' },
    { label: 'الزكاة', to: '/finance/zakat' },
    { label: 'تتبع الحركات المالية', to: '/audit/financial-movements' },
  ];

  it.each(PLACEHOLDERS)(
    '$label renders as a disabled placeholder (not a router link)',
    ({ label, to }) => {
      renderSidebar();
      const el = screen.getByTestId(`sidebar-placeholder-${to}`);
      expect(el).toBeInTheDocument();
      // It's the new role="link" + aria-disabled element — NOT an <a>.
      expect(el.tagName.toLowerCase()).not.toBe('a');
      expect(el.getAttribute('aria-disabled')).toBe('true');
      // Label is rendered inside.
      expect(within(el).getByText(label)).toBeInTheDocument();
      // Cursor + opacity styling derived from the placeholder branch.
      expect(el.className).toMatch(/cursor-not-allowed/);
      expect(el.className).toMatch(/opacity-60/);
    },
  );

  it('every placeholder shows the "قريبًا" pill', () => {
    renderSidebar();
    for (const { to } of PLACEHOLDERS) {
      const el = screen.getByTestId(`sidebar-placeholder-${to}`);
      const pill = within(el).getByTestId('sidebar-coming-soon-pill');
      expect(pill).toBeInTheDocument();
      expect(pill.textContent).toBe('قريبًا');
    }
  });

  it('every placeholder carries the tooltip "متاح في تحديث لاحق"', () => {
    renderSidebar();
    for (const { to } of PLACEHOLDERS) {
      const el = screen.getByTestId(`sidebar-placeholder-${to}`);
      expect(el.getAttribute('title')).toBe('متاح في تحديث لاحق');
    }
  });

  it('existing active items in the financial group still render as <a> (regression guard)', () => {
    renderSidebar();
    // A representative subset — if any of these flips to a placeholder
    // by accident, this test fails immediately.
    const active = [
      'لوحة التحكم',
      'الحسابات',
      'فتح الحسابات',
      'التحليلات الذكية',
      'الصندوق اليومي',
      'الخزائن والبنوك',
      'المصاريف الدورية',
      'المصروفات اليومية',
      'برج المراقبة المالية',
      // PR-FIN-3 — "كشف الحسابات" is now active too (route added).
      'كشف الحسابات',
    ];
    for (const label of active) {
      const els = screen.getAllByText(label);
      // At least one element with this label must be an <a> (NavLink).
      const link = els.find((el) => el.closest('a'));
      expect(link).toBeDefined();
    }
  });

  it('placeholders appear AFTER active items inside the financial group', () => {
    renderSidebar();
    // Find the "برج المراقبة المالية" item (last active in the group)
    // and the first placeholder — assert placeholder DOM index is
    // greater than the active item's.
    const activeAnchor = screen.getByText('برج المراقبة المالية');
    const firstPlaceholder = screen.getByTestId(
      'sidebar-placeholder-/finance/reports',
    );
    expect(
      activeAnchor.compareDocumentPosition(firstPlaceholder) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
