import { api, unwrap } from './client';

export interface SetupStatus {
  needs_setup: boolean;
  user_count: number;
  setup_complete: boolean;
}

export interface SetupInitPayload {
  admin: {
    username: string;
    password: string;
    full_name: string;
    email?: string;
    phone?: string;
  };
  shop: {
    name: string;
    address?: string;
    phone?: string;
    tax_id?: string;
    vat_number?: string;
    footer_note?: string;
  };
  warehouse: {
    code: string;
    name: string;
  };
  loyalty?: {
    points_per_egp?: number;
    egp_per_point?: number;
    min_redeem?: number;
    max_redeem_ratio?: number;
  };
  currency?: string;
  vat_rate?: number;
}

export interface SetupInitResponse {
  success: boolean;
  admin: { id: string; username: string; message: string };
  warehouse: { id: string; code: string; name: string };
}

export const setupApi = {
  status: () => unwrap<SetupStatus>(api.get('/setup/status')),
  init: (body: SetupInitPayload) =>
    unwrap<SetupInitResponse>(api.post('/setup/init', body)),
};
