import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ProtectedRoute } from '../common/ProtectedRoute';
import { useAuthStore } from '@/stores/auth.store';

/**
 * Integration-ish test for the route guard.
 *
 * We wrap ProtectedRoute in a MemoryRouter with sibling `/login` and `/`
 * routes so we can assert redirects by looking at what rendered.
 */

const renderWithRoutes = (initialPath: string, requiredRoles?: string[]) =>
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/login" element={<div>LOGIN PAGE</div>} />
        <Route path="/" element={<div>HOME PAGE</div>} />
        <Route
          path="/secret"
          element={
            <ProtectedRoute roles={requiredRoles}>
              <div>SECRET CONTENT</div>
            </ProtectedRoute>
          }
        />
      </Routes>
    </MemoryRouter>,
  );

describe('<ProtectedRoute />', () => {
  beforeEach(() => {
    useAuthStore.setState({
      accessToken: null,
      refreshToken: null,
      user: null,
    });
  });

  it('redirects unauthenticated users to /login', () => {
    renderWithRoutes('/secret');
    expect(screen.getByText('LOGIN PAGE')).toBeInTheDocument();
    expect(screen.queryByText('SECRET CONTENT')).not.toBeInTheDocument();
  });

  it('renders the protected content when logged in and no role check', () => {
    useAuthStore.setState({
      accessToken: 'tok',
      user: { id: 'u1', username: 'u', role: 'cashier' } as any,
    });
    renderWithRoutes('/secret');
    expect(screen.getByText('SECRET CONTENT')).toBeInTheDocument();
  });

  it('redirects to / when the user lacks the required role', () => {
    useAuthStore.setState({
      accessToken: 'tok',
      user: { id: 'u1', username: 'u', role: 'cashier' } as any,
    });
    renderWithRoutes('/secret', ['admin']);
    expect(screen.getByText('HOME PAGE')).toBeInTheDocument();
    expect(screen.queryByText('SECRET CONTENT')).not.toBeInTheDocument();
  });

  it('renders content when user has one of the required roles', () => {
    useAuthStore.setState({
      accessToken: 'tok',
      user: { id: 'u1', username: 'u', role: 'manager' } as any,
    });
    renderWithRoutes('/secret', ['admin', 'manager']);
    expect(screen.getByText('SECRET CONTENT')).toBeInTheDocument();
  });
});
