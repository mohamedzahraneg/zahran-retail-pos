import {
  Column,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'stock' })
export class StockEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  variant_id: string;

  @Column({ type: 'uuid' })
  warehouse_id: string;

  @Column({ type: 'int', default: 0 })
  quantity: number;

  @Column({ type: 'int', default: 0 })
  reserved_quantity: number;

  @Column({ type: 'int', default: 10, name: 'reorder_quantity' })
  reorder_quantity: number;

  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0 })
  avg_cost: number;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at: Date;
}
