import { Injectable, Logger } from '@nestjs/common';

export interface SmsSendParams {
  recipient: string;
  body: string;
}

export interface SmsSendResult {
  provider: string;
  provider_msg_id?: string;
  raw?: any;
}

export interface SmsConfig {
  provider?: 'generic_http' | 'twilio';
  api_url?: string;
  api_key?: string;
  sender_id?: string;
  account_sid?: string;
  auth_token?: string;
  enabled?: boolean;
}

@Injectable()
export class SmsProvider {
  private readonly logger = new Logger('SmsProvider');

  async send(
    params: SmsSendParams,
    config: SmsConfig,
  ): Promise<SmsSendResult> {
    if (!config?.enabled) {
      this.logger.warn(`SMS disabled — simulating send to ${params.recipient}`);
      return { provider: 'simulated', provider_msg_id: `sim-${Date.now()}` };
    }

    if (config.provider === 'twilio') {
      return this.sendTwilio(params, config);
    }
    return this.sendGenericHttp(params, config);
  }

  private async sendGenericHttp(
    { recipient, body }: SmsSendParams,
    config: SmsConfig,
  ): Promise<SmsSendResult> {
    if (!config.api_url) {
      throw new Error('SMS generic_http provider requires api_url');
    }
    const res = await fetch(config.api_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.api_key
          ? { Authorization: `Bearer ${config.api_key}` }
          : {}),
      },
      body: JSON.stringify({
        to: recipient,
        from: config.sender_id,
        message: body,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`SMS HTTP error ${res.status}: ${err}`);
    }
    const json: any = await res.json().catch(() => ({}));
    return {
      provider: 'generic_http',
      provider_msg_id: json?.id || json?.message_id,
      raw: json,
    };
  }

  private async sendTwilio(
    { recipient, body }: SmsSendParams,
    config: SmsConfig,
  ): Promise<SmsSendResult> {
    if (!config.account_sid || !config.auth_token) {
      throw new Error('Twilio requires account_sid and auth_token');
    }
    const url = `https://api.twilio.com/2010-04-01/Accounts/${config.account_sid}/Messages.json`;
    const params = new URLSearchParams({
      From: config.sender_id || '',
      To: recipient,
      Body: body,
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization:
          'Basic ' +
          Buffer.from(
            `${config.account_sid}:${config.auth_token}`,
          ).toString('base64'),
      },
      body: params.toString(),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Twilio error ${res.status}: ${err}`);
    }
    const json: any = await res.json();
    return { provider: 'twilio', provider_msg_id: json.sid, raw: json };
  }
}
