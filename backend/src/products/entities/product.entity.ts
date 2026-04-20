import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** Matches `products` table from migration 004_catalog.sql */
@Entity({ name: 'products' })
export class ProductEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 64, unique: true })
  sku_root: string;

  @Column({ type: 'varchar', length: 255 })
  name_ar: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  name_en: string;

  @Column({ type: 'varchar', length: 32 })
  type: 'shoe' | 'bag' | 'accessory';

  @Column({ type: 'uuid', nullable: true })
  brand_id: string;

  @Column({ type: 'uuid', nullable: true })
  category_id: string;

  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0 })
  base_price: number;

  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0 })
  cost_price: number;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'varchar', length: 20, default: 'piece' })
  uom: string;

  @Column({ type: 'uuid', nullable: true })
  supplier_id: string | null;

  @Column({ type: 'text', nullable: true })
  primary_image_url: string | null;

  @Column({ type: 'boolean', default: true })
  is_active: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at: Date;
}
