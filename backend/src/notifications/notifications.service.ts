import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { WhatsAppProvider } from './providers/whatsapp.provider';
import { SmsProvider } from './providers/sms.provider';

export type NotificationChannel = 'whatsapp' | 'sms' | 'email';
export type NotificationStatus =
  | 'queued'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'cancelled';

export interface EnqueueNotificationInput {
  channel: NotificationChannel;
  recipient: string;
  body: string;
  subject?: string;
  template_code?: string;
  reference_type?: string;
  reference_id?: string;
  metadata?: Record<string, any>;
  scheduled_at?: Date;
  created_by?: string;
}

export interface EnqueueFromTemplateInput {
  code: string;                          // template code
  recipient?: string;                    // optional override
  variables?: Record<string, any>;
  reference_type?: string;
  reference_id?: string;
  metadata?: Record<string, any>;
  created_by?: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger('NotificationsService');

  constructor(
    private readonly ds: DataSource,
    private readonly whatsapp: WhatsAppProvider,
    private readonly sms: SmsProvider,
  ) {}

  // ---------------------------------------------------------------------
  // Templates
  // ---------------------------------------------------------------------
  async listTemplates() {
    return this.ds.query(
      `SELECT * FROM notification_templates ORDER BY channel, code`,
    );
  }

  async getTemplate(code: string) {
    const [t] = await this.ds.query(
      `SELECT * FROM notification_templates WHERE code = $1`,
      [code],
    );
    return t;
  }

  async upsertTemplate(body: {
    code: string;
    name_ar: string;
    channel: NotificationChannel;
    subject?: string;
    body: string;
    is_active?: boolean;
  }) {
    const [t] = await this.ds.query(
      `
      INSERT INTO notification_templates (code, name_ar, channel, subject, body, is_active)
      VALUES ($1,$2,$3,$4,$5, COALESCE($6, true))
      ON CONFLICT (code) DO UPDATE SET
        name_ar   = EXCLUDED.name_ar,
        channel   = EXCLUDED.channel,
        subject   = EXCLUDED.subject,
        body      = EXCLUDED.body,
        is_active = EXCLUDED.is_active,
        updated_at = now()
      RETURNING *
      `,
      [
        body.code,
        body.name_ar,
        body.channel,
        body.subject ?? null,
        body.body,
        body.is_active ?? true,
      ],
    );
    return t;
  }

  // ---------------------------------------------------------------------
  // Config helpers
  // ---------------------------------------------------------------------
  async getConfig() {
    const [row] = await this.ds.query(
      `SELECT value FROM settings WHERE key = 'notifications.config'`,
    );
    return row?.value ?? {};
  }

  // ---------------------------------------------------------------------
  // Enqueue + render
  // ---------------------------------------------------------------------
  /** Simple handlebars-ish replacement for `{{var}}` placeholders */
  private render(template: string, vars: Record<string, any> = {}): string {
    return template.replace(/{{\s*([\w.]+)\s*}}/g, (_, key) => {
      const val = key
        .split('.')
        .reduce((acc: any, k: string) => acc?.[k], vars);
      return val == null ? '' : String(val);
    });
  }

  async enqueue(input: EnqueueNotificationInput) {
    const [n] = await this.ds.query(
      `
      INSERT INTO notifications
        (channel, recipient, subject, body, template_code,
         reference_type, reference_id, metadata, scheduled_at, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8::jsonb, '{}'::jsonb), $9, $10)
      RETURNING *
      `,
      [
        input.channel,
        input.recipient,
        input.subject ?? null,
        input.body,
        input.template_code ?? null,
        input.reference_type ?? null,
        input.reference_id ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        input.scheduled_at ?? null,
        input.created_by ?? null,
      ],
    );
    return n;
  }

  async enqueueFromTemplate(input: EnqueueFromTemplateInput) {
    const tpl = await this.getTemplate(input.code);
    if (!tpl) throw new NotFoundException(`Template ${input.code} not found`);
    if (!tpl.is_active)
      throw new BadRequestException(`Template ${input.code} is disabled`);

    const recipient =
      input.recipient ?? (input.variables as any)?.phone ?? null;
    if (!recipient) throw new BadRequestException('recipient is required');

    const body = this.render(tpl.body, input.variables ?? {});
    const subject = tpl.subject
      ? this.render(tpl.subject, input.variables ?? {})
      : null;

    return this.enqueue({
      channel: tpl.channel,
      recipient,
      subject: subject ?? undefined,
      body,
      template_code: tpl.code,
      reference_type: input.reference_type,
      reference_id: input.reference_id,
      metadata: input.metadata,
      created_by: input.created_by,
    });
  }

