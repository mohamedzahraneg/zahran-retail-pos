import { api, unwrap } from './client';

export interface User {
  id: string;
  username: string;
  full_name?: string;
  email?: string;
  phone?: string;
  role_id?: string;
  branch_id?: string;
  is_active: boolean;
  last_login_at?: string;
  created_at: string;
  extra_permissions?: string[];
  denied_permissions?: string[];
}

export interface Role {
  id: string;
  code: string;
  name_ar: string;
  name_en?: string;
  is_system?: boolean;
  description?: string;
}

export interface CreateUserPayload {
  username: string;
  password: string;
  full_name?: string;
  email?: string;
  phone?: string;
  role_id?: string;
  branch_id?: string;
}

export interface UpdateUserPayload {
  full_name?: string;
  email?: string;
  phone?: string;
  role_id?: string;
  branch_id?: string;
}

export const usersApi = {
  list: () => unwrap<User[]>(api.get('/users')),

  get: (id: string) => unwrap<User>(api.get(`/users/${id}`)),

  create: (payload: CreateUserPayload) =>
    unwrap<User>(api.post('/users', payload)),

  update: (id: string, payload: UpdateUserPayload) =>
    unwrap<User>(api.patch(`/users/${id}`, payload)),

  changePassword: (id: string, new_password: string) =>
    unwrap<{ message: string }>(
      api.patch(`/users/${id}/password`, { new_password }),
    ),

  deactivate: (id: string) =>
    unwrap<{ deactivated: true }>(api.patch(`/users/${id}/deactivate`, {})),

  activate: (id: string) =>
    unwrap<{ activated: true }>(api.patch(`/users/${id}/activate`, {})),

  roles: () => unwrap<Role[]>(api.get('/users/meta/roles')),

  setPermissions: (
    id: string,
    body: { extra_permissions: string[]; denied_permissions: string[] },
  ) => unwrap<User>(api.patch(`/users/${id}/permissions`, body)),
};
