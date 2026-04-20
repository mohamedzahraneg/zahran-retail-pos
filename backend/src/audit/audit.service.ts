import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Audit / Activity log query service.
 *
 * Reads from two tables:
 *   - activity_logs: high-level user-facing events
 *   - audit_logs:    low-level DB-change rows (populated by triggers)
 */
@Injectable()
export class AuditService {
  constructor(private readonly ds: DataSource) {}

  async listActivity(params: {
    user_id?: string;
    action?: string;
    entity?: string;
    entity_id?: string;
    from?: string;
    to?: string;
    limit?: number;
  }) {
    const where: string[] = ['1=1'];
    const args: any[] = [];
    if (params.user_id) {
      args.push(params.user_id);
      where.push(`a.user_id = $${args.length}`);
    }
    if (params.action) {
      args.push(params.action);
      where.push(`a.action = $${args.length}::activity_action`);
    }
    if (params.entity) {
      args.push(params.entity);
      where.push(`a.entity = $${args.length}::entity_type`);
    }
    if (params.entity_id) {
      args.push(params.entity_id);
      where.push(`a.entity_id = $${args.length}`);
    }
    if (params.from) {
      args.push(params.from);
      where.push(`a.created_at >= $${args.length}::date`);
    }
    if (params.to) {
      args.push(params.to);
      where.push(`a.created_at <= $${args.length}::date + INTERVAL '1 day'`);
    }
    const limit = Math.min(Math.max(Number(params.limit) || 200, 1), 1000);

    return this.ds.query(
      `
      SELECT a.id, a.user_id, a.action, a.entity, a.entity_id,
             a.summary, a.metadata, a.ip_address, a.created_at,
             u.username, u.full_name
        FROM activity_logs a
        LEFT JOIN users u ON u.id = a.user_id
       WHERE ${where.join(' AND ')}
       ORDER BY a.created_at DESC
       LIMIT ${limit}
      `,
      args,
    );
  }

  async listChanges(params: {
    table_name?: string;
    record_id?: string;
    operation?: 'I' | 'U' | 'D';
    changed_by?: string;
    from?: string;
    to?: string;
    limit?: number;
  }) {
    const where: string[] = ['1=1'];
    const args: any[] = [];
    if (params.table_name) {
      args.push(params.table_name);
      where.push(`ad.table_name = $${args.length}`);
    }
    if (params.record_id) {
      args.push(params.record_id);
      where.push(`ad.record_id = $${args.length}`);
    }
    if (params.operation) {
      args.push(params.operation);
      where.push(`ad.operation = $${args.length}`);
    }
    if (params.changed_by) {
      args.push(params.changed_by);
      where.push(`ad.changed_by = $${args.length}`);
    }
    if (params.from) {
      args.push(params.from);
      where.push(`ad.changed_at >= $${args.length}::date`);
    }
    if (params.to) {
      args.push(params.to);
      where.push(`ad.changed_at <= $${args.length}::date + INTERVAL '1 day'`);
    }
    const limit = Math.min(Math.max(Number(params.limit) || 200, 1), 1000);

    return this.ds.query(
      `
      SELECT ad.id, ad.table_name, ad.record_id, ad.operation,
             ad.changed_by, ad.old_data, ad.new_data, ad.changed_at,
             u.username, u.full_name
        FROM audit_logs ad
        LEFT JOIN users u ON u.id = ad.changed_by
       WHERE ${where.join(' AND ')}
       ORDER BY ad.changed_at DESC
       LIMIT ${limit}
      `,
      args,
    );
  }

  /**
   * Summary stats for the dashboard — most-active users and most-changed tables
   */
  async stats(params: { from?: string; to?: string }) {
    // Combined date clause for activity_logs (uses a.created_at) and audit_logs (uses ad.changed_at).
    const actFrom = params.from
      ? `AND a.created_at >= '${params.from}'::date`
      : `AND a.created_at >= NOW() - INTERVAL '30 days'`;
    const actTo = params.to
      ? `AND a.created_at <= '${params.to}'::date + INTERVAL '1 day'`
      : '';
    const audFrom = params.from
      ? `AND ad.changed_at >= '${params.from}'::date`
      : `AND ad.changed_at >= NOW() - INTERVAL '30 days'`;
    const audTo = params.to
      ? `AND ad.changed_at <= '${params.to}'::date + INTERVAL '1 day'`
      : '';

    const [totals] = await this.ds.query(`
      SELECT
        (SELECT COUNT(*) FROM activity_logs a WHERE 1=1 ${actFrom} ${actTo}) AS activity_count,
        (SELECT COUNT(*) FROM audit_logs ad WHERE 1=1 ${audFrom} ${audTo}) AS audit_count
    `);

    /**
     * Top users — union of activity_logs and audit_logs. audit_logs is the
     * reliable source (DB triggers populate it); activity_logs is only written
     * by application-level hooks which aren't wired everywhere.
     */
    const topUsers = await this.ds.query(`
      WITH combined AS (
        SELECT a.user_id FROM activity_logs a
         WHERE a.user_id IS NOT NULL ${actFrom} ${actTo}
        UNION ALL
        SELECT ad.changed_by AS user_id FROM audit_logs ad
         WHERE ad.changed_by IS NOT NULL ${audFrom} ${audTo}
      )
      SELECT c.user_id, u.username, u.full_name, COUNT(*)::int AS events
        FROM combined c
        LEFT JOIN users u ON u.id = c.user_id
       GROUP BY c.user_id, u.username, u.full_name
       ORDER BY events DESC
       LIMIT 10
    `);

    /**
     * Top actions — combine both tables. In activity_logs we have `action`
     * (e.g. "user.login"); in audit_logs we synthesize it as "{op} {table}"
     * (e.g. "تعديل invoices").
     */
    const topActions = await this.ds.query(`
      WITH combined AS (
        SELECT a.action::text AS action FROM activity_logs a
         WHERE a.action IS NOT NULL ${actFrom} ${actTo}
        UNION ALL
        SELECT (
          CASE ad.operation
            WHEN 'I' THEN 'إضافة'
            WHEN 'U' THEN 'تعديل'
            WHEN 'D' THEN 'حذف'
            ELSE ad.operation::text
          END || ' ' || ad.table_name
        )::text AS action
          FROM audit_logs ad
         WHERE 1=1 ${audFrom} ${audTo}
      )
      SELECT c.action, COUNT(*)::int AS events
        FROM combined c
       GROUP BY c.action
       ORDER BY events DESC
       LIMIT 10
    `);

    return {
      activity_count:
        Number(totals.activity_count || 0) + Number(totals.audit_count || 0),
      audit_count: Number(totals.audit_count || 0),
      top_users: topUsers,
      top_actions: topActions,
    };
  }
}
