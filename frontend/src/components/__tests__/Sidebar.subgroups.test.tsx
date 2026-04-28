/**
 * Sidebar.subgroups.test.tsx — PR-FIN-SIDEBAR-2
 *
 * Pins the 6-sub-group layout of the "الحسابات والمالية" group:
 *
 *   1. لوحة الحسابات      → لوحة التحكم
 *   2. الحسابات والكشوف   → الحسابات · كشف الحسابات
 *   3. النقدية والخزائن   → الصندوق اليومي · الخزائن والبنوك
 *   4. المصروفات          → المصروفات اليومية · المصاريف الدورية
 *   5. المراقبة والتقارير → برج المراقبة المالية · التحليلات الذكية ·
 *                            تتبع الحركات المالية · التقارير المالية
 *   6. عمليات متقدمة     → فتح الحسابات · الزكاة
 *
 * Tests cover:
 *   · Sub-headers render in the documented order
 *   · Each item appears under the correct sub-header (DOM order)
 *   · Active items remain `<NavLink>` (an `<a>` in the DOM)
 *   · Placeholders remain non-clickable (`role="link" aria-disabled="true"`)
 *   · "كشف الحسابات" stays an active link (PR-FIN-3 contract)
 *   · "التقارير المالية" is rendered as a placeholder (renamed from "التقارير")
 *   · Collapsed mode renders sub-headers as divider only — no text
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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

describe('<Sidebar /> — PR-FIN-SIDEBAR-2 sub-groups', () => {
  beforeEach(() => {
    // Admin (wildcard) so every item, sub-header, and placeholder
    // shows up.
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
    // Default layout state — sidebar expanded.
    useLayoutStore.setState({ collapsed: false, mobileOpen: false } as any);
  });

  // ─── 1. Sub-header order ─────────────────────────────────────
  it('renders all 6 sub-headers in the approved order', () => {
    renderSidebar();
    const expected = [
      'لوحة الحسابات',
      'الحسابات والكشوف',
      'النقدية والخزائن',
      'المصروفات',
      'المراقبة والتقارير',
      'عمليات متقدمة',
    ];
    const headers = expected.map((label) =>
      screen.getByText(label, { selector: 'div' }),
    );
    // DOM order: each subsequent header must come AFTER the previous
    for (let i = 1; i < headers.length; i++) {
      expect(
        headers[i - 1].compareDocumentPosition(headers[i]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  // ─── 2. Items under correct sub-header ───────────────────────
  // Items are identified by `href` (for active links) or
  // placeholder testid (for the 3 placeholders) so the assertions
  // are robust against label collisions (e.g. "لوحة التحكم"
  // appears both for / and /dashboard/finance).
  const PLACEMENTS: Array<{
    subheaderKey: string;
    itemSelectors: Array<{ kind: 'href' | 'placeholder'; key: string; visibleLabel: string }>;
  }> = [
    {
      subheaderKey: 'subhdr:fin:dashboard',
      itemSelectors: [
        { kind: 'href', key: '/dashboard/finance', visibleLabel: 'لوحة التحكم' },
      ],
    },
    {
      subheaderKey: 'subhdr:fin:accounts',
      itemSelectors: [
        { kind: 'href', key: '/accounts', visibleLabel: 'الحسابات' },
        { kind: 'href', key: '/finance/statements', visibleLabel: 'كشف الحسابات' },
      ],
    },
    {
      subheaderKey: 'subhdr:fin:cash',
      itemSelectors: [
        { kind: 'href', key: '/cash-desk', visibleLabel: 'الصندوق اليومي' },
        { kind: 'href', key: '/cashboxes', visibleLabel: 'الخزائن والبنوك' },
      ],
    },
    {
      subheaderKey: 'subhdr:fin:expenses',
      // Q4: daily-before-recurring
      itemSelectors: [
        { kind: 'href', key: '/daily-expenses', visibleLabel: 'المصروفات اليومية' },
        { kind: 'href', key: '/recurring-expenses', visibleLabel: 'المصاريف الدورية' },
      ],
    },
    {
      subheaderKey: 'subhdr:fin:monitoring',
      itemSelectors: [
        { kind: 'href', key: '/dashboard/financial', visibleLabel: 'برج المراقبة المالية' },
        { kind: 'href', key: '/analytics', visibleLabel: 'التحليلات الذكية' },
        { kind: 'placeholder', key: '/audit/financial-movements', visibleLabel: 'تتبع الحركات المالية' },
        { kind: 'placeholder', key: '/finance/reports', visibleLabel: 'التقارير المالية' },
      ],
    },
    {
      subheaderKey: 'subhdr:fin:advanced',
      itemSelectors: [
        { kind: 'href', key: '/opening-balance', visibleLabel: 'فتح الحسابات' },
        { kind: 'placeholder', key: '/finance/zakat', visibleLabel: 'الزكاة' },
      ],
    },
  ];

  it.each(PLACEMENTS)(
    'items under sub-header "$subheaderKey" appear in the documented order',
    ({ subheaderKey, itemSelectors }) => {
      renderSidebar();
      const headerEl = screen.getByTestId(`sidebar-subheader-${subheaderKey}`);
      const itemEls = itemSelectors.map((sel) =>
        sel.kind === 'href'
          ? (document.querySelector(`a[href="${sel.key}"]`) as Element)
          : screen.getByTestId(`sidebar-placeholder-${sel.key}`),
      );
      // Sub-header comes BEFORE the first item.
      expect(
        headerEl.compareDocumentPosition(itemEls[0]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      // Items appear in the documented order.
      for (let i = 1; i < itemEls.length; i++) {
        expect(
          itemEls[i - 1].compareDocumentPosition(itemEls[i]) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }
      // Visible label sanity: each element actually contains the
      // expected Arabic text.
      itemSelectors.forEach((sel, i) => {
        expect(itemEls[i].textContent).toMatch(sel.visibleLabel);
      });
    },
  );

  // ─── 3. Active vs placeholder rendering ──────────────────────
  it('active items in the financial group render as NavLink (<a>)', () => {
    renderSidebar();
    // Sample of items that MUST be clickable links after this PR.
    const active = [
      'لوحة التحكم',
      'الحسابات',
      'كشف الحسابات', // PR-FIN-3 — explicitly stays active
      'الصندوق اليومي',
      'الخزائن والبنوك',
      'المصروفات اليومية',
      'المصاريف الدورية',
      'برج المراقبة المالية',
      'التحليلات الذكية',
      'فتح الحسابات',
    ];
    for (const label of active) {
      const els = screen.getAllByText(label);
      const link = els.find((el) => el.closest('a'));
      expect(link, `expected "${label}" to be a router link`).toBeDefined();
    }
  });

  it('placeholders remain non-clickable (role="link" aria-disabled="true")', () => {
    renderSidebar();
    const placeholders: Array<{ label: string; to: string }> = [
      { label: 'التقارير المالية', to: '/finance/reports' },
      { label: 'الزكاة', to: '/finance/zakat' },
      { label: 'تتبع الحركات المالية', to: '/audit/financial-movements' },
    ];
    for (const { label, to } of placeholders) {
      const el = screen.getByTestId(`sidebar-placeholder-${to}`);
      expect(el.tagName.toLowerCase()).not.toBe('a');
      expect(el.getAttribute('aria-disabled')).toBe('true');
      expect(within(el).getByText(label)).toBeInTheDocument();
    }
  });

  it('"التقارير المالية" placeholder uses the renamed label, not the old "التقارير"', () => {
    renderSidebar();
    // The new label exists.
    const el = screen.getByTestId('sidebar-placeholder-/finance/reports');
    expect(within(el).getByText('التقارير المالية')).toBeInTheDocument();
    // The old plain "التقارير" must not appear inside this specific
    // placeholder element (the global /reports item in the top-level
    // "التقارير" group still uses the plain label, but that's a
    // different element).
    expect(within(el).queryByText('التقارير')).toBeNull();
  });

  // ─── 4. Collapsed mode ───────────────────────────────────────
  it('collapsed sidebar renders sub-headers as divider only (no label text)', () => {
    useLayoutStore.setState({ collapsed: true, mobileOpen: false } as any);
    renderSidebar();
    // Sub-header testids still present (used as React keys)
    const headerKeys = [
      'subhdr:fin:dashboard',
      'subhdr:fin:accounts',
      'subhdr:fin:cash',
      'subhdr:fin:expenses',
      'subhdr:fin:monitoring',
      'subhdr:fin:advanced',
    ];
    for (const k of headerKeys) {
      const el = screen.getByTestId(`sidebar-subheader-${k}`);
      // Collapsed: it's a bare divider — no text content.
      expect(el.textContent ?? '').toBe('');
      // And aria-hidden so screen readers skip it.
      expect(el.getAttribute('aria-hidden')).toBe('true');
    }
    // None of the sub-header Arabic labels appear as visible text in
    // collapsed mode.
    for (const label of [
      'لوحة الحسابات',
      'الحسابات والكشوف',
      'النقدية والخزائن',
      'المصروفات',
      'المراقبة والتقارير',
      'عمليات متقدمة',
    ]) {
      // queryByText returns null when not in the DOM. Some labels
      // (e.g. "المصروفات") could appear elsewhere; we constrain to
      // the sub-header role attribute to avoid false negatives.
      const matches = screen.queryAllByText(label);
      // Sub-header label text is suppressed in collapsed mode → none
      // of the matches should be the sub-header presentation div.
      for (const m of matches) {
        expect(m.getAttribute('role')).not.toBe('presentation');
      }
    }
  });

  // ─── 5. No route changes — same tos as before ───────────────
  // The finance "لوحة التحكم" label coincides with the top-level
  // "/" home item's label, so we verify each (label, route) pair by
  // searching for an anchor with the expected `href` and asserting
  // its visible text contains the expected label. That avoids
  // ambiguity where two items share the same Arabic word.
  it('clickable items keep the same routes (no App.tsx route changes)', () => {
    renderSidebar();
    const expectedPairs: Array<{ label: string; href: string }> = [
      { label: 'لوحة التحكم', href: '/dashboard/finance' },
      { label: 'الحسابات', href: '/accounts' },
      { label: 'كشف الحسابات', href: '/finance/statements' },
      { label: 'الصندوق اليومي', href: '/cash-desk' },
      { label: 'الخزائن والبنوك', href: '/cashboxes' },
      { label: 'المصروفات اليومية', href: '/daily-expenses' },
      { label: 'المصاريف الدورية', href: '/recurring-expenses' },
      { label: 'برج المراقبة المالية', href: '/dashboard/financial' },
      { label: 'التحليلات الذكية', href: '/analytics' },
      { label: 'فتح الحسابات', href: '/opening-balance' },
    ];
    for (const { label, href } of expectedPairs) {
      const anchor = document.querySelector(`a[href="${href}"]`);
      expect(anchor, `expected anchor for href ${href}`).not.toBeNull();
      expect(anchor!.textContent).toMatch(label);
    }
  });
});
