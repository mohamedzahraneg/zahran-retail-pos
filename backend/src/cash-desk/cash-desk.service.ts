import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  CreateCustomerPaymentDto,
  CreateSupplierPaymentDto,
} from './dto/payment.dto';

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

  listCashboxes() {
    return this.ds.query(
      `SELECT *, name_ar AS name
         FROM cashboxes
        WHERE is_active = true
        ORDER BY name_ar`,
    );
  }

  cashflowToday() {
    return this.ds.query(
      `SELECT * FROM v_dashboard_cashflow_today`,
    );
  }
}
