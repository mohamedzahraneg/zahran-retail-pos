import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Auth store tests — we mock out authApi so we never hit a network.
 */
const loginMock = vi.fn();
const refreshMock = vi.fn();

vi.mock('@/api/auth.api', () => ({
  authApi: {
    login: (...args: any[]) => loginMock(...args),
    refresh: (...args: any[]) => refreshMock(...args),
  },
}));

// localStorage shim for zustand persist middleware
const lsStore: Record<string, string> = {};
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => lsStore[k] ?? null,
    setItem: (k: string, v: string) => {
      lsStore[k] = v;
    },
    removeItem: (k: string) => {
      delete lsStore[k];
    },
    clear: () => {
      for (const k of Object.keys(lsStore)) delete lsStore[k];
    },
  },
  configurable: true,
});

import { useAuthStore } from '../auth.store';

const resetAuth = () =>
  useAuthStore.setState({
    accessToken: null,
    refreshToken: null,
    user: null,
  });

describe('auth.store', () => {
  beforeEach(() => {
    loginMock.mockReset();
    refreshMock.mockReset();
    resetAuth();
  });

  it('login() stores tokens and user on success', async () => {
    loginMock.mockResolvedValue({
      access_token: 'at-1',
      refresh_token: 'rt-1',
      user: { id: 'u1', username: 'admin', role: 'admin' },
    });

    await useAuthStore.getState().login('admin', 'secret');

    expect(loginMock).toHaveBeenCalledWith('admin', 'secret');
    const s = useAuthStore.getState();
    expect(s.accessToken).toBe('at-1');
    expect(s.refreshToken).toBe('rt-1');
    expect(s.user?.username).toBe('admin');
  });

  it('logout() clears all tokens and user', () => {
    useAuthStore.setState({
      accessToken: 'x',
      refreshToken: 'y',
      user: { id: 'u1', username: 'u', role: 'cashier' } as any,
    });

    useAuthStore.getState().logout();

    const s = useAuthStore.getState();
    expect(s.accessToken).toBeNull();
    expect(s.refreshToken).toBeNull();
    expect(s.user).toBeNull();
  });

  it('refresh() throws when there is no refresh token', async () => {
    resetAuth();
    await expect(useAuthStore.getState().refresh()).rejects.toThrow(
      /No refresh token/,
    );
  });

  it('refresh() updates the access token on success', async () => {
    useAuthStore.setState({ refreshToken: 'rt-current' });
    refreshMock.mockResolvedValue({ access_token: 'at-new' });

    const newToken = await useAuthStore.getState().refresh();

    expect(refreshMock).toHaveBeenCalledWith('rt-current');
    expect(newToken).toBe('at-new');
    expect(useAuthStore.getState().accessToken).toBe('at-new');
  });

  it('hasRole() returns false when there is no user', () => {
    resetAuth();
    expect(useAuthStore.getState().hasRole('admin')).toBe(false);
  });

  it('hasRole() matches against the user role', () => {
    useAuthStore.setState({
      user: { id: 'u1', username: 'u', role: 'manager' } as any,
    });

    expect(useAuthStore.getState().hasRole('admin')).toBe(false);
    expect(useAuthStore.getState().hasRole('admin', 'manager')).toBe(true);
    expect(useAuthStore.getState().hasRole('manager')).toBe(true);
  });
});
