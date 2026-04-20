import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { UserEntity } from './entities/user.entity';
import { RoleEntity } from './entities/role.entity';

export interface UserWithRole extends UserEntity {
  role?: RoleEntity;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly usersRepo: Repository<UserEntity>,
    @InjectRepository(RoleEntity)
    private readonly rolesRepo: Repository<RoleEntity>,
  ) {}

  async findByUsername(username: string): Promise<UserWithRole | null> {
    const user = await this.usersRepo.findOne({ where: { username } });
    if (!user) return null;
    const role = user.role_id
      ? await this.rolesRepo.findOne({ where: { id: user.role_id } })
      : null;
    return { ...user, role } as UserWithRole;
  }

  async findById(id: string): Promise<UserWithRole> {
    const user = await this.usersRepo.findOne({ where: { id } });
    if (!user) throw new NotFoundException(`User ${id} not found`);
    const role = user.role_id
      ? await this.rolesRepo.findOne({ where: { id: user.role_id } })
      : null;
    return { ...user, role } as UserWithRole;
  }

  async findAll(): Promise<UserEntity[]> {
    return this.usersRepo.find({ order: { created_at: 'DESC' } });
  }

  async validatePassword(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }

  async hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, 12);
  }

  async recordLogin(id: string): Promise<void> {
    await this.usersRepo.update(id, {
      last_login_at: new Date(),
      failed_login_count: 0,
    });
  }

  async recordFailedLogin(id: string): Promise<void> {
    await this.usersRepo.increment({ id }, 'failed_login_count', 1);
  }

  async create(input: {
    username: string;
    password: string;
    full_name?: string;
    email?: string;
    phone?: string;
    role_id?: string;
    branch_id?: string;
  }): Promise<UserEntity> {
    const password_hash = await this.hashPassword(input.password);
    const user = this.usersRepo.create({
      username: input.username,
      password_hash,
      full_name: input.full_name,
      email: input.email,
      phone: input.phone,
      role_id: input.role_id,
      branch_id: input.branch_id,
    });
    return this.usersRepo.save(user);
  }

  async changePassword(id: string, newPassword: string): Promise<void> {
    const password_hash = await this.hashPassword(newPassword);
    await this.usersRepo.update(id, { password_hash });
  }

  async deactivate(id: string): Promise<void> {
    await this.usersRepo.update(id, { is_active: false });
  }

  async activate(id: string): Promise<void> {
    await this.usersRepo.update(id, { is_active: true });
  }

  async update(
    id: string,
    input: Partial<{
      full_name: string;
      email: string;
      phone: string;
      role_id: string;
      branch_id: string;
      is_active: boolean;
    }>,
  ): Promise<UserEntity> {
    const existing = await this.usersRepo.findOne({ where: { id } });
    if (!existing) throw new NotFoundException(`User ${id} not found`);
    await this.usersRepo.update(id, input);
    return this.findById(id);
  }

  async listRoles(): Promise<RoleEntity[]> {
    return this.rolesRepo.find({ order: { name_ar: 'ASC' } });
  }
}
