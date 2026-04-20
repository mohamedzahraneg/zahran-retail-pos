import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, ILike, Repository } from 'typeorm';
import { ProductEntity } from './entities/product.entity';
import { VariantEntity } from './entities/variant.entity';
import {
  CreateProductDto,
  UpdateProductDto,
  CreateVariantDto,
  UpdateVariantDto,
} from './dto/product.dto';

export interface ProductFilters {
  type?: 'shoe' | 'bag' | 'accessory';
  q?: string;
  active?: boolean;
  page?: number;
  limit?: number;
  warehouse_id?: string;
}

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(ProductEntity)
    private readonly repo: Repository<ProductEntity>,
    @InjectRepository(VariantEntity)
    private readonly variants: Repository<VariantEntity>,
    private readonly ds: DataSource,
  ) {}

  async findAll(filters: ProductFilters = {}) {
    const page = Math.max(1, filters.page || 1);
    const limit = Math.min(200, filters.limit || 50);
    const where: any = {};
    if (filters.type) where.type = filters.type;
    if (filters.active !== undefined) where.is_active = filters.active;
    if (filters.q) where.name_ar = ILike(`%${filters.q}%`);

    const [data, total] = await this.repo.findAndCount({
      where,
      order: { created_at: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    // Attach aggregated stock qty + stock value to each product.
    let enriched: any[] = data;
    if (data.length > 0) {
      const ids = data.map((p) => p.id);
      const params: any[] = [ids];
      let sql = `
        SELECT v.product_id,
               SUM(COALESCE(s.quantity_on_hand, s.quantity, 0))::int AS total_stock,
               SUM(
                 COALESCE(s.quantity_on_hand, s.quantity, 0)
                 * COALESCE(
                     NULLIF(s.avg_cost, 0),
                     NULLIF(v.cost_price, 0),
                     NULLIF(v.selling_price, 0),
                     0
                   )
               )::numeric(14,2) AS stock_value,
               COUNT(DISTINCT v.id) FILTER (WHERE v.is_active) AS variants_count
          FROM product_variants v
          LEFT JOIN stock s ON s.variant_id = v.id`;
      if (filters.warehouse_id) {
        sql += ` AND s.warehouse_id = $2`;
        params.push(filters.warehouse_id);
      }
      sql += ` WHERE v.product_id = ANY($1) GROUP BY v.product_id`;
      const stockRows = await this.ds.query(sql, params);
      const stockMap = new Map<
        string,
        { total_stock: number; stock_value: number; variants_count: number }
      >();
      for (const r of stockRows) {
        stockMap.set(r.product_id, {
          total_stock: Number(r.total_stock || 0),
          stock_value: Number(r.stock_value || 0),
          variants_count: Number(r.variants_count || 0),
        });
      }
      enriched = data.map((p) => {
        const s = stockMap.get(p.id);
        return {
          ...p,
          total_stock: s?.total_stock ?? 0,
          stock_value: s?.stock_value ?? 0,
          variants_count: s?.variants_count ?? 0,
        };
      });
    }

    return {
      data: enriched,
      meta: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string) {
    const product = await this.repo.findOne({ where: { id } });
    if (!product) throw new NotFoundException(`Product ${id} not found`);
    const variants = await this.variants.find({ where: { product_id: id } });
    return { ...product, variants };
  }

  async findByBarcode(barcode: string) {
    const variant = await this.variants.findOne({ where: { barcode } });
    if (!variant) throw new NotFoundException(`Barcode ${barcode} not found`);
    const product = await this.repo.findOne({
      where: { id: variant.product_id },
    });
    return { product, variant };
  }

  create(dto: CreateProductDto) {
    const product = this.repo.create(dto);
    return this.repo.save(product);
  }

  async update(id: string, dto: UpdateProductDto) {
    await this.repo.update(id, dto);
    return this.findOne(id);
  }

  async remove(id: string) {
    await this.repo.update(id, { is_active: false });
    return { archived: true };
  }

  addVariant(dto: CreateVariantDto) {
    const v = this.variants.create(dto);
    return this.variants.save(v);
  }

  async updateVariant(id: string, dto: UpdateVariantDto) {
    const v = await this.variants.findOne({ where: { id } });
    if (!v) throw new NotFoundException(`Variant ${id} not found`);
    await this.variants.update(id, dto);
    return this.variants.findOne({ where: { id } });
  }

  async removeVariant(id: string) {
    await this.variants.update(id, { is_active: false });
    return { archived: true };
  }

  listVariants(productId: string) {
    return this.variants.find({
      where: { product_id: productId },
      order: { created_at: 'ASC' },
    });
  }

  /** Master color list (for UI pickers). */
  listColors() {
    return this.ds.query(
      `SELECT id, name_ar, name_en, hex_code FROM colors WHERE is_active = true ORDER BY name_ar`,
    );
  }

  /** Master size list (for UI pickers). */
  listSizes() {
    return this.ds.query(
      `SELECT id, size_label, size_system, sort_order FROM sizes
         WHERE is_active = true
         ORDER BY sort_order, size_label`,
    );
  }
}
