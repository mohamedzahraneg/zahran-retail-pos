/**
 * PaymentAccounts.test.tsx — PR-FIN-PAYACCT-4D
 *
 * The dedicated /payment-accounts page shipped in PR-4B has been
 * folded into the unified treasury page at /cashboxes. This file now
 * pins the redirect contract:
 *
 *   • <PaymentAccounts /> renders <Navigate to="/cashboxes" replace />
 *   • Visiting /payment-accounts ends up at /cashboxes
 *
 * Locks the regression: anyone reintroducing the standalone admin
 * page (or pointing the redirect somewhere else) fails CI.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import PaymentAccounts from '../PaymentAccounts';

describe('<PaymentAccounts /> — PR-FIN-PAYACCT-4D redirect', () => {
  it('redirects /payment-accounts → /cashboxes', () => {
    render(
      <MemoryRouter initialEntries={['/payment-accounts']}>
        <Routes>
          <Route path="/payment-accounts" element={<PaymentAccounts />} />
          <Route
            path="/cashboxes"
            element={<div data-testid="treasury-stub">treasury</div>}
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('treasury-stub')).toBeInTheDocument();
  });
});
