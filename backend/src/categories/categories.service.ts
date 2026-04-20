import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface CreateCategoryDto {
  name_ar: string;
  name_en?: string;
  parent_id?: string | null;
  slug?: string;
  icon?: string;
  sort_order?: number;
}

export type UpdateCategoryDto = Partial<CreateCategoryDto> & {
  is_active?: boolean;
};

@Injectable()
export class CategoriesService {
  constructor(private readonly ds: DataSource) {}

  /** All categories with product count. */
  list() {
    return this.ds.query(
      `SELECT c.id, c.parent_id, c.name_ar, c.name_en, c.slug, c.icon,
              c.sort_order, c.is_active,
              COUNT(p.id)::int AS products_count
         FROM categories c
         LEFT JOIN products p ON p.category_id = c.id AND p.is_active = true
         WHERE c.is_active = true
         GROUP BY c.id
         ORDER BY c.sort_order, c.name_ar`,
    );
  }

  async findOne(id: string) {
    const [row] = await this.ds.query(
      `SELECT * FROM categories WHERE id = $1`,
      [id],
    );
    if (!row) throw new NotFoundException(`Category ${id} not found`);
    return row;
  }

  async create(dto: CreateCategoryDto) {
    if (!dto.name_ar) throw new BadRequestException('الاسم العربي مطلوب');
    const [row] = await this.ds.query(
      `INSERT INTO categories (name_ar, name_en, parent_id, slug, icon, sort_order)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, 0))
       RETURNING *`,
      [
        dto.name_ar.trim(),
        dto.name_en?.trim() || null,
        dto.parent_id || null,
        dto.slug?.trim() || null,
        dto.icon?.trim() || null,
        dto.sort_order ?? null,
      ],
    );
    return row;
  }

  async update(id: string, dto: UpdateCategoryDto) {
    const fields: string[] = [];
    const params: any[] = [];
    let i = 1;
    const map: Record<string, any> = {
      name_ar: dto.name_ar,
      name_en: dto.name_en,
      parent_id: dto.parent_id,
      slug: dto.slug,
      icon: dto.icon,
      sort_order: dto.sort_order,
      is_active: dto.is_active,
    };
    for (const [k, v] of Object.entries(map)) {
      if (v === undefined) continue;
      fields.push(`${k} = $${i++}`);
      params.push(v);
    }
    if (!fields.length) return this.findOne(id);
    fields.push(`updated_at = NOW()`);
    params.push(id);
    const [row] = await this.ds.query(
      `UPDATE categories SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      params,
    );
    if (!row) throw new NotFoundException(`Category ${id} not found`);
    return row;
  }

  async remove(id: string) {
    const [row] = await this.ds.query(
      `UPDATE categories SET is_active = false, updated_at = NOW()
         WHERE id = $1 RETURNING id`,
      [id],
    );
    if (!row) throw new NotFoundException(`Category ${id} not found`);
    return { archived: true };
  }
}
