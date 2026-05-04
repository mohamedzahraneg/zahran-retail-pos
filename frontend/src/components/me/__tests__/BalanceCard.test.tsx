/**
 * BalanceCard.test.tsx — PR-ESS-2A-UI-1
 *
 * Pins the sign convention so the /me balance card can never disagree
 * with the manager's "الرصيد النهائي" card in Team Management:
 *
 *   balance < -0.01  → "له"     (green)   "الشركة مدينة لك..."
 *   balance > +0.01  → "عليه"   (red)     "أنت مدين للشركة..."
 *   |balance| ≤ 0.01 → "متوازن" (neutral) "لا توجد فروق متبقية"
 *
 * Magnitude is always shown as `Math.abs(balance)`.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BalanceCard } from '../BalanceCard';

describe('<BalanceCard /> — sign convention', () => {
  it('shows "له" with green tone when balance is negative (company owes)', () => {
    render(<BalanceCard glLiveSnapshot={-1250} />);

    const label = screen.getByTestId('balance-card-label');
    expect(label).toHaveTextContent('له');
    expect(label.className).toMatch(/emerald/);

    const value = screen.getByTestId('balance-card-value');
    // Value displayed as positive magnitude.
    expect(value).toHaveTextContent('1,250.00');
    expect(value.className).toMatch(/emerald/);

    expect(screen.getByText(/الشركة مدينة لك/)).toBeInTheDocument();
  });

  it('shows "عليه" with red tone when balance is positive (employee owes)', () => {
    render(<BalanceCard glLiveSnapshot={300} />);

    const label = screen.getByTestId('balance-card-label');
    expect(label).toHaveTextContent('عليه');
    expect(label.className).toMatch(/rose/);

    const value = screen.getByTestId('balance-card-value');
    expect(value).toHaveTextContent('300.00');
    expect(value.className).toMatch(/rose/);

    expect(screen.getByText(/أنت مدين للشركة/)).toBeInTheDocument();
  });

  it('shows "متوازن" with neutral tone when balance is zero', () => {
    render(<BalanceCard glLiveSnapshot={0} />);

    const label = screen.getByTestId('balance-card-label');
    expect(label).toHaveTextContent('متوازن');
    expect(label.className).toMatch(/slate/);

    const value = screen.getByTestId('balance-card-value');
    expect(value).toHaveTextContent('0.00');
    expect(value.className).toMatch(/slate/);

    expect(screen.getByText(/لا توجد فروق متبقية/)).toBeInTheDocument();
  });

  it('treats |balance| ≤ 0.01 as balanced (rounding tolerance)', () => {
    render(<BalanceCard glLiveSnapshot={0.005} />);
    expect(screen.getByTestId('balance-card-label')).toHaveTextContent('متوازن');
  });

  it('treats balance just past the tolerance as non-balanced', () => {
    const { unmount } = render(<BalanceCard glLiveSnapshot={0.02} />);
    expect(screen.getByTestId('balance-card-label')).toHaveTextContent('عليه');
    unmount();

    render(<BalanceCard glLiveSnapshot={-0.02} />);
    expect(screen.getByTestId('balance-card-label')).toHaveTextContent('له');
  });

  it('handles null / undefined as zero (balanced)', () => {
    const { unmount } = render(<BalanceCard glLiveSnapshot={null} />);
    expect(screen.getByTestId('balance-card-label')).toHaveTextContent('متوازن');
    unmount();

    render(<BalanceCard glLiveSnapshot={undefined} />);
    expect(screen.getByTestId('balance-card-label')).toHaveTextContent('متوازن');
  });

  it('renders ellipsis instead of value when loading', () => {
    render(<BalanceCard glLiveSnapshot={undefined} loading />);
    expect(screen.getByTestId('balance-card-value')).toHaveTextContent('…');
  });

  it('always shows the "الرصيد الحالي" header', () => {
    render(<BalanceCard glLiveSnapshot={-100} />);
    expect(screen.getByText('الرصيد الحالي')).toBeInTheDocument();
  });

  // ─── PR-AUDIT-EMPLOYEE-VIEW-UNIFY — named-employee fixtures ──────
  // Pin the canonical sign convention against the actual production
  // employees from the audit baseline (captured 2026-05-04). If a
  // future refactor flips the sign or revives the inverted
  // `v_employee_balances_gl.net_balance`, these tests fail by name —
  // making the regression obvious in CI.
  describe('PR-AUDIT-EMPLOYEE-VIEW-UNIFY — named-employee fixtures', () => {
    it('Abu Yousef (balance = -30) renders "له 30" green', () => {
      render(<BalanceCard glLiveSnapshot={-30} />);
      expect(screen.getByTestId('balance-card-label')).toHaveTextContent('له');
      expect(screen.getByTestId('balance-card-label').className).toMatch(/emerald/);
      expect(screen.getByTestId('balance-card-value')).toHaveTextContent('30.00');
    });

    it('Mohamed El-Zobaty (balance = +2080) renders "عليه 2080" red', () => {
      render(<BalanceCard glLiveSnapshot={2080} />);
      expect(screen.getByTestId('balance-card-label')).toHaveTextContent('عليه');
      expect(screen.getByTestId('balance-card-label').className).toMatch(/rose/);
      expect(screen.getByTestId('balance-card-value')).toHaveTextContent('2,080.00');
    });

    it('Mahmoud Zahran (balance = -250) renders "له 250" green', () => {
      render(<BalanceCard glLiveSnapshot={-250} />);
      expect(screen.getByTestId('balance-card-label')).toHaveTextContent('له');
      expect(screen.getByTestId('balance-card-label').className).toMatch(/emerald/);
      expect(screen.getByTestId('balance-card-value')).toHaveTextContent('250.00');
    });

    it('Admin (balance = +10) renders "عليه 10" red', () => {
      render(<BalanceCard glLiveSnapshot={10} />);
      expect(screen.getByTestId('balance-card-label')).toHaveTextContent('عليه');
      expect(screen.getByTestId('balance-card-label').className).toMatch(/rose/);
      expect(screen.getByTestId('balance-card-value')).toHaveTextContent('10.00');
    });
  });
});
