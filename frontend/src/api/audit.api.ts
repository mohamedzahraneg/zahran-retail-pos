import { api, unwrap } from './client';

export interface ActivityLog {
  id: string;
  user_id: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  summary: string | null;
  metadata: Record<string, any> | null;
  ip_address: string | null;
  created_at: string;
  username?: string | null;
  full_name?: string | null;
}

export interface ChangeLog {
  id: string;
  table_name: string;
  record_id: string;
  operation: 'I' | 'U' | 'D';
  changed_by: string | null;
  old_data: any;
  new_data: any;
  changed_at: string;
  username?: string | null;
  full_name?: string | null;
}

export interface AuditStats {
  activity_count: number;
  audit_count: number;
  top_users: { user_id: string; username: string; full_name: string; events: number }[];
  top_actions: { action: string; events: number }[];
}

export const auditApi = {
  activity: (params?: {
    user_id?: string;
    action?: string;
    entity?: string;
    entity_id?: string;
    from?: string;
    to?: string;
    limit?: number;
  }) => unwrap<ActivityLog[]>(api.get('/audit/activity', { params })),

  changes: (params?: {
    table_name?: string;
    record_id?: string;
    operation?: 'I' | 'U' | 'D';
    changed_by?: string;
    from?: string;
    to?: string;
    limit?: number;
  }) => unwrap<ChangeLog[]>(api.get('/audit/changes', { params })),

  stats: (from?: string, to?: string) =>
    unwrap<AuditStats>(api.get('/audit/stats', { params: { from, to } })),
};
