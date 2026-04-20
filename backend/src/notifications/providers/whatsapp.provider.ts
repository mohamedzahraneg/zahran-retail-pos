import { Injectable, Logger } from '@nestjs/common';

export interface WhatsAppSendParams {
  recipient: string; // E.164 phone number
  body: string;
  templateCode?: string;
}

export interface WhatsAppSendResult {
  provider: string;
  provider_msg_id?: string;
  raw?: any;
}

export interface WhatsAppConfig {
  /**
   * meta_cloud / twilio / generic_http send via a real API.
   * click_to_chat short-circuits: no API call — the provider returns a
   * wa.me URL so the frontend opens WhatsApp with the body pre-filled
   * and the agent presses Send manually. Useful when you don't have
   * (or don't want) API credentials.
   */
  provider?: 'meta_cloud' | 'twilio' | 'generic_http' | 'click_to_chat';
  api_url?: string;
  token?: string;
  phone_id?: string;
  enabled?: boolean;
}

/**
 * WhatsApp sender — supports Meta's WhatsApp Cloud API by default,
 * with a generic HTTP fallback for self-hosted gateways. If no config
 * is provided, it simulates sending (useful in dev / CI).
 */
@Injectable()
export class WhatsAppProvider {
  private readonly logger = new Logger('WhatsAppProvider');

  async send(
    params: WhatsAppSendParams,
    config: WhatsAppConfig,
  ): Promise<WhatsAppSendResult> {
    const provider = config?.provider || 'meta_cloud';

    // click_to_chat doesn't care if enabled=false — just returns the URL.
    if (provider === 'click_to_chat') {
      const digits = params.recipient.replace(/[^\d]/g, '');
      const url = `https://wa.me/${digits}?text=${encodeURIComponent(params.body)}`;
      this.logger.log(`WhatsApp click-to-chat URL: ${url}`);
      return { provider: 'click_to_chat', provider_msg_id: url, raw: { url } };
    }

    if (!config?.enabled) {
      // Previously silently simulated — now fail loudly so the UI surfaces
      // the fact that WhatsApp isn't configured.
      throw new Error(
        'WhatsApp غير مُفعّل — اذهب إلى الإشعارات → إعدادات واختر مزوّداً (click_to_chat للاستخدام بدون API)',
      );
    }

    if (provider === 'meta_cloud') {
      return this.sendMetaCloud(params, config);
    }
    return this.sendGenericHttp(params, config);
  }

  private async sendMetaCloud(
    { recipient, body }: WhatsAppSendParams,
    config: WhatsAppConfig,
  ): Promise<WhatsAppSendResult> {
    const url =
      config.api_url ||
      `https://graph.facebook.com/v20.0/${config.phone_id}/messages`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: recipient,
        type: 'text',
        text: { body },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`WhatsApp Meta error ${res.status}: ${err}`);
    }
    const json: any = await res.json();
    return {
      provider: 'meta_cloud',
      provider_msg_id: json?.messages?.[0]?.id,
      raw: json,
    };
  }

  private async sendGenericHttp(
    { recipient, body }: WhatsAppSendParams,
    config: WhatsAppConfig,
  ): Promise<WhatsAppSendResult> {
    if (!config.api_url) {
      throw new Error('WhatsApp generic_http provider requires api_url');
    }
    const res = await fetch(config.api_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      },
      body: JSON.stringify({ to: recipient, message: body }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`WhatsApp HTTP error ${res.status}: ${err}`);
    }
    const json: any = await res.json().catch(() => ({}));
    return {
      provider: 'generic_http',
      provider_msg_id: json?.id || json?.message_id,
      raw: json,
    };
  }
}
