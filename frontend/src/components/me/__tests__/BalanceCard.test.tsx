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
});
