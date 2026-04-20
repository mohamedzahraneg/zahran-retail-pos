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
    const fromClause = params.from
      ? `AND a.created_at >= '${params.from}'::date`
      : `AND a.created_at >= NOW() - INTERVAL '30 days'`;
    const toClause = params.to
      ? `AND a.created_at <= '${params.to}'::date + INTERVAL '1 day'`
      : '';

    const [totals] = await this.ds.query(
      `
      SELECT
        (SELECT COUNT(*) FROM activity_logs a WHERE 1=1 ${fromClause} ${toClause}) AS activity_count,
        (SELECT COUNT(*) FROM audit_logs   ad WHERE 1=1
           ${params.from ? `AND ad.changed_at >= '${params.from}'::date` : `AND ad.changed_at >= NOW() - INTERVAL '30 days'`}
           ${params.to   ? `AND ad.changed_at <= '${params.to}'::date + INTERVAL '1 day'` : ''}) AS audit_count
      `,
    );

    const topUsers = await this.ds.query(
      `
      SELECT a.user_id, u.username, u.full_name, COUNT(*)::int AS events
        FROM activity_logs a
        LEFT JOIN users u ON u.id = a.user_id
       WHERE a.user_id IS NOT NULL ${fromClause} ${toClause}
       GROUP BY a.user_id, u.username, u.full_name
       ORDER BY events DESC
       LIMIT 10
      `,
    );

    const topActions = await this.ds.query(
      `
      SELECT a.action, COUNT(*)::int AS events
        FROM activity_logs a
       WHERE 1=1 ${fromClause} ${toClause}
       GROUP BY a.action
       ORDER BY events DESC
       LIMIT 10
      `,
    );

    return {
      activity_count: Number(totals.activity_count || 0),
      audit_count: Number(totals.audit_count || 0),
      top_users: topUsers,
      top_actions: topActions,
    };
  }
}
