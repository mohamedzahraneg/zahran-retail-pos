import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const UAParser = require('ua-parser-js');

export interface ClockCtx {
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Parse a User-Agent string into a small structured device record — used to
 * enrich check-in / check-out rows with browser, OS, and device type info.
 */
function deviceFromUA(ua: string | null | undefined) {
  if (!ua) return null;
  const p = UAParser(ua);
  return {
    browser: p.browser?.name
      ? `${p.browser.name}${p.browser.version ? ' ' + p.browser.version : ''}`
      : null,
    os: p.os?.name
      ? `${p.os.name}${p.os.version ? ' ' + p.os.version : ''}`
      : null,
    device_type: p.device?.type || 'desktop',
    device_model:
      [p.device?.vendor, p.device?.model].filter(Boolean).join(' ') || null,
  };
}

@Injectable()
export class AttendanceService {
  constructor(private readonly ds: DataSource) {}

  async clockIn(userId: string, ctx: ClockCtx = {}, note?: string) {
    const today = new Date().toISOString().slice(0, 10);
    const existing = await this.ds.query(
      `SELECT id, clock_in, clock_out FROM attendance_records
        WHERE user_id = $1 AND work_date = $2`,
      [userId, today],
    );
    if (existing[0]?.clock_in && !existing[0]?.clock_out) {
      throw new BadRequestException('سجّلت حضورك بالفعل اليوم');
    }
    const device = deviceFromUA(ctx.userAgent);
    const deviceJson = device ? JSON.stringify(device) : null;
    if (existing[0] && existing[0].clock_out) {
      // Re-opening the same day — clear clock_out and reset clock_in
      const [row] = await this.ds.query(
        `UPDATE attendance_records
            SET clock_in = now(), clock_out = NULL,
                ip_in = NULLIF($2,'')::inet, device_in = $3::jsonb,
                ip_out = NULL, device_out = NULL,
                note = COALESCE($4::text, note)
          WHERE id = $1
          RETURNING *`,
        [existing[0].id, ctx.ip || '', deviceJson, note || null],
      );
      return row;
    }
    const [row] = await this.ds.query(
      `INSERT INTO attendance_records
         (user_id, work_date, clock_in, ip_in, device_in, note)
       VALUES ($1, $2, now(), NULLIF($3,'')::inet, $4::jsonb, $5::text)
       RETURNING *`,
      [userId, today, ctx.ip || '', deviceJson, note || null],
    );
    return row;
  }

  async clockOut(userId: string, ctx: ClockCtx = {}, note?: string) {
    const today = new Date().toISOString().slice(0, 10);
    const [row] = await this.ds.query(
      `SELECT id, clock_in, clock_out FROM attendance_records
        WHERE user_id = $1 AND work_date = $2`,
      [userId, today],
    );
    if (!row) throw new BadRequestException('لم تسجّل حضورك اليوم');
    if (row.clock_out) throw new BadRequestException('سجّلت انصرافك بالفعل');
    const device = deviceFromUA(ctx.userAgent);
    const deviceJson = device ? JSON.stringify(device) : null;
    const [updated] = await this.ds.query(
      `UPDATE attendance_records
          SET clock_out = now(),
              ip_out = NULLIF($2,'')::inet, device_out = $3::jsonb,
              note = CASE WHEN $4::text IS NOT NULL THEN COALESCE(note || E'\n', '') || $4::text ELSE note END
        WHERE id = $1
        RETURNING *`,
      [row.id, ctx.ip || '', deviceJson, note || null],
    );
    return updated;
  }

  async myToday(userId: string) {
    const today = new Date().toISOString().slice(0, 10);
    const [row] = await this.ds.query(
      `SELECT * FROM attendance_records WHERE user_id = $1 AND work_date = $2`,
      [userId, today],
    );
    return row || null;
  }

  async list(params: {
    user_id?: string;
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
    if (params.from) {
      args.push(params.from);
      where.push(`a.work_date >= $${args.length}::date`);
    }
    if (params.to) {
      args.push(params.to);
      where.push(`a.work_date <= $${args.length}::date`);
    }
    const limit = Math.min(Math.max(Number(params.limit) || 200, 1), 1000);
    return this.ds.query(
      `SELECT a.*, u.username, u.full_name, u.role_id, r.name_ar AS role_name
         FROM attendance_records a
         LEFT JOIN users u ON u.id = a.user_id
         LEFT JOIN roles r ON r.id = u.role_id
        WHERE ${where.join(' AND ')}
        ORDER BY a.work_date DESC, a.clock_in DESC
        LIMIT ${limit}`,
      args,
    );
  }

  /** Per-user totals over the selected period. */
  async summary(params: { from?: string; to?: string }) {
    const where: string[] = ['1=1'];
    const args: any[] = [];
    if (params.from) {
      args.push(params.from);
      where.push(`a.work_date >= $${args.length}::date`);
    }
    if (params.to) {
      args.push(params.to);
      where.push(`a.work_date <= $${args.length}::date`);
    }
    return this.ds.query(
      `SELECT u.id AS user_id, u.username, u.full_name,
              COUNT(a.id)::int AS days_present,
              COALESCE(SUM(a.duration_min), 0)::int AS total_minutes,
              MIN(a.clock_in) AS first_in,
              MAX(a.clock_out) AS last_out
         FROM users u
         LEFT JOIN attendance_records a
                ON a.user_id = u.id AND ${where.join(' AND ').replace(/a\./g, 'a.')}
        WHERE u.is_active = true
        GROUP BY u.id, u.username, u.full_name
        ORDER BY total_minutes DESC NULLS LAST`,
      args,
    );
  }

  async adjust(
    id: string,
    dto: { clock_in?: string; clock_out?: string; note?: string },
  ) {
    const [row] = await this.ds.query(
      `SELECT id FROM attendance_records WHERE id = $1`,
      [id],
    );
    if (!row) throw new NotFoundException('السجل غير موجود');
    const [updated] = await this.ds.query(
      `UPDATE attendance_records
          SET clock_in  = COALESCE($2::timestamptz, clock_in),
              clock_out = COALESCE($3::timestamptz, clock_out),
              note      = COALESCE($4::text, note)
        WHERE id = $1
        RETURNING *`,
      [id, dto.clock_in || null, dto.clock_out || null, dto.note || null],
    );
    return updated;
  }
}
