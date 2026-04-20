import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Customer loyalty points service.
 *
 * Settings driving the math (settings.key = 'loyalty.rate'):
 *   { "points_per_egp": 0.1, "egp_per_point": 0.05 }
 *
 *   - points_per_egp → how many points a customer earns per 1 EGP spent
 *     (used by the existing accrual trigger on invoice completion)
 *   - egp_per_point  → redemption value of each point in EGP
 *
 * Redemption rules:
 *   - minimum redeem = 100 points
 *   - cannot redeem more points than the customer currently has
 *   - redeemed value cannot exceed invoice subtotal (90% cap)
 */
@Injectable()
export class LoyaltyService {
  constructor(private readonly ds: DataSource) {}

  async getConfig() {
    const [row] = await this.ds.query(
      `SELECT value FROM settings WHERE key = 'loyalty.rate'`,
    );
    const v = row?.value ?? {};
    return {
      points_per_egp: Number(v.points_per_egp ?? 0.1),
      egp_per_point: Number(v.egp_per_point ?? 0.05),
      min_redeem: Number(v.min_redeem ?? 100),
      max_redeem_ratio: Number(v.max_redeem_ratio ?? 0.9),
    };
  }

  async getCustomerBalance(customerId: string) {
    const [row] = await this.ds.query(
      `SELECT id, full_name, phone, loyalty_points, loyalty_tier
         FROM customers WHERE id = $1 AND is_active = true`,
      [customerId],
    );
    if (!row) throw new NotFoundException(`Customer ${customerId} not found`);
    const config = await this.getConfig();
    return {
      ...row,
      config,
      redeemable_egp: Number(row.loyalty_points) * config.egp_per_point,
    };
  }

  /**
   * Preview how many EGP `points` would translate to without actually redeeming.
   */
  async preview(customerId: string, points: number, subtotal: number) {
    const config = await this.getConfig();
    if (points < config.min_redeem) {
      throw new BadRequestException(
        `الحد الأدنى للاستبدال ${config.min_redeem} نقطة`,
      );
    }
    const [row] = await this.ds.query(
      `SELECT loyalty_points FROM customers WHERE id = $1`,
      [customerId],
    );
    if (!row) throw new NotFoundException('Customer not found');
    if (points > Number(row.loyalty_points)) {
      throw new BadRequestException('الرصيد من النقاط غير كافٍ');
    }
    const maxEgp = subtotal * config.max_redeem_ratio;
    const rawEgp = points * config.egp_per_point;
    const applied_egp = Math.min(rawEgp, maxEgp);
    const applied_points =
      applied_egp >= rawEgp
        ? points
        : Math.floor(applied_egp / config.egp_per_point);
    return {
      requested_points: points,
      applied_points,
      applied_egp: Number(applied_egp.toFixed(2)),
      config,
    };
  }

  /**
   * Deduct points from the customer and write a negative ledger row.
   *
   * Called from POS checkout after the invoice is created, inside the same
   * DB transaction (receives `em` from the caller).
   */
  async redeem(
    em: any,
    params: {
      customer_id: string;
      points: number;
      invoice_id: string;
      user_id: string;
    },
  ) {
    const [cust] = await em.query(
      `SELECT loyalty_points FROM customers WHERE id = $1 FOR UPDATE`,
      [params.customer_id],
    );
    if (!cust) throw new NotFoundException('Customer not found');
    if (params.points > Number(cust.loyalty_points)) {
      throw new BadRequestException('الرصيد من النقاط غير كافٍ');
    }

    await em.query(
      `UPDATE customers
          SET loyalty_points = loyalty_points - $1,
              updated_at = NOW()
        WHERE id = $2`,
      [params.points, params.customer_id],
    );

    await em.query(
      `
      INSERT INTO customer_loyalty_transactions
        (customer_id, direction, points, reason, reference_type, reference_id, user_id)
      VALUES ($1, 'out', $2, 'redeem', 'invoice', $3, $4)
      `,
      [params.customer_id, params.points, params.invoice_id, params.user_id],
    );

    return { redeemed: params.points };
  }

