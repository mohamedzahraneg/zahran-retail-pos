import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { RecurringExpensesService } from './recurring-expenses.service';

/**
 * Daily scheduler for recurring expenses.
 *
 * Runs once a day at 08:00 Cairo time:
 *   1. Auto-posts every due template flagged `auto_post = true` so cash
 *      movements land in the ledger without a manual click.
 *   2. Emits an alert for every template that falls due within the
 *      template's `notify_days_before` window — lets an admin approve
 *      it before the cash goes out.
 *   3. Emits a critical alert for any template whose next_run_date is
 *      in the past and hasn't been posted yet (missed / overdue).
 *
 * The job is idempotent — alerts for the same template on the same day
 * are upserted, and auto-post advances `next_run_date` itself.
 */
@Injectable()
export class RecurringExpensesScheduler {
  private readonly logger = new Logger('RecurringExpensesScheduler');

  constructor(
    private readonly ds: DataSource,
    private readonly svc: RecurringExpensesService,
  ) {}

  /** 08:00 Cairo every day. Cron evaluated in the container's TZ. */
  @Cron(CronExpression.EVERY_DAY_AT_8AM, { timeZone: 'Africa/Cairo' })
  async dailyTick() {
    this.logger.log('daily tick — processing recurring expenses');
    try {
      await this.autoPostDue();
    } catch (err: any) {
      this.logger.error(`autoPostDue failed: ${err?.message ?? err}`);
    }
    try {
      await this.emitUpcomingAlerts();
    } catch (err: any) {
      this.logger.error(`emitUpcomingAlerts failed: ${err?.message ?? err}`);
    }
    try {
      await this.emitOverdueAlerts();
    } catch (err: any) {
      this.logger.error(`emitOverdueAlerts failed: ${err?.message ?? err}`);
    }
  }

  /** Auto-post every template marked auto_post=true that is due today. */
  private async autoPostDue() {
    // The scheduler is a "system" actor — we need a user id to attribute
    // the generated expense. Pick any admin; if none exists, skip.
    const [sysUser] = await this.ds.query(`
      SELECT id FROM users
       WHERE is_active = TRUE
       ORDER BY created_at ASC
       LIMIT 1
    `);
    if (!sysUser?.id) {
      this.logger.warn('no system user found — skipping auto-post');
      return;
    }
    const due = await this.ds.query(`
      SELECT id, name_ar, amount
        FROM recurring_expenses
       WHERE status = 'active'
         AND auto_post = TRUE
         AND next_run_date <= (now() AT TIME ZONE 'Africa/Cairo')::date
         AND (end_date IS NULL OR end_date >= CURRENT_DATE)
       ORDER BY next_run_date ASC
       LIMIT 100
    `);
    if (!due.length) return;
    let ok = 0;
    for (const row of due) {
      try {
        const r = await this.svc.runOne(row.id, sysUser.id);
        if (r.generated) ok++;
      } catch (err: any) {
        this.logger.error(
          `auto-post failed for ${row.name_ar}: ${err?.message ?? err}`,
        );
      }
    }
    this.logger.log(`auto-posted ${ok}/${due.length} due templates`);
  }

  /** Insert (upsert) info alerts for templates due in the notice window. */
  private async emitUpcomingAlerts() {
    const rows = await this.ds.query(`
      SELECT re.id, re.name_ar, re.amount, re.next_run_date,
             COALESCE(re.notify_days_before, 3) AS days_before
        FROM recurring_expenses re
       WHERE re.status = 'active'
         AND re.next_run_date > (now() AT TIME ZONE 'Africa/Cairo')::date
         AND re.next_run_date <= (now() AT TIME ZONE 'Africa/Cairo')::date
                                 + MAKE_INTERVAL(days => COALESCE(re.notify_days_before, 3))
    `);
    for (const r of rows) {
      await this.upsertAlert({
        alertType: 'recurring_expense_upcoming',
        severity: 'info',
        title: `مصروف دوري قادم: ${r.name_ar}`,
        message: `${r.name_ar} بقيمة ${Number(r.amount).toLocaleString(
          'en-US',
        )} ج.م مستحق في ${r.next_run_date}`,
        entityId: r.id,
      });
    }
    this.logger.log(`upcoming alerts: ${rows.length}`);
  }

  /** Critical alerts for any overdue active template. */
  private async emitOverdueAlerts() {
    const rows = await this.ds.query(`
      SELECT id, name_ar, amount, next_run_date
        FROM recurring_expenses
       WHERE status = 'active'
         AND auto_post = FALSE
         AND next_run_date < (now() AT TIME ZONE 'Africa/Cairo')::date
    `);
    for (const r of rows) {
      await this.upsertAlert({
        alertType: 'recurring_expense_due',
        severity: 'warning',
        title: `مصروف دوري متأخر: ${r.name_ar}`,
        message: `مستحق منذ ${r.next_run_date} بقيمة ${Number(
          r.amount,
        ).toLocaleString('en-US')} ج.م`,
        entityId: r.id,
      });
    }
    this.logger.log(`overdue alerts: ${rows.length}`);
  }

  /** One alert per template per day — skip if an unresolved one already exists. */
  private async upsertAlert(a: {
    alertType: string;
    severity: 'info' | 'warning' | 'critical';
    title: string;
    message: string;
    entityId: string;
  }) {
    const [existing] = await this.ds.query(
      `SELECT id FROM alerts
        WHERE alert_type::text = $1
          AND entity_id = $2
          AND is_resolved = FALSE
          AND (created_at AT TIME ZONE 'Africa/Cairo')::date
              = (now() AT TIME ZONE 'Africa/Cairo')::date
        LIMIT 1`,
      [a.alertType, a.entityId],
    );
    if (existing) return;
    await this.ds.query(
      `INSERT INTO alerts
         (alert_type, severity, title, message, entity, entity_id, metadata)
       VALUES ($1::alert_type, $2::alert_severity, $3, $4,
               'recurring_expense'::entity_type, $5, '{}'::jsonb)`,
      [a.alertType, a.severity, a.title, a.message, a.entityId],
    );
  }
}
