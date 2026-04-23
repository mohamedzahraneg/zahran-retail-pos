import { api, unwrap } from './client';

export interface FinancialHealth {
  health_score: number;
  classification: 'EXCELLENT' | 'GOOD' | 'WARNING' | 'CRITICAL';
  engine_coverage: {
    pct_24h: number;
    engine_events_24h: number;
    legacy_events_24h: number;
    total_events_24h: number;
    total_events_7d: number;
  };
  legacy_activity: {
    rate_24h_pct: number;
    bypass_alerts_24h: number;
  };
  journal_integrity: {
    unbalanced_entries_24h: number;
  };
  drift_status: {
    total_cashbox_drift: number;
    tolerable: boolean;
  };
  anomalies: {
    open_total: number;
    critical: number;
    high: number;
  };
  penalties: {
    legacy: number;
    drift: number;
    anomaly: number;
    unbalanced: number;
  };
  snapshot_at: string;
}

export interface FinancialEvent {
  event_id: number;
  event_type: string;
  source_service: string | null;
  reference_type: string | null;
  reference_id: string | null;
  amount: string | number | null;
  debit_total: string | number | null;
  credit_total: string | number | null;
  is_engine: boolean;
  is_legacy: boolean;
  session_user_name: string | null;
  meta: Record<string, any>;
  created_at: string;
}

export interface FinancialAnomaly {
  anomaly_id: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  anomaly_type: string;
  description: string;
  affected_entity: string | null;
  reference_id: string | null;
  details: Record<string, any>;
  detected_at: string;
  resolved: boolean;
  resolved_at: string | null;
}

export interface AnomaliesResponse {
  total_open: number;
  by_severity: {
    critical: FinancialAnomaly[];
    high: FinancialAnomaly[];
    medium: FinancialAnomaly[];
    low: FinancialAnomaly[];
  };
}

export interface MigrationStatus {
  by_reference_type: Array<{
    reference_type: string;
    total_7d: number;
    engine_count: number;
    legacy_count: number;
    engine_pct: number;
    migrated: boolean;
    phase: string;
    method: string;
  }>;
  phases: Record<string, { label: string; complete: boolean }>;
  overall_engine_coverage_7d: number;
}

export interface ReconciliationReport {
  id: number;
  report_date: string;
  run_type: string;
  total_expenses_count: number;
  total_expense_engine: string | number;
  total_expense_legacy: string | number;
  mismatch_amount: string | number;
  duplicate_detected_count: number;
  orphan_count: number;
  unlinked_category_count: number;
  created_at: string;
}

export const financialDashboardApi = {
  health: () =>
    unwrap<FinancialHealth>(api.get('/dashboard/financial/health')),

  liveStream: (limit = 50) =>
    unwrap<FinancialEvent[]>(
      api.get('/dashboard/financial/live-stream', { params: { limit } }),
    ),

  anomalies: () =>
    unwrap<AnomaliesResponse>(api.get('/dashboard/financial/anomalies')),

  migrationStatus: () =>
    unwrap<MigrationStatus>(api.get('/dashboard/financial/migration-status')),

  scan: (hours = 24) =>
    unwrap<{ scanned_hours: number; inserted: number; skipped_existing: number }>(
      api.post('/dashboard/financial/anomalies/scan', null, { params: { hours } }),
    ),

  resolve: (id: number, note?: string) =>
    unwrap<FinancialAnomaly>(
      api.patch(`/dashboard/financial/anomalies/${id}/resolve`, { note }),
    ),

  recentReconciliation: (limit = 5) =>
    unwrap<ReconciliationReport[]>(
      api.get('/accounting/cost/reconcile/history', { params: { limit } }),
    ),
};
