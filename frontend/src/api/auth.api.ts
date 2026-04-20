import { api, unwrap } from './client';

export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  expires_in: string;
  user: {
    id: string;
    username: string;
    full_name: string;
    email: string;
    role: string;
    role_name: string;
    /**
     * Effective permission codes: role permissions ∪ user.extra_permissions
     * minus user.denied_permissions. A wildcard "*" grants everything.
     */
    permissions: string[];
    branch_id: string;
  };
}

export const authApi = {
  login: (username: string, password: string) =>
    unwrap<LoginResponse>(api.post('/auth/login', { username, password })),

  refresh: (refresh_token: string) =>
    unwrap<{ access_token: string; expires_in: string }>(
      api.post('/auth/refresh', { refresh_token }),
    ),

  me: () => unwrap<any>(api.get('/auth/me')),

  logout: () => unwrap<{ ok: boolean }>(api.post('/auth/logout', {})),
};
