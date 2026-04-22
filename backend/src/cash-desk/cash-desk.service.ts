import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  CreateCustomerPaymentDto,
  CreateSupplierPaymentDto,
} from './dto/payment.dto';

export type CashboxKind = 'cash' | 'bank' | 'ewallet' | 'check';

export interface CreateCashboxDto {
  name_ar: string;
  warehouse_id?: string;
  kind: CashboxKind;
  currency?: string;
  opening_balance?: number;
  color?: string;
  // Bank fields
  institution_code?: string;
  bank_branch?: string;
  account_number?: string;
  iban?: string;
  swift_code?: string;
  account_holder_name?: string;
  account_manager_name?: string;
  account_manager_phone?: string;
  account_manager_email?: string;
  // Wallet
  wallet_phone?: string;
  wallet_owner_name?: string;
  // Check
  check_issuer_name?: string;
  notes?: string;
}

export interface UpdateCashboxDto extends Partial<CreateCashboxDto> {
  is_active?: boolean;
}

@Injectable()
export class CashDeskService {
  constructor(private readonly ds: DataSource) {}

  /** Look up the warehouse_id for a cashbox (NOT NULL on both payment tables). */
  private async warehouseForCashbox(
    em: { query: (sql: string, params?: any[]) => Promise<any[]> },
    cashboxId: string,
  ) {
    const [row] = await em.query(
      `SELECT warehouse_id FROM cashboxes WHERE id = $1`,
      [cashboxId],
    );
    if (!row) throw new Error(`cashbox ${cashboxId} not found`);
    return row.warehouse_id as string;
  }

  /** Receive a customer payment — relies on triggers from migration 014 */
  async receiveFromCustomer(dto: CreateCustomerPaymentDto, userId: string) {
    return this.ds.transaction(async (em) => {
      const [{ seq }] = await em.query(
        `SELECT nextval('seq_customer_payment_no') AS seq`,
      );
      const paymentNo = `CR-${String(seq).padStart(6, '0')}`;
      const warehouseId = await this.warehouseForCashbox(em, dto.cashbox_id);

      const [payment] = await em.query(
        `
        INSERT INTO customer_payments
          (payment_no, customer_id, cashbox_id, warehouse_id,
           payment_method, amount, kind,
           reference_number, notes, received_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING *
        `,
        [
          paymentNo,
          dto.customer_id,
          dto.cashbox_id,
          warehouseId,
          dto.payment_method,
          dto.amount,
          dto.kind ?? 'invoice_settlement',
          dto.reference ?? null,
          dto.notes ?? null,
          userId,
        ],
      );

      if (dto.allocations?.length) {
        for (const a of dto.allocations) {
          await em.query(
            `INSERT INTO customer_payment_allocations (payment_id, invoice_id, amount)
             VALUES ($1,$2,$3)`,
            [payment.id, a.invoice_id, a.amount],
          );
        }
      }
      return payment;
    });
  }

  /** Pay a supplier */
  async payToSupplier(dto: CreateSupplierPaymentDto, userId: string) {
    return this.ds.transaction(async (em) => {
      const [{ seq }] = await em.query(
        `SELECT nextval('seq_supplier_payment_no') AS seq`,
      );
      const paymentNo = `CP-${String(seq).padStart(6, '0')}`;
      const warehouseId = await this.warehouseForCashbox(em, dto.cashbox_id);

      const [payment] = await em.query(
        `
        INSERT INTO supplier_payments
          (payment_no, supplier_id, cashbox_id, warehouse_id,
           payment_method, amount,
           reference_number, notes, paid_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING *
        `,
        [
          paymentNo,
          dto.supplier_id,
          dto.cashbox_id,
          warehouseId,
          dto.payment_method,
          dto.amount,
          dto.reference ?? null,
          dto.notes ?? null,
          userId,
        ],
      );

      if (dto.allocations?.length) {
        for (const a of dto.allocations) {
          await em.query(
            `INSERT INTO supplier_payment_allocations (payment_id, purchase_id, amount)
             VALUES ($1,$2,$3)`,
            [payment.id, a.invoice_id, a.amount],
          );
        }
      }
      return payment;
    });
  }

  async voidCustomerPayment(id: string, userId: string, reason: string) {
    await this.ds.query(
      `UPDATE customer_payments SET is_void = true, void_reason = $2, voided_by = $3, voided_at = now()
       WHERE id = $1`,
      [id, reason, userId],
    );
    return { voided: true };
  }

