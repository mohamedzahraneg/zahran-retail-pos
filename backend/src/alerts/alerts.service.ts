import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CreateAlertDto, AlertSeverity } from './dto/alert.dto';
import { RealtimeGateway } from '../realtime/realtime.gateway';

@Injectable()
export class AlertsService {
  constructor(
    private readonly ds: DataSource,
    @Optional() private readonly realtime?: RealtimeGateway,
  ) {}

  async create(dto: CreateAlertDto) {
    const [row] = await this.ds.query(
      `
      INSERT INTO alerts
        (alert_type, severity, title, message, entity, entity_id,
         target_user_id, target_role_id, metadata)
      VALUES ($1,$2,$3,$4,$5::entity_type,$6,$7,$8,$9)
      RETURNING *
      `,
      [
        dto.alert_type,
        dto.severity ?? AlertSeverity.info,
        dto.title,
        dto.message ?? null,
        dto.entity ?? null,
        dto.entity_id ?? null,
        dto.target_user_id ?? null,
        dto.target_role_id ?? null,
        JSON.stringify(dto.metadata ?? {}),
      ],
    );
    // Broadcast via WebSocket if available
    this.realtime?.emitAlert(row);
    return row;
  }

  list(filters: {
    userId?: string;
    unreadOnly?: boolean;
    unresolvedOnly?: boolean;
    severity?: string;
    type?: string;
    limit?: number;
  }) {
    const conds: string[] = [];
    const ps: any[] = [];

    if (filters.userId) {
      ps.push(filters.userId);
      conds.push(
        `(a.target_user_id = $${ps.length} OR a.target_user_id IS NULL)`,
      );
    }
    if (filters.unreadOnly) conds.push(`a.is_read = FALSE`);
    if (filters.unresolvedOnly) conds.push(`a.is_resolved = FALSE`);
    if (filters.severity) {
      ps.push(filters.severity);
      conds.push(`a.severity = $${ps.length}::alert_severity`);
    }
    if (filters.type) {
      ps.push(filters.type);
      conds.push(`a.alert_type = $${ps.length}::alert_type`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    ps.push(filters.limit ?? 100);

    return this.ds.query(
      `
      SELECT a.*,
        u.full_name AS resolved_by_name
      FROM alerts a
      LEFT JOIN users u ON u.id = a.resolved_by
      ${where}
      ORDER BY
        CASE a.severity WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END DESC,
        a.created_at DESC
      LIMIT $${ps.length}
      `,
      ps,
    );
  }

  async counts(userId?: string) {
    const params: any[] = [];
    let cond = '';
    if (userId) {
      params.push(userId);
      cond = `WHERE target_user_id = $1 OR target_user_id IS NULL`;
    }
    const [row] = await this.ds.query(
      `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE is_read = FALSE)::int AS unread,
        COUNT(*) FILTER (WHERE is_resolved = FALSE)::int AS unresolved,
        COUNT(*) FILTER (WHERE severity = 'critical' AND is_resolved = FALSE)::int AS critical,
        COUNT(*) FILTER (WHERE severity = 'warning' AND is_resolved = FALSE)::int AS warning
      FROM alerts
      ${cond}
      `,
      params,
    );
    return row;
  }

  async markRead(id: number) {
    const [row] = await this.ds.query(
      `UPDATE alerts SET is_read = TRUE WHERE id = $1 RETURNING *`,
      [id],
    );
    if (!row) throw new NotFoundException('التنبيه غير موجود');
    return row;
  }

  async markAllRead(userId?: string) {
    const params: any[] = [];
    let cond = 'WHERE is_read = FALSE';
    if (userId) {
      params.push(userId);
      cond += ` AND (target_user_id = $1 OR target_user_id IS NULL)`;
    }
    const res = await this.ds.query(
      `UPDATE alerts SET is_read = TRUE ${cond} RETURNING id`,
      params,
    );
    return { updated: res.length };
  }

  async resolve(id: number, userId: string) {
    const [row] = await this.ds.query(
      `
      UPDATE alerts SET
        is_resolved = TRUE,
        resolved_by = $1,
        resolved_at = NOW(),
        is_read = TRUE
      WHERE id = $2
      RETURNING *
      `,
      [userId, id],
    );
    if (!row) throw new NotFoundException('التنبيه غير موجود');
    return row;
  }

  /**
   * Run all alert generators (low stock, out of stock, expiring reservations, etc.)
   * Typically called by a scheduled job every few minutes.
   */
  async runScan() {
    const created: any[] = [];

    // 1) Low stock — view v_dashboard_low_stock
    const lowStock = await this.ds.query(
      `SELECT * FROM v_dashboard_low_stock LIMIT 200`,
    );
    for (const r of lowStock) {
      // Don't duplicate — only create if no unresolved low_stock alert for this variant
      const [existing] = await this.ds.query(
        `SELECT id FROM alerts
         WHERE alert_type = 'low_stock' AND entity_id = $1 AND is_resolved = FALSE`,
        [r.variant_id],
      );
      if (!existing) {
        const row = await this.create({
          alert_type: 'low_stock' as any,
          severity: (r.quantity <= 0 ? 'critical' : 'warning') as any,
          title: `رصيد منخفض: ${r.product_name ?? 'صنف'}`,
          message: `المتاح ${r.quantity}، الحد الأدنى ${r.reorder_point ?? 0}`,
          entity: 'variant',
          entity_id: r.variant_id,
          metadata: r,
        });
        created.push(row);
      }
    }

    // 2) Expiring reservations — next 24h
    const expiring = await this.ds.query(
      `SELECT r.id, r.reservation_no, r.expires_at, c.full_name AS customer_name
       FROM reservations r
       LEFT JOIN customers c ON c.id = r.customer_id
       WHERE r.status = 'active'
         AND r.expires_at BETWEEN NOW() AND NOW() + INTERVAL '24 hours'
       LIMIT 100`,
    );
    for (const r of expiring) {
      const [existing] = await this.ds.query(
        `SELECT id FROM alerts
         WHERE alert_type = 'reservation_expiring' AND entity_id = $1
           AND is_resolved = FALSE`,
        [r.id],
      );
      if (!existing) {
        const row = await this.create({
          alert_type: 'reservation_expiring' as any,
          severity: 'warning' as any,
          title: `حجز ينتهي قريباً: ${r.reservation_no}`,
          message: `${r.customer_name || 'عميل'} - ${new Date(r.expires_at).toLocaleString('ar-EG')}`,
          entity: 'reservation',
          entity_id: r.id,
        });
        created.push(row);
      }
    }

    // 3) Cash mismatch — shift closed with |difference| > 5
    const mismatches = await this.ds.query(
      `SELECT id, shift_no, difference, closed_at
       FROM shifts
       WHERE status = 'closed' AND ABS(difference) > 5
         AND closed_at >= NOW() - INTERVAL '1 day'
       LIMIT 50`,
    );
    for (const r of mismatches) {
      const [existing] = await this.ds.query(
        `SELECT id FROM alerts
         WHERE alert_type = 'cash_mismatch' AND entity_id = $1`,
        [r.id],
      );
      if (!existing) {
        const row = await this.create({
          alert_type: 'cash_mismatch' as any,
          severity: (Math.abs(Number(r.difference)) > 100 ? 'critical' : 'warning') as any,
          title: `فرق خزينة: ${r.shift_no}`,
          message: `فرق ${Number(r.difference).toFixed(2)} ج.م`,
          entity: 'shift',
          entity_id: r.id,
        });
        created.push(row);
      }
    }

    return { created: created.length, alerts: created };
  }
}
