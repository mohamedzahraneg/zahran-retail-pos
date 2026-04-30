/**
 * Settings.payment-accounts-tab.test.tsx
 *
 * PR-FIN-PAYACCT-4D-UX-FIX-4 — pins the 4 deep-link buttons inside
 * the Settings → "حسابات التحصيل" tab. Each button must point at
 * /cashboxes with the right query params so the unified treasury
 * page can auto-open the matching create modal:
 *
 *   إضافة حساب دفع           → /cashboxes?action=create-account
 *   إضافة محفظة إلكترونية    → /cashboxes?action=create-account&method=wallet
 *   إضافة حساب بنكي          → /cashboxes?action=create-account&method=bank_transfer
 *   إضافة حساب شيكات         → /cashboxes?action=create-account&method=check
 *
 * PR-FIN-PAYACCT-4D-UX-FIX-5 — also pins that the restored logo
 * manager section ("صور وشعارات وسائل الدفع") mounts inside the
 * tab, so a future refactor can't silently strip it again.
 *
 * Locks the regression: anyone removing a quick-action button or the
 * logo manager section fails CI.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PaymentAccountsTab } from '../Settings';

// The logo manager mounts React Query hooks. Mock the API so the
// manager renders the empty-state path without firing real network
// calls in jsdom — keeps this test focused on the tab's own contract.
vi.mock('@/api/payments.api', async () => {
  const actual = await vi.importActual<typeof import('@/api/payments.api')>(
    '@/api/payments.api',
  );
  return {
    ...actual,
    paymentsApi: {
      ...actual.paymentsApi,
      listAccounts: vi.fn(async () => []),
      listProviders: vi.fn(async () => []),
      updateAccount: vi.fn(),
    },
  };
});

function renderTab() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <PaymentAccountsTab />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Settings → PaymentAccountsTab — PR-FIN-PAYACCT-4D-UX-FIX-4', () => {
  it('keeps the redirect link to /cashboxes', () => {
    renderTab();
    const link = screen.getByTestId('payment-accounts-tab-redirect-link');
    expect(link.getAttribute('href')).toBe('/cashboxes');
  });

  it('renders the quick-actions section (no longer a dead-end)', () => {
    renderTab();
    expect(screen.getByTestId('payment-accounts-tab-quick-actions')).toBeInTheDocument();
  });

  it('"إضافة حساب دفع" deep-links to /cashboxes?action=create-account', () => {
    renderTab();
    const link = screen.getByTestId('settings-quick-add-payment-account');
    expect(link.getAttribute('href')).toBe('/cashboxes?action=create-account');
    expect(link.textContent).toMatch(/إضافة حساب دفع/);
  });

  it('"إضافة محفظة إلكترونية" deep-links with method=wallet', () => {
    renderTab();
    const link = screen.getByTestId('settings-quick-add-wallet');
    expect(link.getAttribute('href')).toBe('/cashboxes?action=create-account&method=wallet');
    expect(link.textContent).toMatch(/إضافة محفظة إلكترونية/);
  });

  it('"إضافة حساب بنكي" deep-links with method=bank_transfer', () => {
    renderTab();
    const link = screen.getByTestId('settings-quick-add-bank');
    expect(link.getAttribute('href')).toBe('/cashboxes?action=create-account&method=bank_transfer');
    expect(link.textContent).toMatch(/إضافة حساب بنكي/);
  });

  it('"إضافة حساب شيكات" deep-links with method=check', () => {
    renderTab();
    const link = screen.getByTestId('settings-quick-add-check');
    expect(link.getAttribute('href')).toBe('/cashboxes?action=create-account&method=check');
    expect(link.textContent).toMatch(/إضافة حساب شيكات/);
  });
});

describe('Settings → PaymentAccountsTab — PR-FIN-PAYACCT-4D-UX-FIX-5', () => {
  it('mounts the restored logo-manager section', () => {
    renderTab();
    expect(
      screen.getByTestId('payment-accounts-tab-logo-manager'),
    ).toBeInTheDocument();
    expect(screen.getByText('صور وشعارات وسائل الدفع')).toBeInTheDocument();
  });
});