  // ---------------------------------------------------------------------
  // Send (one or many)
  // ---------------------------------------------------------------------
  async sendNow(id: string) {
    const [n] = await this.ds.query(
      `SELECT * FROM notifications WHERE id = $1`,
      [id],
    );
    if (!n) throw new NotFoundException(`Notification ${id} not found`);
    if (n.status === 'sent')
      throw new BadRequestException('Already sent');

    return this.dispatch(n);
  }

  async processQueue(limit = 25) {
    // pick queued (or scheduled <= now) up to limit
    const items = await this.ds.query(
      `
      SELECT * FROM notifications
      WHERE status IN ('queued', 'failed')
        AND (scheduled_at IS NULL OR scheduled_at <= now())
        AND attempts < 5
      ORDER BY created_at
      LIMIT $1
      `,
      [limit],
    );
    const results: any[] = [];
    for (const n of items) {
      try {
        results.push(await this.dispatch(n));
      } catch (err: any) {
        results.push({ id: n.id, error: err?.message });
      }
    }
    return { processed: items.length, results };
  }

  private async dispatch(n: any) {
    await this.ds.query(
      `UPDATE notifications SET status = 'sending', attempts = attempts + 1 WHERE id = $1`,
      [n.id],
    );

    const config = await this.getConfig();

    try {
      let result;
      if (n.channel === 'whatsapp') {
        result = await this.whatsapp.send(
          { recipient: n.recipient, body: n.body, templateCode: n.template_code },
          config.whatsapp || {},
        );
      } else if (n.channel === 'sms') {
        result = await this.sms.send(
          { recipient: n.recipient, body: n.body },
          config.sms || {},
        );
      } else if (n.channel === 'email') {
        // Email not implemented yet — mark as simulated sent
        result = { provider: 'stub', provider_msg_id: `stub-${Date.now()}` };
      } else {
        throw new Error(`Unsupported channel ${n.channel}`);
      }

      await this.ds.query(
        `
        UPDATE notifications
        SET status = 'sent',
            sent_at = now(),
            provider = $2,
            provider_msg_id = $3,
            last_error = NULL
        WHERE id = $1
        `,
        [n.id, result.provider, result.provider_msg_id ?? null],
      );
      return { id: n.id, status: 'sent', provider: result.provider };
    } catch (err: any) {
      const msg = err?.message || String(err);
      this.logger.error(`Notification ${n.id} failed: ${msg}`);
      await this.ds.query(
        `
        UPDATE notifications
        SET status = 'failed', last_error = $2
        WHERE id = $1
        `,
        [n.id, msg],
      );
      return { id: n.id, status: 'failed', error: msg };
    }
  }

  async retry(id: string) {
    await this.ds.query(
      `UPDATE notifications SET status = 'queued', last_error = NULL WHERE id = $1 AND status = 'failed'`,
      [id],
    );
    return this.sendNow(id);
  }

  async cancel(id: string) {
    const [n] = await this.ds.query(
      `
      UPDATE notifications
      SET status = 'cancelled'
      WHERE id = $1 AND status IN ('queued', 'failed')
      RETURNING *
      `,
      [id],
    );
    if (!n) throw new NotFoundException('Cannot cancel this notification');
    return n;
  }

  // ---------------------------------------------------------------------
  // Listing + stats
  // ---------------------------------------------------------------------
  async list(filters: {
    status?: NotificationStatus;
    channel?: NotificationChannel;
    reference_type?: string;
    reference_id?: string;
    limit?: number;
  } = {}) {
    const where: string[] = [];
    const params: any[] = [];
    if (filters.status) {
      params.push(filters.status);
      where.push(`status = $${params.length}`);
    }
    if (filters.channel) {
      params.push(filters.channel);
      where.push(`channel = $${params.length}`);
    }
    if (filters.reference_type) {
      params.push(filters.reference_type);
      where.push(`reference_type = $${params.length}`);
    }
    if (filters.reference_id) {
      params.push(filters.reference_id);
      where.push(`reference_id = $${params.length}`);
    }
    params.push(filters.limit ?? 100);
    const sql = `
      SELECT * FROM notifications
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY created_at DESC
      LIMIT $${params.length}
    `;
    return this.ds.query(sql, params);
  }

  async stats() {
    const [byStatus, byChannel, today] = await Promise.all([
      this.ds.query(
        `SELECT status, COUNT(*)::int AS count
         FROM notifications GROUP BY status`,
      ),
      this.ds.query(
        `SELECT channel, COUNT(*)::int AS count
         FROM notifications GROUP BY channel`,
      ),
      this.ds.query(
        `SELECT COUNT(*)::int AS total
         FROM notifications
         WHERE created_at >= date_trunc('day', now())`,
      ),
    ]);
    return {
      by_status: byStatus,
      by_channel: byChannel,
      today_count: today[0]?.total ?? 0,
    };
  }
}