  listCustomerPayments(customerId?: string) {
    return customerId
      ? this.ds.query(
          `SELECT * FROM customer_payments WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 200`,
          [customerId],
        )
      : this.ds.query(
          `SELECT * FROM customer_payments ORDER BY created_at DESC LIMIT 200`,
        );
  }

  listSupplierPayments(supplierId?: string) {
    return supplierId
      ? this.ds.query(
          `SELECT * FROM supplier_payments WHERE supplier_id = $1 ORDER BY created_at DESC LIMIT 200`,
          [supplierId],
        )
      : this.ds.query(
          `SELECT * FROM supplier_payments ORDER BY created_at DESC LIMIT 200`,
        );
  }

  listCashboxes(includeInactive = false) {
    return this.ds.query(
      `
      SELECT cb.*, cb.name_ar AS name,
             fi.name_ar        AS institution_name,
             fi.name_en        AS institution_name_en,
             fi.website_domain AS institution_domain,
             fi.color_hex      AS institution_color,
             fi.kind           AS institution_kind
        FROM cashboxes cb
        LEFT JOIN financial_institutions fi ON fi.code = cb.institution_code
       ${includeInactive ? '' : 'WHERE cb.is_active = true'}
       ORDER BY cb.kind, cb.name_ar
      `,
    );
  }

  /** Full list of bank / wallet presets — powers the picker in the UI. */
  listInstitutions(kind?: 'bank' | 'ewallet' | 'check_issuer') {
    const conds: string[] = ['is_active = true'];
    const args: any[] = [];
    if (kind) {
      args.push(kind);
      conds.push(`kind = $${args.length}`);
    }
    return this.ds.query(
      `SELECT * FROM financial_institutions
        WHERE ${conds.join(' AND ')}
        ORDER BY sort_order, name_ar`,
      args,
    );
  }

  async createCashbox(dto: CreateCashboxDto) {
    if (!dto.name_ar?.trim())
      throw new BadRequestException('اسم الخزنة مطلوب');
    if (!['cash', 'bank', 'ewallet', 'check'].includes(dto.kind)) {
      throw new BadRequestException('نوع الخزنة غير صحيح');
    }
    // Bank requires an institution; wallet too.
    if (
      (dto.kind === 'bank' || dto.kind === 'ewallet') &&
      !dto.institution_code
    ) {
      throw new BadRequestException('يجب اختيار البنك / المحفظة');
    }

    // Fall back to a valid warehouse if none given (cashboxes NOT NULL).
    let warehouseId = dto.warehouse_id ?? null;
    if (!warehouseId) {
      const [w] = await this.ds.query(
        `SELECT id FROM warehouses WHERE is_active = TRUE ORDER BY created_at LIMIT 1`,
      );
      warehouseId = w?.id ?? null;
    }
    if (!warehouseId) {
      throw new BadRequestException('لا يوجد مخزن نشط لربط الخزنة به');
    }

    const [row] = await this.ds.query(
      `
      INSERT INTO cashboxes
        (name_ar, warehouse_id, currency, kind, institution_code,
         bank_branch, account_number, iban, swift_code,
         account_holder_name, account_manager_name, account_manager_phone,
         account_manager_email, wallet_phone, wallet_owner_name,
         check_issuer_name, color, current_balance, opening_balance,
         is_active)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18,TRUE)
      RETURNING *
      `,
      [
        dto.name_ar.trim(),
        warehouseId,
        dto.currency ?? 'EGP',
        dto.kind,
        dto.institution_code ?? null,
        dto.bank_branch ?? null,
        dto.account_number ?? null,
        dto.iban ?? null,
        dto.swift_code ?? null,
        dto.account_holder_name ?? null,
        dto.account_manager_name ?? null,
        dto.account_manager_phone ?? null,
        dto.account_manager_email ?? null,
        dto.wallet_phone ?? null,
        dto.wallet_owner_name ?? null,
        dto.check_issuer_name ?? null,
        dto.color ?? null,
        Number(dto.opening_balance || 0),
      ],
    );
    return row;
  }

