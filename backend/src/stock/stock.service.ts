import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { StockEntity } from './entities/stock.entity';
import { WarehouseEntity } from './entities/warehouse.entity';

@Injectable()
export class StockService {
  constructor(
    @InjectRepository(StockEntity)
    private readonly stock: Repository<StockEntity>,
    @InjectRepository(WarehouseEntity)
    private readonly warehouses: Repository<WarehouseEntity>,
    private readonly ds: DataSource,
  ) {}

  listWarehouses() {
    return this.warehouses.find({ where: { is_active: true } });
  }

  /**
   * All variants of a product joined with stock in the given warehouse.
   * Returns color/size/sku/cost/price plus quantity_on_hand (0 if no stock row).
   */
  async variantsWithStock(productId: string, warehouseId?: string) {
    return this.ds.query(
      `SELECT
         v.id                                           AS variant_id,
         v.product_id,
         v.sku,
         v.barcode,
         COALESCE(v.color, c.name_ar)                   AS color,
         COALESCE(v.size,  sz.size_label)               AS size,
         COALESCE(v.cost_price, p.base_cost, 0)::numeric   AS cost_price,
         COALESCE(v.selling_price, v.price_override, p.base_price, 0)::numeric AS selling_price,
         v.is_active,
         COALESCE(s.quantity_on_hand, s.quantity, 0)    AS quantity_on_hand,
         COALESCE(s.quantity_reserved, s.reserved_quantity, 0) AS quantity_reserved,
         COALESCE(s.reorder_point, 0)                   AS reorder_point
       FROM product_variants v
       LEFT JOIN products    p  ON p.id  = v.product_id
       LEFT JOIN colors      c  ON c.id  = v.color_id
       LEFT JOIN sizes       sz ON sz.id = v.size_id
       LEFT JOIN stock       s  ON s.variant_id = v.id
         ${warehouseId ? 'AND s.warehouse_id = $2' : ''}
       WHERE v.product_id = $1 AND v.is_active = true
       ORDER BY color, size`,
      warehouseId ? [productId, warehouseId] : [productId],
    );
  }

  async getStockFor(variantId: string) {
    return this.stock
      .createQueryBuilder('s')
      .innerJoin(WarehouseEntity, 'w', 'w.id = s.warehouse_id')
      .select([
        's.id',
        's.variant_id',
        's.warehouse_id',
        's.quantity',
        's.reserved_quantity',
        's.reorder_quantity',
        's.avg_cost',
        'w.code',
        'w.name_ar',
      ])
      .where('s.variant_id = :variantId', { variantId })
      .getRawMany();
  }

  /**
   * Adjust stock via the `fn_adjust_stock` SQL function (migration 005/012)
   * Preserves audit trail + avg-cost recomputation.
   */
  async adjust(opts: {
    variant_id: string;
    warehouse_id: string;
    delta: number;
    reason: string;
    unit_cost?: number;
    user_id?: string;
  }) {
    if (!opts.delta || Number.isNaN(opts.delta)) {
      throw new BadRequestException('delta must be a non-zero number');
    }
    const [row] = await this.ds.query(
      `SELECT fn_adjust_stock($1, $2, $3, $4, $5, $6) AS new_qty`,
      [
        opts.variant_id,
        opts.warehouse_id,
        opts.delta,
        opts.reason,
        opts.unit_cost ?? null,
        opts.user_id ?? null,
      ],
    );
    return { new_qty: row.new_qty };
  }

  /**
   * Adjustments history — lists stock_movements where movement_type = 'adjustment'
   */
  async listAdjustments(params: {
    variant_id?: string;
    warehouse_id?: string;
    from?: string;
    to?: string;
    limit?: number;
  }) {
    const where: string[] = [`sm.movement_type = 'adjustment'`];
    const args: any[] = [];
    if (params.variant_id) {
      args.push(params.variant_id);
      where.push(`sm.variant_id = $${args.length}`);
    }
    if (params.warehouse_id) {
      args.push(params.warehouse_id);
      where.push(`sm.warehouse_id = $${args.length}`);
    }
    if (params.from) {
      args.push(params.from);
      where.push(`sm.created_at >= $${args.length}::date`);
    }
    if (params.to) {
      args.push(params.to);
      where.push(`sm.created_at <= $${args.length}::date + INTERVAL '1 day'`);
    }
    const limit = Math.min(Math.max(Number(params.limit) || 200, 1), 500);

    return this.ds.query(
      `
      SELECT sm.id,
             sm.variant_id,
             sm.warehouse_id,
             sm.direction,
             sm.quantity,
             sm.unit_cost,
             sm.notes,
             sm.user_id,
             sm.created_at,
             pv.sku,
             p.name_ar AS product_name,
             w.code AS warehouse_code,
             w.name_ar AS warehouse_name,
             u.full_name AS user_name
        FROM stock_movements sm
        LEFT JOIN product_variants pv ON pv.id = sm.variant_id
        LEFT JOIN products p ON p.id = pv.product_id
        LEFT JOIN warehouses w ON w.id = sm.warehouse_id
        LEFT JOIN users u ON u.id = sm.user_id
       WHERE ${where.join(' AND ')}
       ORDER BY sm.created_at DESC
       LIMIT ${limit}
      `,
      args,
    );
  }

  /** Low-stock view (migration 015) */
  lowStock() {
    return this.ds.query(
      `SELECT * FROM v_dashboard_low_stock ORDER BY shortage DESC LIMIT 100`,
    );
  }

  /** Smart reorder suggestions (migration 015) */
  reorderSuggestions() {
    return this.ds.query(
      `SELECT * FROM v_smart_reorder_suggestions ORDER BY urgency DESC LIMIT 100`,
    );
  }

  /** Dead stock (not sold in 60+ days) */
  deadStock() {
    return this.ds.query(
      `SELECT * FROM v_smart_dead_stock ORDER BY days_since_last_sale DESC LIMIT 100`,
    );
  }

  /** Loss warnings (selling below cost) */
  lossWarnings() {
    return this.ds.query(
      `SELECT * FROM v_smart_loss_warnings ORDER BY loss_amount DESC LIMIT 100`,
    );
  }
}
