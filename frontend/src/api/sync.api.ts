import { api, unwrap } from './client';

export type SyncEntity =
  | 'invoice'
  | 'return'
  | 'reservation'
  | 'customer'
  | 'cash_movement';

export interface SyncOperation {
  offline_id: string;
  entity: SyncEntity;
  operation: 'I' | 'U' | 'D';
  payload: Record<string, any>;
  client_created_at: string;
}

export interface SyncOperationResult {
  offline_id: string;
  entity: SyncEntity;
  state: 'synced' | 'duplicate' | 'conflict' | 'failed';
  server_id?: string | null;
  result?: any;
  conflict_reason?: string | null;
  error?: string;
}

export interface PushSyncResponse {
  client_id: string;
  processed: number;
  synced: number;
  duplicates: number;
  conflicts: number;
  failed: number;
  results: SyncOperationResult[];
}

export interface PullSyncResponse {
  since: string;
  server_time: string;
  user_id: string;
  client_id: string | null;
  data: {
    invoices?: any[];
    returns?: any[];
    reservations?: any[];
    customers?: any[];
  };
}

export interface SyncStatus {
  total: number;
  pending: number;
  synced: number;
  conflicts: number;
  failed: number;
  last_synced_at: string | null;
}

export const syncApi = {
  push: (client_id: string, operations: SyncOperation[]) =>
    unwrap<PushSyncResponse>(
      api.post('/sync/push', { client_id, operations }),
    ),

  pull: (params: {
    since?: string;
    client_id?: string;
    entities?: SyncEntity[];
  }) => unwrap<PullSyncResponse>(api.post('/sync/pull', params)),

  status: (client_id: string) =>
    unwrap<SyncStatus>(api.get('/sync/status', { params: { client_id } })),
};
