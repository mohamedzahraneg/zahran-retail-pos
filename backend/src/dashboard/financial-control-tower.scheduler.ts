import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { FinancialHealthService } from './financial-health.service';
import { CostReconciliationService } from '../accounting/cost-reconciliation.service';

/**
 * Self-running heartbeat for the Financial Control Tower.
 *
 * Two cron jobs:
 *   * `scanAnomalies` — every 5 minutes. Runs a 24h anomaly sweep
 *     and inserts new rows into `financial_anomalies` (idempotent
 *     on `(type, entity, reference, resolved=FALSE)`, so repeated
 *     runs never duplicate an open issue).
 *
 *   * `runReconciliation` — every day at 02:10 Cairo time. Writes one
 *     row to `cost_reconciliation_reports` for the previous day with
 *     the engine/legacy split, duplicate/orphan counts, and the
 *     mapping snapshot. Append-only.
 *
 * Both services are injected as @Optional() so the backend still
 * boots when the control-tower module is stubbed out in tests.
 * Every run is wrapped in try/catch — a scheduled job must never
 * crash the Nest application.
 */
@Injectable()
export class FinancialControlTowerScheduler {
  private readonly logger = new Logger('FinancialControlTowerScheduler');

  constructor(
    @Optional() private readonly health?: FinancialHealthService,
    @Optional() private readonly reconciliation?: CostReconciliationService,
  ) {}

  /**
   * Every 5 minutes — run the anomaly scan. On-demand scans are still
   * exposed via `POST /dashboard/financial/anomalies/scan`, but the
   * cron guarantees the dashboard stays live without operator input.
   */
  @Cron(CronExpression.EVERY_5_MINUTES, { timeZone: 'Africa/Cairo' })
  async scanAnomalies() {
    if (!this.health) return;
    try {
      const res = await this.health.scan(24);
      // Only log at info level when something actually changed —
      // keeps the log usefully quiet in steady state.
      if ((res as any).inserted > 0) {
        this.logger.log(
          `anomaly scan: ${JSON.stringify(res)}`,
        );
      } else {
        this.logger.debug(`anomaly scan: no new anomalies (${JSON.stringify(res)})`);
      }
    } catch (err: any) {
      this.logger.error(
        `anomaly scan failed: ${err?.message ?? err}`,
      );
    }
  }

  /**
   * Daily at 02:10 Africa/Cairo — reconcile yesterday's expenses. We
   * pick 02:10 (not midnight) so the previous day's late-night POS
   * traffic has fully settled before we snapshot.
   */
  @Cron('10 2 * * *', { timeZone: 'Africa/Cairo' })
  async runReconciliation() {
    if (!this.reconciliation) return;
    try {
      // Yesterday in Cairo time.
      const yesterday = new Date(Date.now() - 24 * 3600 * 1000)
        .toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
      const report = await this.reconciliation.run({
        reportDate: yesterday,
        runType: 'daily',
      });
      this.logger.log(
        `daily recon for ${yesterday}: report_id=${(report as any).id} ` +
        `engine=${(report as any).total_expense_engine} ` +
        `legacy=${(report as any).total_expense_legacy} ` +
        `duplicates=${(report as any).duplicate_detected_count} ` +
        `orphans=${(report as any).orphan_count}`,
      );
    } catch (err: any) {
      this.logger.error(
        `daily reconciliation failed: ${err?.message ?? err}`,
      );
    }
  }
}
