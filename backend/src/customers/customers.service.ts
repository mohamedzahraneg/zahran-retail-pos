import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, ILike, Repository } from 'typeorm';
import { CustomerEntity } from './entities/customer.entity';

@Injectable()
export class CustomersService {
  constructor(
    @InjectRepository(CustomerEntity)
    private readonly repo: Repository<CustomerEntity>,
    private readonly ds: DataSource,
  ) {}

  async list(q?: string, page = 1, limit = 50) {
    const where: any = { is_active: true };
    if (q) where.full_name = ILike(`%${q}%`);
    const [data, total] = await this.repo.findAndCount({
      where,
      order: { created_at: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { data, meta: { page, limit, total } };
  }

  async findOne(id: string) {
    const c = await this.repo.findOne({ where: { id } });
    if (!c) throw new NotFoundException(`Customer ${id} not found`);
    return c;
  }

  create(body: Partial<CustomerEntity>) {
    return this.repo.save(this.repo.create(body));
  }

  async update(id: string, body: Partial<CustomerEntity>) {
    await this.repo.update(id, body);
    return this.findOne(id);
  }

  /** ledger entries (migration 014) */
  ledger(customerId: string) {
    return this.ds.query(
      `SELECT * FROM customer_ledger WHERE customer_id = $1 ORDER BY entry_date DESC, created_at DESC LIMIT 200`,
      [customerId],
    );
  }

  /** outstanding view (migration 014) */
  outstanding() {
    return this.ds.query(
      `SELECT
         c.id                                AS customer_id,
         c.id                                AS id,
         c.customer_no,
         c.full_name,
         c.phone,
         COALESCE(c.current_balance, 0)      AS current_balance,
         COALESCE(c.current_balance, 0)      AS outstanding,
         COALESCE(c.credit_limit, 0)         AS credit_limit,
         GREATEST(COALESCE(c.credit_limit, 0) - COALESCE(c.current_balance, 0), 0)
                                             AS available_credit,
         (SELECT MAX(cl.created_at)
            FROM customer_ledger cl
           WHERE cl.customer_id = c.id)      AS last_entry_at
       FROM customers c
       WHERE c.deleted_at IS NULL
       ORDER BY COALESCE(c.current_balance, 0) DESC`,
    );
  }

  /** unpaid invoices (for cash-desk allocation) */
  unpaidInvoices(customerId: string) {
    return this.ds.query(
      `
      SELECT
        i.id,
        i.invoice_no,
        i.completed_at,
        i.grand_total::numeric AS grand_total,
        i.paid_amount::numeric AS paid_amount,
        (i.grand_total::numeric - i.paid_amount::numeric) AS remaining,
        i.status
      FROM invoices i
      WHERE i.customer_id = $1
        AND i.status IN ('completed','partially_paid')
        AND (i.grand_total::numeric - i.paid_amount::numeric) > 0.009
      ORDER BY i.completed_at ASC
      LIMIT 100
      `,
      [customerId],
    );
  }
}
