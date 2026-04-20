import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity({ name: 'returns' })
export class ReturnEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 30, unique: true })
  return_no: string;

  @Column({ type: 'uuid' })
  original_invoice_id: string;

  @Column({ type: 'uuid', nullable: true })
  customer_id: string | null;

  @Column({ type: 'uuid' })
  warehouse_id: string;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status: 'pending' | 'approved' | 'refunded' | 'rejected';

  @Column({ type: 'varchar', length: 30, default: 'other' })
  reason:
    | 'defective'
    | 'wrong_size'
    | 'wrong_color'
    | 'customer_changed_mind'
    | 'not_as_described'
    | 'other';

  @Column({ type: 'text', nullable: true })
  reason_details: string | null;

  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 })
  total_refund: number;

  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 })
  restocking_fee: number;

  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 })
  net_refund: number;

  @Column({ type: 'varchar', length: 20, nullable: true })
  refund_method: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'requested_at' })
  requested_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  approved_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  refunded_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  rejected_at: Date | null;

  @Column({ type: 'uuid', nullable: true })
  requested_by: string | null;

  @Column({ type: 'uuid', nullable: true })
  approved_by: string | null;

  @Column({ type: 'uuid', nullable: true })
  refunded_by: string | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;
}
