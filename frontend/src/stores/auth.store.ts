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
  hasPermission: (...permissions: string[]) => boolean;
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
        // Fire-and-forget server-side audit record; we clear client state immediately
        // regardless of whether the request succeeds (offline, expired token, etc.).
        authApi.logout().catch(() => {});
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

      // Returns true when the user has EVERY permission in the list.
      // Supports wildcards: "*" passes any check; "area.*" matches "area.x".
      hasPermission: (...permissions) => {
        if (permissions.length === 0) return true;
        const userPerms = get().user?.permissions || [];
        if (userPerms.includes('*')) return true;
        const check = (code: string) => {
          if (userPerms.includes(code)) return true;
          const area = code.split('.')[0];
          return userPerms.includes(`${area}.*`);
        };
        return permissions.every(check);
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
