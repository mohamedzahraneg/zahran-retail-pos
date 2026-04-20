import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';

export interface SetupInitDto {
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
  currency?: string;       // default: EGP
  vat_rate?: number;       // default: 0
}

@Injectable()
export class SetupService {
  constructor(private readonly ds: DataSource) {}

  /**
   * Setup is considered "needed" if:
   *  - no user exists, OR
   *  - settings key 'system.setup_complete' is missing/false
   */
  async status() {
    const [userCount] = await this.ds.query(
      `SELECT COUNT(*)::int AS n FROM users`,
    );
    const [flag] = await this.ds.query(
      `SELECT value FROM settings WHERE key = 'system.setup_complete'`,
    );
    const setup_complete =
      !!flag?.value && (flag.value === true || flag.value?.value === true);
    const needs_setup = userCount.n === 0 || !setup_complete;
    return {
      needs_setup,
      user_count: userCount.n,
      setup_complete,
    };
  }

  async init(dto: SetupInitDto) {
    // Re-check to avoid race-conditions
    const st = await this.status();
    if (!st.needs_setup) {
      throw new ConflictException('System already initialized');
    }

    if (!dto.admin?.username || !dto.admin?.password) {
      throw new BadRequestException('Admin credentials are required');
    }
    if (dto.admin.password.length < 8) {
      throw new BadRequestException('Admin password must be ≥ 8 chars');
    }
    if (!dto.shop?.name) {
      throw new BadRequestException('Shop name is required');
    }
    if (!dto.warehouse?.code || !dto.warehouse?.name) {
      throw new BadRequestException('Warehouse code and name are required');
    }

    return this.ds.transaction(async (em) => {
      // 1) Ensure admin role exists
      let [adminRole] = await em.query(
        `SELECT id FROM roles WHERE code = 'admin' LIMIT 1`,
      );
      if (!adminRole) {
        [adminRole] = await em.query(
          `
          INSERT INTO roles (code, name_ar, name_en)
          VALUES ('admin', 'مدير النظام', 'System Admin')
          RETURNING id
          `,
        );
      }

      // 2) Create warehouse
      let [warehouse] = await em.query(
        `SELECT id FROM warehouses WHERE code = $1`,
        [dto.warehouse.code],
      );
      if (!warehouse) {
        [warehouse] = await em.query(
          `
          INSERT INTO warehouses (code, name, is_active)
          VALUES ($1, $2, true)
          RETURNING id
          `,
          [dto.warehouse.code, dto.warehouse.name],
        );
      }

      // 3) Create admin user
      const password_hash = await bcrypt.hash(dto.admin.password, 12);
      const [existingUser] = await em.query(
        `SELECT id FROM users WHERE username = $1`,
        [dto.admin.username],
      );
      if (existingUser) {
        throw new ConflictException(
          `User "${dto.admin.username}" already exists`,
        );
      }
      const [admin] = await em.query(
        `
        INSERT INTO users
          (username, password_hash, full_name, email, phone,
           role_id, branch_id, is_active)
        VALUES ($1,$2,$3,$4,$5,$6,$7,true)
        RETURNING id, username
        `,
        [
          dto.admin.username,
          password_hash,
          dto.admin.full_name,
          dto.admin.email ?? null,
          dto.admin.phone ?? null,
          adminRole.id,
          warehouse.id,
        ],
      );

      // 4) Persist shop info in settings
      const shop = {
        name: dto.shop.name,
        address: dto.shop.address || '',
        phone: dto.shop.phone || '',
        tax_id: dto.shop.tax_id || '',
        vat_number: dto.shop.vat_number || '',
        footer_note: dto.shop.footer_note || 'شكراً لتسوقك من زهران',
      };
      await em.query(
        `
        INSERT INTO settings (key, value, description)
        VALUES ('shop.info', $1::jsonb, 'Shop display information for receipts')
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
        `,
        [JSON.stringify(shop)],
      );

      // 5) Currency + VAT
      await em.query(
        `
        INSERT INTO settings (key, value, description)
        VALUES ('currency', $1::jsonb, 'Default currency')
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
        `,
        [JSON.stringify({ code: dto.currency || 'EGP', symbol: 'ج.م' })],
      );

      if (dto.vat_rate != null) {
        await em.query(
          `
          INSERT INTO settings (key, value, description)
          VALUES ('tax.vat_rate', $1::jsonb, 'Default VAT rate (%)')
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
          `,
          [JSON.stringify({ rate: dto.vat_rate })],
        );
      }

      // 6) Loyalty (if provided)
      const loyalty = {
        points_per_egp: dto.loyalty?.points_per_egp ?? 0.1,
        egp_per_point: dto.loyalty?.egp_per_point ?? 0.05,
        min_redeem: dto.loyalty?.min_redeem ?? 100,
        max_redeem_ratio: dto.loyalty?.max_redeem_ratio ?? 0.9,
      };
      await em.query(
        `
        INSERT INTO settings (key, value, description)
        VALUES ('loyalty.rate', $1::jsonb, 'Loyalty points conversion rates')
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
        `,
        [JSON.stringify(loyalty)],
      );

      // 7) Mark setup complete
      await em.query(
        `
        INSERT INTO settings (key, value, description)
        VALUES ('system.setup_complete',
                jsonb_build_object('value', true, 'completed_at', now()),
                'First-run setup completion flag')
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
        `,
      );

      return {
        success: true,
        admin: {
          id: admin.id,
          username: admin.username,
          message: 'استخدم اسم المستخدم وكلمة السر لتسجيل الدخول',
        },
        warehouse: {
          id: warehouse.id,
          code: dto.warehouse.code,
          name: dto.warehouse.name,
        },
      };
    });
  }
}
