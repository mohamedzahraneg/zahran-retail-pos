import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** Matches `product_variants` table */
@Entity({ name: 'product_variants' })
export class VariantEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  product_id: string;

  @Column({ type: 'uuid', nullable: true })
  color_id: string;

  @Column({ type: 'uuid', nullable: true })
  size_id: string;

  @Column({ type: 'varchar', length: 100, unique: true })
  sku: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  barcode: string;

  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true })
  price_override: number;

  @Column({ type: 'varchar', length: 100, nullable: true })
  color: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  size: string;

  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 })
  cost_price: number;

  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 })
  selling_price: number;

  @Column({ type: 'text', nullable: true })
  image_url: string | null;

  @Column({ type: 'boolean', default: true })
  is_active: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at: Date;
}
