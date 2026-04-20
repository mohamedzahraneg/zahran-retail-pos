import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity({ name: 'warehouses' })
export class WarehouseEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 32, unique: true })
  code: string;

  @Column({ type: 'varchar', length: 150 })
  name_ar: string;

  @Column({ type: 'varchar', length: 150, nullable: true })
  name_en: string;

  @Column({ type: 'varchar', length: 32 })
  type: 'main' | 'branch' | 'virtual';

  @Column({ type: 'boolean', default: true })
  is_active: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at: Date;
}