  async updateCashbox(id: string, dto: UpdateCashboxDto) {
    const [exists] = await this.ds.query(
      `SELECT id, kind FROM cashboxes WHERE id = $1`,
      [id],
    );
    if (!exists) throw new NotFoundException('الخزنة غير موجودة');

    const sets: string[] = [];
    const args: any[] = [];
    const push = (col: string, val: any) => {
      args.push(val);
      sets.push(`${col} = $${args.length}`);
    };
    if (dto.name_ar !== undefined) push('name_ar', dto.name_ar);
    if (dto.kind !== undefined) push('kind', dto.kind);
    if (dto.warehouse_id !== undefined) push('warehouse_id', dto.warehouse_id);
    if (dto.currency !== undefined) push('currency', dto.currency);
    if (dto.institution_code !== undefined)
      push('institution_code', dto.institution_code);
    if (dto.bank_branch !== undefined) push('bank_branch', dto.bank_branch);
    if (dto.account_number !== undefined)
      push('account_number', dto.account_number);
    if (dto.iban !== undefined) push('iban', dto.iban);
    if (dto.swift_code !== undefined) push('swift_code', dto.swift_code);
    if (dto.account_holder_name !== undefined)
      push('account_holder_name', dto.account_holder_name);
    if (dto.account_manager_name !== undefined)
      push('account_manager_name', dto.account_manager_name);
    if (dto.account_manager_phone !== undefined)
      push('account_manager_phone', dto.account_manager_phone);
    if (dto.account_manager_email !== undefined)
      push('account_manager_email', dto.account_manager_email);
    if (dto.wallet_phone !== undefined) push('wallet_phone', dto.wallet_phone);
    if (dto.wallet_owner_name !== undefined)
      push('wallet_owner_name', dto.wallet_owner_name);
    if (dto.check_issuer_name !== undefined)
      push('check_issuer_name', dto.check_issuer_name);
    if (dto.color !== undefined) push('color', dto.color);
    if (dto.is_active !== undefined) push('is_active', dto.is_active);

    if (!sets.length) return exists;

    sets.push(`updated_at = NOW()`);
    args.push(id);
    const [row] = await this.ds.query(
      `UPDATE cashboxes SET ${sets.join(', ')} WHERE id = $${args.length} RETURNING *`,
      args,
    );
    return row;
  }

  async removeCashbox(id: string) {
    // Safe-delete: require no open shifts & no movements.
    const [{ txn_count }] = await this.ds.query(
      `SELECT COUNT(*)::int AS txn_count FROM cashbox_transactions WHERE cashbox_id = $1`,
      [id],
    );
    if (txn_count > 0) {
      // Soft deactivate instead of destructive delete.
      await this.ds.query(
        `UPDATE cashboxes SET is_active = FALSE, updated_at = NOW() WHERE id = $1`,
        [id],
      );
      return { soft_deleted: true, reason: 'has_movements' };
    }
    const [{ open_shifts }] = await this.ds.query(
      `SELECT COUNT(*)::int AS open_shifts FROM shifts WHERE cashbox_id = $1 AND status IN ('open','pending_close')`,
      [id],
    );
    if (open_shifts > 0) {
      throw new BadRequestException('لا يمكن حذف خزنة عليها وردية مفتوحة');
    }
    await this.ds.query(`DELETE FROM cashboxes WHERE id = $1`, [id]);
    return { deleted: true };
  }

  /**
   * Today's in/out per cashbox, computed inline so the old
   * `v_dashboard_cashflow_today` view (which only returned
   * `cash_in_today`/`cash_out_today`) can't silently zero the KPIs out
   * on legacy DBs. Exposes both new and legacy column names.
   */
  cashflowToday() {
    return this.ds.query(`
      SELECT
        cb.id                                  AS cashbox_id,
        cb.name_ar                             AS cashbox_name,
        cb.current_balance,
        COALESCE(SUM(ct.amount) FILTER (
          WHERE ct.direction = 'in'
            AND DATE(ct.created_at AT TIME ZONE 'Africa/Cairo') = CURRENT_DATE
        ), 0)::numeric(14,2)                   AS cash_in_today,
        COALESCE(SUM(ct.amount) FILTER (
          WHERE ct.direction = 'out'
            AND DATE(ct.created_at AT TIME ZONE 'Africa/Cairo') = CURRENT_DATE
        ), 0)::numeric(14,2)                   AS cash_out_today,
        COALESCE(SUM(ct.amount) FILTER (
          WHERE ct.direction = 'in'
            AND DATE(ct.created_at AT TIME ZONE 'Africa/Cairo') = CURRENT_DATE
        ), 0)::numeric(14,2)                   AS inflows_total,
        COALESCE(SUM(ct.amount) FILTER (
          WHERE ct.direction = 'out'
            AND DATE(ct.created_at AT TIME ZONE 'Africa/Cairo') = CURRENT_DATE
        ), 0)::numeric(14,2)                   AS outflows_total,
        COUNT(*) FILTER (
          WHERE DATE(ct.created_at AT TIME ZONE 'Africa/Cairo') = CURRENT_DATE
        )::int                                 AS transactions_today
      FROM cashboxes cb
      LEFT JOIN cashbox_transactions ct ON ct.cashbox_id = cb.id
      WHERE cb.is_active = TRUE
      GROUP BY cb.id, cb.name_ar, cb.current_balance
      ORDER BY cb.name_ar
    `);
  }

