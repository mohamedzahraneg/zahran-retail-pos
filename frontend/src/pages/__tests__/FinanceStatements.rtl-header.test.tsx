/**
 * FinanceStatements.rtl-header.test.tsx — PR-FIN-STATEMENTS-RTL-HEADER
 *
 * Mirrors the regression guard added in PR-FIN-DASHBOARD-RTL-HEADER
 * (DashboardHeader.rtl.test.tsx). The /finance-statements page header
 * had the same `order-2 lg:order-1` / `order-1 lg:order-2` swap that
 * silently inverted the layout in RTL on `lg` breakpoints, dropping
 * the title to the LEFT side of the page. The fix is to reorder the
 * JSX naturally (title block first, actions second) and remove the
 * `order-*` classes; in an RTL flex row with `justify-between`, the
 * first DOM child sits on the right.
 *
 * These specs lock the contract by asserting:
 *   ✓ title block precedes the actions block in DOM order
 *   ✓ no leftover `order-*` Tailwind classes on either child
 *   ✓ header title text "كشف الحسابات" is present in the title block
 *
 * Anyone re-introducing an `order-*` swap (or moving the title block
 * after the actions in JSX) fails CI.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { FinanceStatements } from '@/pages/FinanceStatements';

vi.mock('@/api/statements.api', () => ({
  statementsApi: {
    glAccount: vi.fn(),
    cashbox: vi.fn(),
    employee: vi.fn(),
    customer: vi.fn(),
    supplier: vi.fn(),
  },
}));
vi.mock('@/api/accounts.api', () => ({
  accountsApi: { list: vi.fn(async () => []) },
}));
vi.mock('@/api/cash-desk.api', () => ({
  cashDeskApi: { cashboxes: vi.fn(async () => []) },
}));
vi.mock('@/api/customers.api', () => ({
  customersApi: { list: vi.fn(async () => ({ data: [] })) },
}));
vi.mock('@/api/suppliers.api', () => ({
  suppliersApi: { list: vi.fn(async () => []) },
}));
vi.mock('@/api/users.api', () => ({
  usersApi: { list: vi.fn(async () => []) },
}));

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <FinanceStatements />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<FinanceStatements /> RTL header — PR-FIN-STATEMENTS-RTL-HEADER', () => {
  it('renders the title block BEFORE the actions block in DOM order', () => {
    renderPage();
    const header = screen.getByTestId('statements-header');
    const titleBlock = screen.getByTestId(
      'finance-statements-header-title-block',
    );
    const actionsBlock = screen.getByTestId(
      'finance-statements-header-actions',
    );
    // Both must be direct children of the header flex row.
    expect(header.contains(titleBlock)).toBe(true);
    expect(header.contains(actionsBlock)).toBe(true);
    // Natural DOM order: title first, actions second. In RTL flex
    // with justify-between, this puts the title on the RIGHT and
    // the actions on the LEFT.
    const children = Array.from(header.children);
    expect(children.indexOf(titleBlock)).toBeLessThan(
      children.indexOf(actionsBlock),
    );
  });

  it('header children carry NO leftover Tailwind `order-*` classes (mobile or lg)', () => {
    renderPage();
    const titleBlock = screen.getByTestId(
      'finance-statements-header-title-block',
    );
    const actionsBlock = screen.getByTestId(
      'finance-statements-header-actions',
    );
    for (const el of [titleBlock, actionsBlock]) {
      const cls = el.className;
      // Forbid any `order-N` (mobile) or `lg:order-N` / `md:order-N`
      // / `sm:order-N` / `xl:order-N` (responsive) — those re-introduce
      // the bug.
      expect(cls).not.toMatch(/(?:^|\s)order-\d/);
      expect(cls).not.toMatch(/(?:^|\s)(?:sm|md|lg|xl|2xl):order-\d/);
    }
  });

  it('title block contains the header title "كشف الحسابات"', () => {
    renderPage();
    const titleBlock = screen.getByTestId(
      'finance-statements-header-title-block',
    );
    expect(titleBlock.textContent).toMatch(/كشف الحسابات/);
  });
});
