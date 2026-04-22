import {
  Injectable,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { AccountingPostingService } from './posting.service';

export interface UpsertRateDto {
  currency: string; // ISO code (USD/EUR/SAR…)
  rate_date: string; // YYYY-MM-DD
  rate_to_egp: number;
  source?: string;
  notes?: string;
}

/**
 * Daily FX rates + monthly revaluation.
 *
 * Model: one rate per (currency, date). Rate_to_egp is "how many EGP
 * for 1 unit of the currency" — e.g. USD=50.5 means 1 USD = 50.5 EGP.
 *
 * Revaluation posts on the last day of the month (can be triggered
 * manually too):
 *   - For each cashbox whose currency ≠ EGP:
 *       balance_in_egp_now  = current_balance × rate_today
 *       balance_in_egp_book = running GL balance of the cashbox's
 *                             linked asset account
 *       diff = balance_in_egp_now − balance_in_egp_book
 *   - If diff > 0 →  DR asset, CR 424 FX Gain
 *   - If diff < 0 →  DR 536 FX Loss, CR asset
 *
 * Idempotent by (cashbox_id, month-end-date).
 */
@Injectable()
export class FxService {
  private readonly logger = new Logger('FX');

  constructor(
    private readonly ds: DataSource,
    private readonly posting: AccountingPostingService,
  ) {}

  async list(currency?: string, limit = 500) {
    const [exists] = await this.ds.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables
        WHERE table_name='currency_rates') AS present`,
    );
    if (!exists?.present) return [];
    const args: any[] = [];
    const conds: string[] = [];
    if (currency) {
      args.push(currency);
      conds.push(`currency = $${args.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    args.push(Math.min(limit, 2000));
    return this.ds.query(
      `SELECT r.*, u.full_name AS created_by_name
         FROM currency_rates r
         LEFT JOIN users u ON u.id = r.created_by
        ${where}
        ORDER BY rate_date DESC, currency
        LIMIT $${args.length}`,
      args,
    );
  }

  async upsert(dto: UpsertRateDto, userId: string) {
    if (!/^[A-Z]{3}$/.test(dto.currency)) {
      throw new BadRequestException('كود العملة يجب أن يكون 3 أحرف');
    }
    if (!(Number(dto.rate_to_egp) > 0)) {
      throw new BadRequestException('السعر يجب أن يكون موجباً');
    }
    const [row] = await this.ds.query(
      `INSERT INTO currency_rates
         (currency, rate_date, rate_to_egp, source, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (currency, rate_date) DO UPDATE SET
         rate_to_egp = EXCLUDED.rate_to_egp,
         source = EXCLUDED.source,
         notes = EXCLUDED.notes
       RETURNING *`,
      [
        dto.currency,
        dto.rate_date,
        dto.rate_to_egp,
        dto.source ?? null,
        dto.notes ?? null,
        userId,
      ],
    );
    return row;
  }

  async remove(id: string) {
    await this.ds.query(`DELETE FROM currency_rates WHERE id = $1`, [id]);
    return { deleted: true };
  }

  /** Look up the most recent rate on or before `date`. */
  async latestRate(currency: string, date: string): Promise<number | null> {
    const [r] = await this.ds.query(
      `SELECT rate_to_egp FROM currency_rates
        WHERE currency = $1 AND rate_date <= $2::date
        ORDER BY rate_date DESC LIMIT 1`,
      [currency, date],
    );
    return r ? Number(r.rate_to_egp) : null;
  }

  /**
   * Revalue every non-EGP cashbox against the rate on `as_of`.
   * Returns a list of what was posted.
   */
  async revalue(asOf: string, userId: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf))
      throw new BadRequestException('as_of must be YYYY-MM-DD');

    const cashboxes = await this.ds.query(
      `
      SELECT cb.id, cb.name_ar, cb.currency, cb.current_balance,
             (SELECT a.id FROM chart_of_accounts a
               WHERE a.cashbox_id = cb.id AND a.is_active = TRUE
               LIMIT 1) AS gl_account_id
        FROM cashboxes cb
       WHERE cb.is_active = TRUE
         AND cb.currency IS NOT NULL
         AND UPPER(cb.currency) <> 'EGP'
      `,
    );
    const results: any[] = [];

    for (const cb of cashboxes) {
      if (!cb.gl_account_id) {
        results.push({
          cashbox_id: cb.id,
          skipped: true,
          reason: 'no_gl_account',
        });
        continue;
      }
      const rate = await this.latestRate(cb.currency, asOf);
      if (!rate) {
        results.push({
          cashbox_id: cb.id,
          skipped: true,
          reason: `no_rate_for_${cb.currency}`,
        });
        continue;
      }

      // Book value = posted GL balance of the asset account.
      const [r] = await this.ds.query(
        `
        SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::numeric(14,2) AS book
          FROM journal_lines jl
          JOIN journal_entries je ON je.id = jl.entry_id
         WHERE jl.account_id = $1
           AND je.is_posted = TRUE AND je.is_void = FALSE
           AND je.entry_date <= $2::date
        `,
        [cb.gl_account_id, asOf],
      );
      const book = Number(r?.book || 0);
      const balanceFC = Number(cb.current_balance || 0);
      const targetEGP = balanceFC * rate;
      const diff = Number((targetEGP - book).toFixed(2));

      if (Math.abs(diff) < 0.01) {
        results.push({ cashbox_id: cb.id, skipped: true, reason: 'no_change' });
        continue;
      }

      const refId = `${cb.id}:${asOf}`;
      const posted = await this.postFxEntry(
        cb.id,
        cb.gl_account_id,
        diff,
        asOf,
        cb.name_ar,
        userId,
        refId,
      );
      results.push({
        cashbox_id: cb.id,
        name: cb.name_ar,
        currency: cb.currency,
        rate,
        balance_fc: balanceFC,
        target_egp: Number(targetEGP.toFixed(2)),
        book_egp: book,
        diff,
        posted,
        skipped: !posted,
      });
    }

    return { as_of: asOf, results };
  }

  /**
   * Minimal raw-SQL posting for FX revaluation. Bypasses the main
   * AccountingPostingService because the gain/loss leg doesn't fit its
   * existing shapes.
   */
  private async postFxEntry(
    cashboxId: string,
    assetAccountId: string,
    diff: number,
    entryDate: string,
    name: string,
    userId: string,
    refId: string,
  ) {
    try {
      // Idempotency
      const [existing] = await this.ds.query(
        `SELECT id FROM journal_entries
          WHERE reference_type = 'fx_revaluation' AND reference_id = $1
          LIMIT 1`,
        [refId],
      );
      if (existing) return false;

      const gainAcc = await this.accountIdByCode('424');
      const lossAcc = await this.accountIdByCode('536');
      if (!gainAcc || !lossAcc) return false;
      const abs = Math.abs(diff);
      const isGain = diff > 0;

      const [{ seq }] = await this.ds.query(
        `SELECT nextval('seq_journal_entry_no') AS seq`,
      );
      const entryNo = `JE-${entryDate.slice(0, 4)}-${String(seq).padStart(6, '0')}`;

      const [entry] = await this.ds.query(
        `
        INSERT INTO journal_entries
          (entry_no, entry_date, description, reference_type, reference_id,
           is_posted, posted_by, posted_at, created_by)
        VALUES ($1, $2, $3, 'fx_revaluation', $4, FALSE, $5, NULL, $5)
        RETURNING id
        `,
        [
          entryNo,
          entryDate,
          `إعادة تقييم عملة: ${name}`,
          refId,
          userId,
        ],
      );

      const debitLine = isGain
        ? { account_id: assetAccountId, debit: abs, credit: 0 }
        : { account_id: lossAcc,       debit: abs, credit: 0 };
      const creditLine = isGain
        ? { account_id: gainAcc,       debit: 0,   credit: abs }
        : { account_id: assetAccountId, debit: 0,   credit: abs };

      await this.ds.query(
        `INSERT INTO journal_lines
           (entry_id, line_no, account_id, debit, credit, description, cashbox_id)
         VALUES ($1,1,$2,$3,$4,$5,$6)`,
        [
          entry.id,
          debitLine.account_id,
          debitLine.debit,
          debitLine.credit,
          `فرق صرف ${name}`,
          cashboxId,
        ],
      );
      await this.ds.query(
        `INSERT INTO journal_lines
           (entry_id, line_no, account_id, debit, credit, description, cashbox_id)
         VALUES ($1,2,$2,$3,$4,$5,$6)`,
        [
          entry.id,
          creditLine.account_id,
          creditLine.debit,
          creditLine.credit,
          `فرق صرف ${name}`,
          cashboxId,
        ],
      );
      await this.ds.query(
        `UPDATE journal_entries SET is_posted = TRUE, posted_at = NOW() WHERE id = $1`,
        [entry.id],
      );
      return true;
    } catch (err: any) {
      this.logger.error(`fx post failed: ${err?.message ?? err}`);
      return false;
    }
  }

  private async accountIdByCode(code: string): Promise<string | null> {
    const [r] = await this.ds.query(
      `SELECT id FROM chart_of_accounts WHERE code = $1 AND is_active = TRUE LIMIT 1`,
      [code],
    );
    return r?.id ?? null;
  }

  /** Last day of every month, 03:00 Cairo. */
  @Cron('0 3 28-31 * *', { timeZone: 'Africa/Cairo' })
  async monthlyCron() {
    // Only run on the ACTUAL last day of the month.
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    if (now.getMonth() === tomorrow.getMonth()) return;

    const asOf = now.toISOString().slice(0, 10);
    this.logger.log(`running monthly FX revaluation for ${asOf}`);
    try {
      const r = await this.revalue(asOf, 'system');
      this.logger.log(
        `fx revaluation: ${r.results.filter((x) => x.posted).length} posted, ${
          r.results.filter((x) => x.skipped).length
        } skipped`,
      );
    } catch (err: any) {
      this.logger.error(`fx cron failed: ${err?.message ?? err}`);
    }
  }
}
