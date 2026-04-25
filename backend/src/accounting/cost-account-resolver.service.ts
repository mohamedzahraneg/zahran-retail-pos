import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

/**
 * Sentinel error raised by `CostAccountResolver.resolve({ strict: true })`
 * when the supplied category is missing or its `account_id` is null.
 * Daily Expenses (PR-1) rejects the request with a 400 carrying the
 * Arabic message above; the controller layer catches this specifically.
 */
export class UnmappedCategoryError extends Error {
  constructor(public readonly categoryId: string | null) {
    super(
      'هذا البند غير مربوط بحساب محاسبي. اختر الحساب أولًا.',
    );
    this.name = 'UnmappedCategoryError';
  }
}

/**
 * CostAccountResolver — the ONE function for turning an expense's
 * category (or a free-form hint) into a concrete chart_of_accounts
 * leaf. Called by every expense-creation path; services MUST NOT
 * look up account codes inline anymore.
 *
 * Resolution order:
 *   1. Explicit `category_id` → `expense_categories.account_id`
 *      (seeded and kept in sync by migration 048 + 065)
 *   2. Free-form `hint` (e.g., 'electricity', 'rent') → canonical
 *      map below → COA code
 *   3. Fallback to 529 (مصروفات متفرقة / Miscellaneous)
 *
 * The service NEVER invents accounts, NEVER guesses, and NEVER
 * returns a non-leaf. It either returns a concrete COA `id` or
 * the 529 fallback. Callers pass the returned id to the engine.
 */
@Injectable()
export class CostAccountResolver {
  /**
   * Canonical mapping of free-form expense type hints → COA code.
   * Matches the seeds in migration 048 + the fix applied in 065
   * for `transport` (→ 525) and the existing category→COA links.
   */
  static readonly HINT_MAP: Record<string, string> = {
    // Fixed / payroll
    salaries:     '521',
    rent:         '522',
    // Utilities & operations
    electricity:  '523',
    utilities:    '523',
    water:        '523',
    telecom:      '524',
    internet:     '524',
    // Goods movement
    transport:    '525',
    shipping:     '525',
    // Marketing
    marketing:    '526',
    advertising:  '526',
    // Maintenance
    maintenance:  '527',
    repairs:      '527',
    // Office supplies
    supplies:     '528',
    stationery:   '528',
    // Financial
    bank_charges: '532',
    interest:     '532',
    // Default catch-alls
    misc:         '529',
    other:        '529',
    tax:          '529', // treated as expense; VAT payable goes to 214 via sales flow
  };

  /** Fallback account when resolution cannot match. */
  static readonly FALLBACK_CODE = '529';

  constructor(private readonly ds: DataSource) {}

  /**
   * Resolve an expense's GL account.
   *
   *   categoryId  — preferred: the DB-linked category → account_id
   *   hint        — fallback: a lowercase short label (e.g. 'rent').
   *                 Only consulted if categoryId is missing/unlinked.
   *   strict      — when true (Daily Expenses path, PR-1 of the
   *                 Daily Expenses series), refuse to fall through
   *                 to either the hint map OR the 529 catch-all.
   *                 The caller MUST supply a category whose
   *                 `account_id` is mapped explicitly. If 529 is the
   *                 desired account, admin must map the category to
   *                 it — no silent fallback.
   *
   * Returns a COA account UUID. In non-strict mode, the 529 fallback
   * is always returned as a last resort (seeded in migration 048).
   * In strict mode, throws `UnmappedCategoryError` when no explicit
   * category mapping is found.
   */
  async resolve(args: {
    category_id?: string | null;
    hint?: string | null;
    em?: EntityManager;
    strict?: boolean;
  }): Promise<{
    account_id: string;
    account_code: string;
    source: 'category' | 'hint' | 'fallback';
  }> {
    const runner = args.em ?? this.ds.manager;

    // 1. By category_id → category's linked account_id.
    if (args.category_id) {
      const [row] = await runner.query(
        `SELECT ec.account_id, a.code
           FROM expense_categories ec
           LEFT JOIN chart_of_accounts a ON a.id = ec.account_id
          WHERE ec.id = $1 AND ec.is_active = TRUE
            AND ec.account_id IS NOT NULL`,
        [args.category_id],
      );
      if (row?.account_id) {
        return { account_id: row.account_id, account_code: row.code, source: 'category' };
      }
    }

    // Strict mode (Daily Expenses): refuse to fall through. Admin
    // must map the category explicitly — silent 529 is forbidden.
    if (args.strict) {
      throw new UnmappedCategoryError(args.category_id ?? null);
    }

    // 2. Free-form hint → canonical map.
    if (args.hint) {
      const norm = args.hint.toLowerCase().trim();
      const code = CostAccountResolver.HINT_MAP[norm];
      if (code) {
        const [a] = await runner.query(
          `SELECT id, code FROM chart_of_accounts
            WHERE code = $1 AND is_active = TRUE AND is_leaf = TRUE LIMIT 1`,
          [code],
        );
        if (a?.id) {
          return { account_id: a.id, account_code: a.code, source: 'hint' };
        }
      }
    }

    // 3. Fallback — 529 Miscellaneous (always seeded).
    const [fb] = await runner.query(
      `SELECT id, code FROM chart_of_accounts
        WHERE code = $1 AND is_active = TRUE LIMIT 1`,
      [CostAccountResolver.FALLBACK_CODE],
    );
    if (!fb) {
      // Shouldn't happen — migration 048 seeds 529.
      throw new Error(
        `COA fallback account '${CostAccountResolver.FALLBACK_CODE}' missing — run migration 048`,
      );
    }
    return { account_id: fb.id, account_code: fb.code, source: 'fallback' };
  }

  /**
   * Return the current mapping table (categories + their linked
   * accounts). Used by the dashboard / audit to prove there's no
   * drift between category metadata and COA.
   */
  async listMappings() {
    return this.ds.query(
      `SELECT ec.id, ec.code AS category_code, ec.name_ar AS category_name,
              ec.is_active, ec.account_id IS NOT NULL AS linked,
              a.code AS coa_code, a.name_ar AS coa_name_ar,
              a.account_type, a.is_leaf
         FROM expense_categories ec
         LEFT JOIN chart_of_accounts a ON a.id = ec.account_id
        ORDER BY ec.code`,
    );
  }
}