  /**
   * Admin: list all customers with their loyalty balances. Lightweight
   * paginated view for the loyalty dashboard.
   */
  async listCustomers(params: { q?: string; limit?: number; tier?: string }) {
    const where: string[] = ['c.is_active = true'];
    const args: any[] = [];
    if (params.q) {
      args.push(`%${params.q}%`);
      where.push(
        `(c.full_name ILIKE $${args.length} OR c.phone ILIKE $${args.length})`,
      );
    }
    if (params.tier) {
      args.push(params.tier);
      where.push(`c.loyalty_tier = $${args.length}`);
    }
    const limit = Math.min(Math.max(Number(params.limit) || 200, 1), 500);
    const config = await this.getConfig();
    const rows = await this.ds.query(
      `SELECT c.id, c.full_name, c.phone, c.loyalty_points, c.loyalty_tier,
              c.total_spent, c.last_visit_at, c.visits_count
         FROM customers c
        WHERE ${where.join(' AND ')}
        ORDER BY c.loyalty_points DESC NULLS LAST
        LIMIT ${limit}`,
      args,
    );
    return rows.map((r: any) => ({
      ...r,
      loyalty_points: Number(r.loyalty_points || 0),
      redeemable_egp: Number(r.loyalty_points || 0) * config.egp_per_point,
    }));
  }

  /** Admin: manually add or subtract points for a customer (audited). */
  async adjust(
    customerId: string,
    body: { delta: number; reason?: string; user_id: string },
  ) {
    if (!Number.isFinite(body.delta) || body.delta === 0) {
      throw new BadRequestException('delta يجب أن يكون رقمًا غير صفري');
    }
    const [cust] = await this.ds.query(
      `SELECT loyalty_points FROM customers WHERE id = $1 FOR UPDATE`,
      [customerId],
    );
    if (!cust) throw new NotFoundException('Customer not found');
    const current = Number(cust.loyalty_points);
    if (body.delta < 0 && Math.abs(body.delta) > current) {
      throw new BadRequestException('الرصيد من النقاط غير كافٍ للخصم');
    }
    return this.ds.transaction(async (em) => {
      await em.query(
        `UPDATE customers
            SET loyalty_points = loyalty_points + $1,
                updated_at = NOW()
          WHERE id = $2`,
        [body.delta, customerId],
      );
      await em.query(
        `INSERT INTO customer_loyalty_transactions
           (customer_id, direction, points, reason, reference_type, user_id)
         VALUES ($1, $2, $3, $4, 'manual', $5)`,
        [
          customerId,
          body.delta > 0 ? 'in' : 'out',
          Math.abs(body.delta),
          body.reason || (body.delta > 0 ? 'manual_add' : 'manual_subtract'),
          body.user_id,
        ],
      );
      const [after] = await em.query(
        `SELECT loyalty_points FROM customers WHERE id = $1`,
        [customerId],
      );
      return {
        previous: current,
        delta: body.delta,
        current: Number(after.loyalty_points),
      };
    });
  }

  /** Admin: update loyalty settings (points_per_egp, egp_per_point, etc.). */
  async updateConfig(patch: Partial<Awaited<ReturnType<LoyaltyService['getConfig']>>>) {
    const current = await this.getConfig();
    const merged = { ...current, ...patch };
    await this.ds.query(
      `INSERT INTO settings (key, value)
       VALUES ('loyalty.rate', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify(merged)],
    );
    return merged;
  }

  async history(customerId: string, limit = 100) {
    return this.ds.query(
      `
      SELECT clt.*, u.username, u.full_name
        FROM customer_loyalty_transactions clt
        LEFT JOIN users u ON u.id = clt.user_id
       WHERE clt.customer_id = $1
       ORDER BY clt.created_at DESC
       LIMIT $2
      `,
      [customerId, limit],
    );
  }
}
