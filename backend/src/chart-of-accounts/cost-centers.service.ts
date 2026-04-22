import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface CreateCostCenterDto {
  code: string;
  name_ar: string;
  name_en?: string;
  parent_id?: string;
  warehouse_id?: string;
}

@Injectable()
export class CostCentersService {
  constructor(private readonly ds: DataSource) {}

  async list(includeInactive = false) {
    const [exists] = await this.ds.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables
        WHERE table_name='cost_centers') AS present`,
    );
    if (!exists?.present) return [];
    return this.ds.query(
      `
      SELECT cc.*, w.name_ar AS warehouse_name,
             p.code AS parent_code, p.name_ar AS parent_name
        FROM cost_centers cc
        LEFT JOIN warehouses w  ON w.id  = cc.warehouse_id
        LEFT JOIN cost_centers p ON p.id = cc.parent_id
       ${includeInactive ? '' : 'WHERE cc.is_active = TRUE'}
       ORDER BY cc.code
      `,
    );
  }

  async create(dto: CreateCostCenterDto) {
    if (!dto.code?.trim() || !dto.name_ar?.trim()) {
      throw new BadRequestException('الكود والاسم مطلوبان');
    }
    const [row] = await this.ds.query(
      `INSERT INTO cost_centers (code, name_ar, name_en, parent_id, warehouse_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        dto.code.trim(),
        dto.name_ar.trim(),
        dto.name_en?.trim() ?? null,
        dto.parent_id ?? null,
        dto.warehouse_id ?? null,
      ],
    );
    return row;
  }

  async update(id: string, dto: Partial<CreateCostCenterDto> & { is_active?: boolean }) {
    const sets: string[] = [];
    const args: any[] = [];
    const push = (col: string, val: any) => {
      args.push(val);
      sets.push(`${col} = $${args.length}`);
    };
    if (dto.code !== undefined) push('code', dto.code);
    if (dto.name_ar !== undefined) push('name_ar', dto.name_ar);
    if (dto.name_en !== undefined) push('name_en', dto.name_en);
    if (dto.parent_id !== undefined) push('parent_id', dto.parent_id);
    if (dto.warehouse_id !== undefined) push('warehouse_id', dto.warehouse_id);
    if (dto.is_active !== undefined) push('is_active', dto.is_active);
    if (!sets.length) return this.get(id);
    sets.push('updated_at = NOW()');
    args.push(id);
    const [row] = await this.ds.query(
      `UPDATE cost_centers SET ${sets.join(', ')} WHERE id = $${args.length} RETURNING *`,
      args,
    );
    if (!row) throw new NotFoundException('مركز التكلفة غير موجود');
    return row;
  }

  async get(id: string) {
    const [row] = await this.ds.query(
      `SELECT * FROM cost_centers WHERE id = $1`,
      [id],
    );
    if (!row) throw new NotFoundException('مركز التكلفة غير موجود');
    return row;
  }

  async remove(id: string) {
    const [{ used }] = await this.ds.query(
      `SELECT COUNT(*)::int AS used FROM journal_lines WHERE cost_center_id = $1`,
      [id],
    );
    if (used > 0) {
      // Soft-delete when there's usage history.
      await this.ds.query(
        `UPDATE cost_centers SET is_active = FALSE, updated_at = NOW() WHERE id = $1`,
        [id],
      );
      return { soft_deleted: true, reason: 'has_journal_lines' };
    }
    await this.ds.query(`DELETE FROM cost_centers WHERE id = $1`, [id]);
    return { deleted: true };
  }
}
