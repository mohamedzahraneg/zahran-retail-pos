import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'reservations' })
export class ReservationEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 30, unique: true })
  reservation_no: string;

  @Column({ type: 'uuid' })
  customer_id: string;

  @Column({ type: 'uuid' })
  warehouse_id: string;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status: 'active' | 'completed' | 'cancelled' | 'expired';

  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 })
  subtotal: number;

  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 })
  discount_amount: number;

  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 })
  total_amount: number;

  @Column({ type: 'numeric', precision: 5, scale: 2, default: 30 })
  deposit_required_pct: number;

  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 })
  paid_amount: number;

  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 })
  refunded_amount: number;

  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 })
  remaining_amount: number;

  @Column({ type: 'timestamptz', name: 'reserved_at' })
  reserved_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  expires_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  completed_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  cancelled_at: Date | null;

  @Column({ type: 'uuid', nullable: true })
  converted_invoice_id: string | null;

  @Column({ type: 'varchar', length: 20, default: 'partial' })
  refund_policy: 'full' | 'partial' | 'none';

  @Column({ type: 'numeric', precision: 5, scale: 2, default: 10 })
  cancellation_fee_pct: number;

  @Column({ type: 'text', nullable: true })
  cancellation_reason: string | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Column({ type: 'uuid', nullable: true })
  created_by: string | null;

  @Column({ type: 'uuid', nullable: true })
  completed_by: string | null;

  @Column({ type: 'uuid', nullable: true })
  cancelled_by: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at: Date;
}
