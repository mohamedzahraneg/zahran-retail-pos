import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { AccountingPostingService } from './posting.service';

export interface FixedAssetDto {
  name_ar: string;
  account_id: string;            // the COA account the asset sits in (e.g. 121)
  accum_dep_account_id?: string; // 123 by default
  cost: number;
  salvage_value?: number;
  useful_life_months: number;
  start_date: string;            // YYYY-MM-DD
  notes?: string;
}

/**
 * Fixed-asset schedule CRUD + the cron that posts monthly depreciation.
 *
 * Depreciation method: straight-line.
 *   monthly = (cost − salvage) / useful_life_months
 * The cron fires at 02:00 on the first of every month (Cairo). Each
 * schedule is only posted once per month (tracked via last_posted_month).
 */
@Injectable()
export class FixedAssetsService {
  private readonly logger = new Logger('FixedAssets');

  constructor(
    private readonly ds: DataSource,
    private readonly posting: AccountingPostingService,
  ) {}

  list() {
    return this.ds.query(
      `
      SELECT f.*,
             a.code   AS account_code,   a.name_ar   AS account_name,
             ad.code  AS accum_code,     ad.name_ar  AS accum_name
        FROM fixed_asset_schedules f
        LEFT JOIN chart_of_accounts a  ON a.id  = f.account_id
        LEFT JOIN chart_of_accounts ad ON ad.id = f.accum_dep_account_id
       ORDER BY f.is_active DESC, f.start_date DESC
      `,
    );
  }

  async create(dto: FixedAssetDto, userId: string) {
    if (!dto.name_ar?.trim()) throw new BadRequestException('اسم الأصل مطلوب');
    if (!(dto.cost > 0)) throw new BadRequestException('التكلفة يجب أن تكون موجبة');
    if (!(dto.useful_life_months > 0))
      throw new BadRequestException('العمر الإنتاجي يجب أن يكون موجباً');
    const [row] = await this.ds.query(
      `
      INSERT INTO fixed_asset_schedules
        (name_ar, account_id, accum_dep_account_id, cost, salvage_value,
         useful_life_months, start_date, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
      `,
      [
        dto.name_ar.trim(),
        dto.account_id,
        dto.accum_dep_account_id ?? null,
        dto.cost,
        dto.salvage_value ?? 0,
        dto.useful_life_months,
        dto.start_date,
        dto.notes ?? null,
        userId,
      ],
    );
    return row;
  }

  async update(id: string, dto: Partial<FixedAssetDto & { is_active: boolean }>) {
    const [existing] = await this.ds.query(
      `SELECT id FROM fixed_asset_schedules WHERE id = $1`,
      [id],
    );
    if (!existing) throw new NotFoundException('الأصل غير موجود');
    const sets: string[] = [];
    const args: any[] = [];
    const push = (col: string, val: any) => {
      args.push(val);
      sets.push(`${col} = $${args.length}`);
    };
    if (dto.name_ar !== undefined) push('name_ar', dto.name_ar);
    if (dto.account_id !== undefined) push('account_id', dto.account_id);
    if (dto.accum_dep_account_id !== undefined)
      push('accum_dep_account_id', dto.accum_dep_account_id);
    if (dto.cost !== undefined) push('cost', dto.cost);
    if (dto.salvage_value !== undefined) push('salvage_value', dto.salvage_value);
    if (dto.useful_life_months !== undefined)
      push('useful_life_months', dto.useful_life_months);
    if (dto.start_date !== undefined) push('start_date', dto.start_date);
    if (dto.notes !== undefined) push('notes', dto.notes);
    if (dto.is_active !== undefined) push('is_active', dto.is_active);
    if (!sets.length) return existing;
    sets.push('updated_at = NOW()');
    args.push(id);
    const [row] = await this.ds.query(
      `UPDATE fixed_asset_schedules SET ${sets.join(', ')}
        WHERE id = $${args.length} RETURNING *`,
      args,
    );
    return row;
  }

  remove(id: string) {
    return this.ds.query(
      `UPDATE fixed_asset_schedules SET is_active = FALSE, updated_at = NOW()
        WHERE id = $1`,
      [id],
    );
  }

  /** First of every month at 02:00 Cairo. */
  @Cron('0 2 1 * *', { timeZone: 'Africa/Cairo' })
  async monthlyCron() {
    this.logger.log('running monthly depreciation cron');
    try {
      const r = await this.posting.postMonthlyDepreciation('system');
      this.logger.log(`depreciation posted for ${r.posted_count} asset(s)`);
    } catch (err: any) {
      this.logger.error(
        `depreciation cron failed: ${err?.message ?? err}`,
      );
    }
  }
}