  /**
   * Net/gross shift variance totals across every closed shift.
   * Powers the "فوارق الورديات" tile next to the cashbox KPIs.
   *
   * Computed inline (not from a view) so the endpoint keeps working on
   * DBs where migration 046 hasn't been applied yet.
   */
  async shiftVariances() {
    const [row] = await this.ds.query(`
      SELECT
        COALESCE(SUM(actual_closing - expected_closing), 0)::numeric(14,2) AS net_variance,
        COALESCE(SUM(GREATEST(actual_closing - expected_closing, 0)), 0)::numeric(14,2) AS total_surplus,
        COALESCE(SUM(GREATEST(expected_closing - actual_closing, 0)), 0)::numeric(14,2) AS total_deficit,
        COUNT(*) FILTER (WHERE actual_closing - expected_closing > 0.01)::int AS surplus_count,
        COUNT(*) FILTER (WHERE expected_closing - actual_closing > 0.01)::int AS deficit_count,
        COUNT(*) FILTER (WHERE ABS(actual_closing - expected_closing) <= 0.01)::int AS matched_count
      FROM shifts
      WHERE status = 'closed'
        AND actual_closing IS NOT NULL
    `);
    return (
      row || {
        net_variance: 0,
        total_surplus: 0,
        total_deficit: 0,
        surplus_count: 0,
        deficit_count: 0,
        matched_count: 0,
      }
    );
  }

