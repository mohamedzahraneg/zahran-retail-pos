import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'roles' })
export class RoleEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 64, unique: true })
  code: string;

  @Column({ type: 'varchar', length: 150 })
  name_ar: string;

  @Column({ type: 'varchar', length: 150, nullable: true })
  name_en: string;

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  permissions: string[];

  @Column({ type: 'boolean', default: true })
  is_active: boolean;
}
