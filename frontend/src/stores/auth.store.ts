import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { authApi, LoginResponse } from '@/api/auth.api';

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  user: LoginResponse['user'] | null;
  isHydrated: boolean;

  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<string>;
  hasRole: (...roles: string[]) => boolean;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      isHydrated: false,

      login: async (username, password) => {
        const res = await authApi.login(username, password);
        set({
          accessToken: res.access_token,
          refreshToken: res.refresh_token,
          user: res.user,
        });
      },

      logout: () => {
        set({ accessToken: null, refreshToken: null, user: null });
      },

      refresh: async () => {
        const { refreshToken } = get();
        if (!refreshToken) throw new Error('No refresh token');
        const res = await authApi.refresh(refreshToken);
        set({ accessToken: res.access_token });
        return res.access_token;
      },

      hasRole: (...roles) => {
        const role = get().user?.role;
        return !!role && roles.includes(role);
      },
    }),
    {
      name: 'zahran-auth',
      onRehydrateStorage: () => (state) => {
        if (state) state.isHydrated = true;
      },
    },
  ),
);