  /**
   * Unified cashbox movement feed — every inflow and outflow with an
   * Arabic label and the source document's reference number. Supports
   * optional cashbox, date range, direction and limit filters so the
   * UI can paginate without extra queries.
   */
  movements(params: {
    cashbox_id?: string;
    from?: string;
    to?: string;
    direction?: 'in' | 'out';
    category?: string;
    limit?: number;
    offset?: number;
  }) {
    const conds: string[] = [];
    const args: any[] = [];
    if (params.cashbox_id) {
      args.push(params.cashbox_id);
      conds.push(`cashbox_id = $${args.length}`);
    }
    if (params.direction === 'in' || params.direction === 'out') {
      args.push(params.direction);
      conds.push(`direction = $${args.length}`);
    }
    if (params.category) {
      args.push(params.category);
      conds.push(`category = $${args.length}`);
    }
    if (params.from) {
      args.push(params.from);
      conds.push(
        `(created_at AT TIME ZONE 'Africa/Cairo')::date >= $${args.length}::date`,
      );
    }
    if (params.to) {
      args.push(params.to);
      conds.push(
        `(created_at AT TIME ZONE 'Africa/Cairo')::date <= $${args.length}::date`,
      );
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    args.push(Math.min(Number(params.limit ?? 200), 1000));
    args.push(Math.max(Number(params.offset ?? 0), 0));

    // Inline query — equivalent to v_cashbox_movements but works even
    // on DBs where migration 046 hasn't been applied yet. The view
    // stays around as a convenience for direct SQL consumers.
    const whereOnT = where
      ? where.replace(/cashbox_id/g, 't.cashbox_id')
             .replace(/direction/g, 't.direction')
             .replace(/category/g, 't.category')
             .replace(/created_at/g, 't.created_at')
      : '';
    return this.ds.query(
      `
      SELECT
        t.id, t.cashbox_id, cb.name_ar AS cashbox_name,
        t.direction::text AS direction,
        t.amount::numeric(14,2) AS amount,
        t.category::text AS category,
        t.reference_type::text AS reference_type,
        t.reference_id,
        t.balance_after::numeric(14,2) AS balance_after,
        t.notes, t.user_id, u.full_name AS user_name, t.created_at,
        CASE t.category
          WHEN 'customer_receipt' THEN 'قبض من عميل'
          WHEN 'supplier_payment' THEN 'صرف لمورد'
          WHEN 'expense'          THEN 'مصروف'
          WHEN 'invoice_cash'     THEN 'مبيعات كاش'
          WHEN 'invoice_refund'   THEN 'مرتجع'
          WHEN 'opening_balance'  THEN 'رصيد افتتاحي'
          WHEN 'owner_topup'      THEN 'تمويل من المالك'
          WHEN 'bank_deposit'     THEN 'إيداع بنكي'
          WHEN 'manual_deposit'   THEN 'إيداع يدوي'
          WHEN 'manual_withdraw'  THEN 'سحب يدوي'
          WHEN 'adjustment'       THEN 'تسوية'
          WHEN 'payment'          THEN 'دفعة'
          WHEN 'receipt'          THEN 'سند قبض'
          WHEN 'purchase'         THEN 'شراء'
          ELSE COALESCE(t.category, 'أخرى')
        END AS kind_ar,
        COALESCE(
          (SELECT i.invoice_no FROM invoices i WHERE i.id = t.reference_id),
          (SELECT e.expense_no FROM expenses e WHERE e.id = t.reference_id),
          (SELECT cp.payment_no FROM customer_payments cp WHERE cp.id = t.reference_id),
          (SELECT sp.payment_no FROM supplier_payments sp WHERE sp.id = t.reference_id),
          (SELECT p.purchase_no FROM purchases p WHERE p.id = t.reference_id)
        ) AS reference_no,
        COALESCE(
          (SELECT c.full_name FROM customers c
             JOIN customer_payments cp ON cp.customer_id = c.id
            WHERE cp.id = t.reference_id),
          (SELECT s.name FROM suppliers s
             JOIN supplier_payments sp ON sp.supplier_id = s.id
            WHERE sp.id = t.reference_id),
          (SELECT s.name FROM suppliers s
             JOIN purchases p ON p.supplier_id = s.id
            WHERE p.id = t.reference_id)
        ) AS counterparty_name
      FROM cashbox_transactions t
      LEFT JOIN cashboxes cb ON cb.id = t.cashbox_id
      LEFT JOIN users     u  ON u.id  = t.user_id
      ${whereOnT}
      ORDER BY t.created_at DESC
      LIMIT $${args.length - 1} OFFSET $${args.length}
      `,
      args,
    );
  }

  /**
   * Manually deposit or withdraw cash from a cashbox. Used for opening
   * balances, owner top-ups, bank deposits, etc. Accepts an optional
   * `txn_date` so backdated adjustments can be recorded (e.g. "this was
   * yesterday's opening float"). The balance update still happens now —
   * only the transaction timestamp is backdated, which is what reports
   * and cashflow views read.
   */
  async deposit(
    dto: {
      cashbox_id: string;
      direction: 'in' | 'out';
      amount: number;
      category?: string;
      notes?: string;
      txn_date?: string; // YYYY-MM-DD
    },
    userId: string,
  ) {
    if (!dto.amount || Number(dto.amount) <= 0) {
      throw new Error('amount must be positive');
    }
    if (dto.direction !== 'in' && dto.direction !== 'out') {
      throw new Error('direction must be in or out');
    }
    return this.ds.transaction(async (em) => {
      const [box] = await em.query(
        `SELECT current_balance FROM cashboxes WHERE id = $1 FOR UPDATE`,
        [dto.cashbox_id],
      );
      if (!box) throw new Error('cashbox not found');
      const delta = dto.direction === 'in' ? Number(dto.amount) : -Number(dto.amount);
      const newBalance = Number(box.current_balance || 0) + delta;

      // created_at: use supplied date at 10:00 Cairo, else now().
      const createdExpr = dto.txn_date
        ? `(($1::date) + TIME '10:00') AT TIME ZONE 'Africa/Cairo'`
        : `now()`;
      const createdParams = dto.txn_date ? [dto.txn_date] : [];

      const [txn] = await em.query(
        `
        INSERT INTO cashbox_transactions
          (cashbox_id, direction, amount, category,
           reference_type, balance_after, user_id, notes, created_at)
        VALUES ($${createdParams.length + 1}, $${createdParams.length + 2}::txn_direction,
                $${createdParams.length + 3}, $${createdParams.length + 4},
                'cashbox'::entity_type, $${createdParams.length + 5},
                $${createdParams.length + 6}, $${createdParams.length + 7},
                ${createdExpr})
        RETURNING id, amount, balance_after, created_at
        `,
        [
          ...createdParams,
          dto.cashbox_id,
          dto.direction,
          dto.amount,
          dto.category || (dto.direction === 'in' ? 'manual_deposit' : 'manual_withdraw'),
          newBalance,
          userId,
          dto.notes || null,
        ],
      );

      await em.query(
        `UPDATE cashboxes SET current_balance = $2, updated_at = now() WHERE id = $1`,
        [dto.cashbox_id, newBalance],
      );

      return { ...txn, new_balance: newBalance };
    });
  }
}
