import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  CreatePaymentAccountDto,
  UpdatePaymentAccountDto,
} from './dto/payment-account.dto';
import { PAYMENT_PROVIDERS } from './providers.catalog';
import { sanitizeUuidInput } from '../common/uuid-or-null';

/**
 * PR-PAY-1 — payment_accounts CRUD + provider catalog facade.
 *
 * Validation that lives in the DB triggers (gl code must exist,
 * method/account consistency on invoice_payments) is treated as
 * authoritative — this service translates trigger errors into
 * BadRequestException with a clear Arabic-friendly message.
 */
/**
 * PR-FIN-PAYACCT-4A — service-level rule mapping a payment_method to the
 * cashbox.kind it can be pinned to. Used by `validateCashboxKindMatch()`
 * when the operator passes `cashbox_id` on create/update.
 *
 * Cash methods don't appear in payment_accounts in practice (cash flows
 * directly through the shift's cashbox without a payment_account row),
 * but we still allow `cash → cash` for completeness.
 */
const METHOD_TO_CASHBOX_KIND: Record<string, string> = {
  cash: 'cash',
  card_visa: 'bank',
  card_mastercard: 'bank',
  card_meeza: 'bank',
  bank_transfer: 'bank',
  instapay: 'ewallet',
  wallet: 'ewallet',
  vodafone_cash: 'ewallet',
  orange_cash: 'ewallet',
  // PR-FIN-PAYACCT-4B — cheque accounts route to cashboxes.kind='check'.
  check: 'check',
  // 'credit' and 'other' don't map to a physical cashbox — caller must
  // not pass cashbox_id with them. The validator throws.
};

@Injectable()
export class PaymentsService {
  constructor(private readonly ds: DataSource) {}

  // ── Provider catalog (static) ────────────────────────────────────
  listProviders() {
    return PAYMENT_PROVIDERS;
  }

  /**
   * PR-FIN-PAYACCT-4A — validate that an optional cashbox_id (a) exists,
   * and (b) has a kind that matches the method group. Returns the
   * cashbox row when valid; throws BadRequestException otherwise.
   * Pass `null`/`undefined` to short-circuit (no validation).
   */
  private async validateCashboxKindMatch(
    cashboxId: string | null | undefined,
    method: string,
    em?: { query(sql: string, p?: any[]): Promise<any[]> },
  ): Promise<{ id: string; kind: string } | null> {
    if (!cashboxId) return null;
    const runner = em ?? this.ds;
    const [row] = await runner.query(
      `SELECT id, kind::text AS kind FROM cashboxes WHERE id = $1`,
      [cashboxId],
    );
    if (!row) {
      throw new NotFoundException(
        `الخزنة المرتبطة (cashbox_id = ${cashboxId}) غير موجودة.`,
      );
    }
    const expected = METHOD_TO_CASHBOX_KIND[method];
    if (!expected) {
      throw new BadRequestException(
        `لا يمكن ربط حساب طريقة الدفع "${method}" بخزنة فيزيائية.`,
      );
    }
    if (row.kind !== expected) {
      throw new BadRequestException(
        `الخزنة من نوع "${row.kind}" غير متوافقة مع طريقة الدفع "${method}". ` +
          `المتوقع: نوع "${expected}".`,
      );
    }
    return row;
  }

  // ── Payment accounts ─────────────────────────────────────────────
  async list(filter: { method?: string; active?: string }) {
    const where: string[] = [];
    const args: any[] = [];
    if (filter.method) {
      args.push(filter.method);
      where.push(`method = $${args.length}::payment_method_code`);
    }
    if (typeof filter.active !== 'undefined') {
      args.push(filter.active === 'true' || filter.active === '1');
      where.push(`active = $${args.length}`);
    }
    const sql = `
      SELECT id, method::text AS method, provider_key, display_name, identifier,
             gl_account_code, cashbox_id, is_default, active, sort_order, metadata,
             created_at, updated_at, created_by, updated_by
        FROM payment_accounts
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY method, sort_order, display_name
    `;
    return this.ds.query(sql, args);
  }

  /**
   * PR-FIN-PAYACCT-4B — list each payment_account with its running
   * balance from `v_payment_account_balance` (mig 121 of PR-4A). Used
   * by the new admin page's KPI cards + per-row balance column +
   * bottom summary chart. Read-only.
   *
   * Returns one row per ACTIVE payment_account by default. Pass
   * `?active=false` to include deactivated accounts (the view itself
   * filters to active=TRUE — for inactive rows we fall through to a
   * left-join so the FE can still display them with `je_count=0`).
   */
  /**
   * PR-FIN-PAYACCT-4D — read-only wrapper over `v_dashboard_payment_mix_30d`.
   *
   * The view ships per-method usage for the trailing 30 days
   * (transactions / total_amount / pct). The FE renders this on the
   * unified treasury page's "أكثر الطرق استخدامًا آخر 30 يوم" card.
   *
   * Today the view's window is hard-coded at 30 days (see migration
   * that created it); the `days` query param is accepted for forward
   * compatibility but ignored when not 30 — we surface the view as-is
   * without trying to re-aggregate (which would fork the source of
   * truth). If `days != 30` is passed, we still return the 30-day mix;
   * the caller can show "آخر 30 يوم" copy regardless.
   */
  async methodMix(_days = 30) {
    const sql = `
      SELECT payment_method::text       AS payment_method,
             COALESCE(transactions, 0)  AS transactions,
             COALESCE(total_amount, 0)::numeric AS total_amount,
             COALESCE(pct, 0)::numeric  AS pct
        FROM v_dashboard_payment_mix_30d
       ORDER BY total_amount DESC NULLS LAST, payment_method
    `;
    return this.ds.query(sql);
  }

  /**
   * PR-FIN-PAYACCT-4D-UX-FIX-2 — `listBalances` semantics overhaul.
   *
   * Previous behavior (PR-4B): joined `v_payment_account_balance`,
   * which aggregates by `gl_account_code` (and optionally `cashbox_id`).
   * When N accounts shared the same GL with `cashbox_id IS NULL`, the
   * view returned the SAME bucket total for all N rows — misleading.
   *
   * New behavior: aggregate strictly per `payment_account_id` by
   * unioning the three account-tagged source tables:
   *   - invoice_payments  (POS sales)
   *   - customer_payments (receipts; refunds flip to amount_out)
   *   - supplier_payments (supplier disbursements)
   *
   * Refund handling: customer_payments with `kind='refund_out'` count
   * as money OUT of the account (the operator returned cash to the
   * customer through this account). All other kinds = money IN.
   *
   * NOTE on the enum literal: the column is the `party_payment_kind`
   * Postgres enum whose member names are `refund_in` / `refund_out`
   * (no bare `refund`). PR-FIN-PAYACCT-4D-UX-FIX-2 shipped this
   * compare with `'refund'` which Postgres rejects at query time
   * ("invalid input value for enum"). This commit corrects the
   * literal to `'refund_out'` so the endpoint actually runs.
   *
   * Void handling: rows with `is_void=true` are excluded from totals
   * AND from the count. invoice_payments has no void column so all of
   * its rows count.
   *
   * Result: each row's `total_in / total_out / net_debit / je_count /
   * last_movement` is strictly account-specific. Vodafone Cash with no
   * tagged rows correctly returns 0/0/0/0/null. The shared-GL bucket
   * total is still available via `v_payment_account_balance` for
   * callers that explicitly want it (we left that view intact).
   *
   * Read-only: pure SELECT. No DDL. No mutations.
   */
  async listBalances(filter: { method?: string; active?: string } = {}) {
    const where: string[] = [];
    const args: any[] = [];
    let methodArgIdx: number | null = null;
    if (filter.method) {
      args.push(filter.method);
      methodArgIdx = args.length;
      where.push(`pa.method = $${methodArgIdx}::payment_method_code`);
    }
    if (typeof filter.active !== 'undefined') {
      args.push(filter.active === 'true' || filter.active === '1');
      where.push(`pa.active = $${args.length}`);
    }

    /*
     * PR-FIN-PAYACCT-4D-UX-FIX-8 — synthetic "unattached" rows.
     *
     * The page-level "detailed payment-method report" shows
     * `invoice_payments` grouped by `(payment_method, payment_account_id)`,
     * including a row where `payment_account_id IS NULL` (3 InstaPay
     * payments from before payment_accounts were seeded, totalling
     * 1,050 EGP in production). The /cashboxes treasury page only
     * surfaced rows from registered `payment_accounts`, so the
     * unattached money was invisible — operators couldn't see they had
     * 1,050 EGP of InstaPay receipts not linked to any account.
     *
     * Fix: UNION ALL with a per-`(payment_method)` aggregation of
     * `invoice_payments WHERE payment_account_id IS NULL`. The synthetic
     * row carries a sentinel `payment_account_id` of `unattached:<method>`
     * so the FE can render it visually distinct (no edit / delete /
     * set-default actions; clear "غير مرتبط" label) and so cache
     * invalidation can ignore it.
     *
     * Customer/supplier payments are usually attached (the new flows
     * require it); we'd surface their unattached aggregates the same
     * way if/when they appear, but for now invoice_payments is the
     * only source with historical NULL `payment_account_id` rows.
     *
     * Read-only: pure SELECT + UNION ALL. No DDL. No mutations.
     */
    const sql = `
      WITH attached_balances AS (
      SELECT pa.id::text                        AS payment_account_id,
             pa.method::text                    AS method,
             pa.provider_key,
             pa.display_name,
             pa.identifier,
             pa.gl_account_code,
             pa.cashbox_id::text                AS cashbox_id,
             pa.is_default,
             pa.active,
             pa.sort_order,
             pa.metadata,
             -- PR-FIN-PAYACCT-4D-UX-FIX-8-HOTFIX-1 — explicit ::text casts
             -- so the UNION ALL with unattached_balances (which uses
             -- NULL::text for both) matches types. Postgres cannot auto-
             -- coerce normal_balance enum (USER-DEFINED) plus text, and
             -- production threw "UNION types normal_balance and text
             -- cannot be matched" opening /cashboxes after PR #210.
             coa.name_ar::text                  AS gl_name_ar,
             coa.normal_balance::text           AS normal_balance,
             COALESCE(agg.total_in, 0)::numeric  AS total_in,
             COALESCE(agg.total_out, 0)::numeric AS total_out,
             (COALESCE(agg.total_in, 0) - COALESCE(agg.total_out, 0))::numeric AS net_debit,
             COALESCE(agg.movement_count, 0)::int AS je_count,
             agg.last_movement::date            AS last_movement,
             FALSE                              AS is_unattached
        FROM payment_accounts pa
        LEFT JOIN chart_of_accounts coa ON coa.code = pa.gl_account_code
        LEFT JOIN LATERAL (
          SELECT
            SUM(amount_in)   AS total_in,
            SUM(amount_out)  AS total_out,
            COUNT(*)         AS movement_count,
            MAX(occurred_at) AS last_movement
          FROM (
            SELECT amount AS amount_in, 0::numeric AS amount_out, created_at AS occurred_at
              FROM invoice_payments
             WHERE payment_account_id = pa.id
            UNION ALL
            SELECT CASE WHEN kind = 'refund_out' THEN 0::numeric ELSE amount END,
                   CASE WHEN kind = 'refund_out' THEN amount      ELSE 0::numeric END,
                   created_at
              FROM customer_payments
             WHERE payment_account_id = pa.id
               AND COALESCE(is_void, FALSE) = FALSE
            UNION ALL
            SELECT 0::numeric, amount, created_at
              FROM supplier_payments
             WHERE payment_account_id = pa.id
               AND COALESCE(is_void, FALSE) = FALSE
          ) m
        ) agg ON TRUE
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ),
      unattached_balances AS (
        SELECT
          'unattached:' || ip.payment_method::text AS payment_account_id,
          ip.payment_method::text                  AS method,
          NULL::text                               AS provider_key,
          'غير مرتبط بحساب دفع'                    AS display_name,
          NULL::text                               AS identifier,
          -- Method-default GL — same mapping the FE uses for new accounts.
          CASE
            WHEN ip.payment_method::text = 'cash'                              THEN '1111'
            WHEN ip.payment_method::text IN ('card_visa','card_mastercard','card_meeza','bank_transfer')
                                                                               THEN '1113'
            WHEN ip.payment_method::text IN ('instapay','wallet','vodafone_cash','orange_cash')
                                                                               THEN '1114'
            WHEN ip.payment_method::text = 'check'                             THEN '1115'
            ELSE '1111'
          END                                      AS gl_account_code,
          NULL::text                               AS cashbox_id,
          FALSE                                    AS is_default,
          TRUE                                     AS active,
          -- Sort to top of each method group — the operator should see
          -- unattached money first.
          -1                                       AS sort_order,
          '{}'::jsonb                              AS metadata,
          NULL::text                               AS gl_name_ar,
          NULL::text                               AS normal_balance,
          SUM(ip.amount)::numeric                  AS total_in,
          0::numeric                               AS total_out,
          SUM(ip.amount)::numeric                  AS net_debit,
          COUNT(*)::int                            AS je_count,
          MAX(ip.created_at)::date                 AS last_movement,
          TRUE                                     AS is_unattached
        FROM invoice_payments ip
        WHERE ip.payment_account_id IS NULL
          ${methodArgIdx ? `AND ip.payment_method = $${methodArgIdx}::payment_method_code` : ''}
        GROUP BY ip.payment_method
      )
      SELECT * FROM attached_balances
      UNION ALL
      SELECT * FROM unattached_balances
      ORDER BY method, sort_order, display_name
    `;
    return this.ds.query(sql, args);
  }

  /**
   * PR-FIN-PAYACCT-4D-UX-FIX-2 — read-only feed of account-specific
   * operations for the DetailsPanel modal. Strictly filters by
   * `payment_account_id = :id`; never by `gl_account_code` alone (that
   * was the bug we're fixing). Reads from the three account-tagged
   * source tables, joins to `journal_entries` via reference_type +
   * reference_id, and to `customers` / `suppliers` / `users` /
   * `invoices` for human-readable labels.
   *
   * Filters:
   *   - from / to: ISO date range on `created_at`
   *   - type: 'invoice_payment' | 'customer_payment' | 'supplier_payment'
   *   - q: free-text over reference_no + counterparty_name
   *   - limit / offset: pagination (default limit 20, max 200)
   *
   * Returns: { rows, total, totals: { in, out, net, count } }
   *
   * SELECT-only. No mutations. No DDL.
   *
   * NOTE on column names (PR-4D-UX-FIX-2-HOTFIX-2 lesson): the
   * customer_payments / supplier_payments tables expose a
   * `payment_no` column (not `doc_no` — that's the FE-type alias
   * shape, NOT the DB column). The suppliers table exposes `name`
   * (not `name_ar`). The original commit shipped with the FE-type
   * names which Postgres rejected at query time. The aliases
   * `reference_no` and `counterparty_name` keep the FE response
   * shape stable while the SELECT references the real columns.
   */
  async listMovements(
    paymentAccountId: string,
    filter: {
      from?: string;
      to?: string;
      type?: string;
      q?: string;
      limit?: number;
      offset?: number;
    } = {},
  ) {
    const limit = Math.min(Math.max(filter.limit ?? 20, 1), 200);
    const offset = Math.max(filter.offset ?? 0, 0);
    const args: any[] = [paymentAccountId];
    const whereExtra: string[] = [];

    if (filter.from) {
      args.push(filter.from);
      whereExtra.push(`m.occurred_at::date >= $${args.length}::date`);
    }
    if (filter.to) {
      args.push(filter.to);
      whereExtra.push(`m.occurred_at::date <= $${args.length}::date`);
    }
    if (filter.type) {
      args.push(filter.type);
      whereExtra.push(`m.operation_type = $${args.length}`);
    }
    if (filter.q && filter.q.trim()) {
      args.push(`%${filter.q.trim().toLowerCase()}%`);
      whereExtra.push(
        `(LOWER(COALESCE(m.reference_no, '')) LIKE $${args.length}
          OR LOWER(COALESCE(m.counterparty_name, '')) LIKE $${args.length})`,
      );
    }

    // The CTE union is identical between the totals and the paged-rows
    // query — define it once and reuse.
    const baseCte = `
      WITH ops AS (
        SELECT
          ip.id::text                                  AS id,
          'invoice_payment'::text                      AS operation_type,
          'بيع'::text                                  AS operation_type_ar,
          ip.invoice_id::text                          AS reference_id,
          inv.invoice_no                               AS reference_no,
          ip.payment_account_id::text                  AS payment_account_id,
          ip.payment_method::text                      AS payment_method,
          ip.amount::numeric                           AS amount_in,
          0::numeric                                   AS amount_out,
          ip.amount::numeric                           AS net_amount,
          inv.customer_id::text                        AS counterparty_id,
          c.full_name                                  AS counterparty_name,
          ip.received_by::text                         AS user_id,
          u.username                                   AS user_name,
          je.id::text                                  AS journal_entry_id,
          je.entry_no                                  AS journal_entry_no,
          ip.created_at                                AS occurred_at,
          ip.notes                                     AS notes
        FROM invoice_payments ip
        LEFT JOIN invoices inv         ON inv.id = ip.invoice_id
        LEFT JOIN customers c          ON c.id = inv.customer_id
        LEFT JOIN users u              ON u.id = ip.received_by
        LEFT JOIN journal_entries je
               ON je.reference_type = 'invoice'
              AND je.reference_id = ip.invoice_id
              AND je.is_void = FALSE
        WHERE ip.payment_account_id = $1::uuid

        UNION ALL

        SELECT
          cp.id::text,
          'customer_payment'::text,
          'مقبوضة عميل'::text,
          cp.id::text,
          cp.payment_no,
          cp.payment_account_id::text,
          cp.payment_method::text,
          CASE WHEN cp.kind = 'refund_out' THEN 0::numeric ELSE cp.amount::numeric END,
          CASE WHEN cp.kind = 'refund_out' THEN cp.amount::numeric ELSE 0::numeric END,
          CASE WHEN cp.kind = 'refund_out' THEN -cp.amount::numeric ELSE cp.amount::numeric END,
          cp.customer_id::text,
          c.full_name,
          cp.received_by::text,
          u.username,
          je.id::text,
          je.entry_no,
          cp.created_at,
          cp.notes
        FROM customer_payments cp
        LEFT JOIN customers c          ON c.id = cp.customer_id
        LEFT JOIN users u              ON u.id = cp.received_by
        LEFT JOIN journal_entries je
               ON je.reference_type = 'customer_payment'
              AND je.reference_id = cp.id
              AND je.is_void = FALSE
        WHERE cp.payment_account_id = $1::uuid
          AND COALESCE(cp.is_void, FALSE) = FALSE

        UNION ALL

        SELECT
          sp.id::text,
          'supplier_payment'::text,
          'دفع مورد'::text,
          sp.id::text,
          sp.payment_no,
          sp.payment_account_id::text,
          sp.payment_method::text,
          0::numeric,
          sp.amount::numeric,
          (-sp.amount)::numeric,
          sp.supplier_id::text,
          s.name,
          sp.paid_by::text,
          u.username,
          je.id::text,
          je.entry_no,
          sp.created_at,
          sp.notes
        FROM supplier_payments sp
        LEFT JOIN suppliers s          ON s.id = sp.supplier_id
        LEFT JOIN users u              ON u.id = sp.paid_by
        LEFT JOIN journal_entries je
               ON je.reference_type = 'supplier_payment'
              AND je.reference_id = sp.id
              AND je.is_void = FALSE
        WHERE sp.payment_account_id = $1::uuid
          AND COALESCE(sp.is_void, FALSE) = FALSE
      ),
      filtered AS (
        SELECT * FROM ops m
        ${whereExtra.length ? 'WHERE ' + whereExtra.join(' AND ') : ''}
      )
    `;

    args.push(limit);
    const limitParamIdx = args.length;
    args.push(offset);
    const offsetParamIdx = args.length;

    const sql = `
      ${baseCte}
      SELECT
        (SELECT COUNT(*) FROM filtered)                                       AS total_count,
        (SELECT COALESCE(SUM(amount_in),  0)::numeric FROM filtered)          AS sum_in,
        (SELECT COALESCE(SUM(amount_out), 0)::numeric FROM filtered)          AS sum_out,
        (SELECT (COALESCE(SUM(amount_in),0) - COALESCE(SUM(amount_out),0))::numeric FROM filtered) AS sum_net,
        COALESCE(
          (SELECT json_agg(row_json ORDER BY occurred_at DESC)
             FROM (
               SELECT to_jsonb(p) AS row_json, p.occurred_at
                 FROM (
                   SELECT * FROM filtered
                   ORDER BY occurred_at DESC
                   LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx}
                 ) p
             ) j),
          '[]'::json
        ) AS rows;
    `;

    const [agg] = await this.ds.query(sql, args);
    return {
      rows: agg?.rows ?? [],
      total: Number(agg?.total_count ?? 0),
      totals: {
        in: agg?.sum_in ?? '0',
        out: agg?.sum_out ?? '0',
        net: agg?.sum_net ?? '0',
        count: Number(agg?.total_count ?? 0),
      },
    };
  }

  // PR-PAY-2 hotfix — `getById` accepts an optional EntityManager so
  // callers running inside a transaction (create / setDefault) can
  // read their own uncommitted writes. Without it the reader runs on
  // a different pooled connection that doesn't see the in-flight
  // INSERT/UPDATE → returns null → NotFoundException → transaction
  // rolls back → the operator sees "payment_account not found" AND
  // the row never persists.
  async getById(
    id: string,
    em?: { query(sql: string, p?: any[]): Promise<any[]> },
  ) {
    const runner = em ?? this.ds;
    const [row] = await runner.query(
      `SELECT id, method::text AS method, provider_key, display_name, identifier,
              gl_account_code, is_default, active, sort_order, metadata,
              created_at, updated_at, created_by, updated_by
         FROM payment_accounts WHERE id = $1`,
      [id],
    );
    if (!row) throw new NotFoundException('payment_account not found');
    return row;
  }

  async create(dto: CreatePaymentAccountDto, userId: string) {
    if (!dto.display_name?.trim()) {
      throw new BadRequestException('اسم العرض مطلوب.');
    }
    // is_default + active=false combination is invalid (the partial unique
    // index guards live rows; a defaulted-but-inactive account is dead
    // weight. Catch up front for a clear Arabic error.)
    if (dto.is_default && dto.active === false) {
      throw new BadRequestException(
        'لا يمكن تعيين حساب غير مفعل كافتراضي. فعّل الحساب أولاً.',
      );
    }
    // PR-FIN-PAYACCT-4D-UX-FIX-8 — defensive UUID sanitization. The
    // DTO already declares `@IsOptional() @IsUUID() cashbox_id`, but
    // we also accept null/empty/`"undefined"`/`"null"` from older FE
    // payload-builders that sometimes serialized a missing link as
    // the literal string. Normalize to null BEFORE
    // validateCashboxKindMatch reaches the SQL — otherwise a poisoned
    // value would explode as
    // `invalid input syntax for type uuid: "undefined"`.
    const safeCashboxId = sanitizeUuidInput(dto.cashbox_id);
    return this.ds.transaction(async (em) => {
      // PR-FIN-PAYACCT-4A: validate optional cashbox pin BEFORE the
      // INSERT so we don't leave a half-rolled-back row.
      await this.validateCashboxKindMatch(safeCashboxId, dto.method, em);

      // is_default uniqueness is enforced by the partial unique index
      // (method) WHERE is_default AND active. We let Postgres raise on
      // conflict and translate it.
      try {
        const [row] = await em.query(
          `INSERT INTO payment_accounts
             (method, provider_key, display_name, identifier, gl_account_code,
              cashbox_id, is_default, active, sort_order, metadata,
              created_by, updated_by)
           VALUES ($1::payment_method_code, $2, $3, $4, $5,
                   $6,
                   COALESCE($7,false), COALESCE($8,true), COALESCE($9,0),
                   COALESCE($10,'{}'::jsonb), $11, $11)
           RETURNING id`,
          [
            dto.method,
            dto.provider_key ?? null,
            dto.display_name,
            dto.identifier ?? null,
            dto.gl_account_code,
            safeCashboxId,
            dto.is_default ?? false,
            dto.active ?? true,
            dto.sort_order ?? 0,
            dto.metadata ? JSON.stringify(dto.metadata) : '{}',
            userId,
          ],
        );
        // Read through the same EntityManager so we see the row we
        // just inserted (read-committed isolation hides uncommitted
        // writes from other connections).
        return this.getById(row.id, em);
      } catch (err: any) {
        if (
          /ux_payment_accounts_default_per_method/.test(err?.detail || '') ||
          /ux_payment_accounts_default_per_method/.test(err?.message || '')
        ) {
          throw new ConflictException(
            'يوجد حساب افتراضي مفعل آخر لنفس وسيلة الدفع. ' +
              'قم بإلغاء افتراضيته أو ألغِ الافتراضي عن هذا الحساب.',
          );
        }
        if (/gl_account_code/.test(err?.message || '')) {
          throw new BadRequestException(err.message);
        }
        throw err;
      }
    });
  }

  async update(id: string, dto: UpdatePaymentAccountDto, userId: string) {
    if (dto.display_name !== undefined && !dto.display_name.trim()) {
      throw new BadRequestException('اسم العرض لا يمكن أن يكون فارغاً.');
    }
    // PR-FIN-PAYACCT-4D-UX-FIX-8 — defensive UUID sanitization. See
    // create() for the full rationale. The previous truthy check
    // `if (dto.cashbox_id)` would let the literal string `"undefined"`
    // through and explode at the SQL boundary inside
    // validateCashboxKindMatch.
    const cashboxIdProvided = dto.cashbox_id !== undefined;
    const safeCashboxId = sanitizeUuidInput(dto.cashbox_id);
    return this.ds.transaction(async (em) => {
      // If cashbox_id is being set (not just cleared with null), validate
      // it against the account's CURRENT method. We re-read the row to
      // get the method since the DTO doesn't carry it on update.
      if (safeCashboxId) {
        const [existing] = await em.query(
          `SELECT method::text AS method FROM payment_accounts WHERE id = $1`,
          [id],
        );
        if (!existing) throw new NotFoundException('payment_account not found');
        await this.validateCashboxKindMatch(safeCashboxId, existing.method, em);
      }

      const fields: string[] = [];
      const args: any[] = [];
      const push = (col: string, val: unknown) => {
        args.push(val);
        fields.push(`${col} = $${args.length}`);
      };
      if (dto.display_name !== undefined) push('display_name', dto.display_name);
      if (dto.identifier !== undefined) push('identifier', dto.identifier);
      if (dto.gl_account_code !== undefined)
        push('gl_account_code', dto.gl_account_code);
      if (dto.provider_key !== undefined) push('provider_key', dto.provider_key);
      if (dto.sort_order !== undefined) push('sort_order', dto.sort_order);
      if (dto.metadata !== undefined)
        push('metadata', JSON.stringify(dto.metadata));
      // PR-FIN-PAYACCT-4A: explicit `null` clears the pin; `undefined`
      // (field omitted) leaves it untouched.
      // PR-FIN-PAYACCT-4D-UX-FIX-8: a poisoned `"undefined"` / `"null"`
      // sentinel from the FE is treated as the operator's intent to
      // CLEAR the pin (sanitizeUuidInput → null), so we still write
      // null to the column.
      if (cashboxIdProvided) push('cashbox_id', safeCashboxId);
      if (!fields.length) return this.getById(id, em);

      args.push(userId);
      fields.push(`updated_by = $${args.length}`);
      args.push(id);

      try {
        await em.query(
          `UPDATE payment_accounts SET ${fields.join(', ')}
            WHERE id = $${args.length}`,
          args,
        );
      } catch (err: any) {
        if (/gl_account_code/.test(err?.message || '')) {
          throw new BadRequestException(err.message);
        }
        throw err;
      }
      return this.getById(id, em);
    });
  }

  async deactivate(id: string, userId: string) {
    await this.ds.query(
      `UPDATE payment_accounts
          SET active = FALSE, is_default = FALSE, updated_by = $2
        WHERE id = $1`,
      [id, userId],
    );
    return this.getById(id);
  }

  /**
   * PR-FIN-PAYACCT-4A — symmetric flip on the `active` flag. When
   * activating, leaves `is_default` alone (operator must call
   * `setDefault` explicitly to promote). When deactivating, force-clears
   * `is_default` so the partial unique index doesn't trip the next time
   * a new default is set on the same method.
   *
   * Idempotent: re-toggling produces a no-op semantic (just flips again).
   */
  async toggleActive(id: string, userId: string) {
    return this.ds.transaction(async (em) => {
      const [row] = await em.query(
        `SELECT active FROM payment_accounts WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!row) throw new NotFoundException('payment_account not found');
      const nextActive = !row.active;
      if (nextActive) {
        await em.query(
          `UPDATE payment_accounts
              SET active = TRUE, updated_by = $2
            WHERE id = $1`,
          [id, userId],
        );
      } else {
        await em.query(
          `UPDATE payment_accounts
              SET active = FALSE, is_default = FALSE, updated_by = $2
            WHERE id = $1`,
          [id, userId],
        );
      }
      return this.getById(id, em);
    });
  }

  /**
   * PR-FIN-PAYACCT-4A — safe delete with use-detection.
   *
   * If the account is referenced by any non-void invoice_payments,
   * customer_payments, or supplier_payments row, we fall back to a soft
   * delete (UPDATE active=FALSE, is_default=FALSE) so historical JEs +
   * snapshots stay readable. The FK on those tables is `ON DELETE SET
   * NULL`, but soft-delete preserves the explicit link AND the audit
   * trail.
   *
   * If the account is unused, we hard-delete the row.
   *
   * Returns `{ id, mode: 'soft' | 'hard' }` so the FE can render the
   * right Arabic message.
   */
  async deleteAccount(
    id: string,
    userId: string,
  ): Promise<{ id: string; mode: 'soft' | 'hard' }> {
    return this.ds.transaction(async (em) => {
      const [row] = await em.query(
        `SELECT id FROM payment_accounts WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!row) throw new NotFoundException('payment_account not found');

      // The three reference paths.
      const [{ usage_count }] = await em.query(
        `SELECT (
            (SELECT count(*) FROM invoice_payments  WHERE payment_account_id = $1)
          + (SELECT count(*) FROM customer_payments WHERE payment_account_id = $1)
          + (SELECT count(*) FROM supplier_payments WHERE payment_account_id = $1)
         )::int AS usage_count`,
        [id],
      );

      if (usage_count > 0) {
        // soft-delete: deactivate + clear default. The FE may need to
        // confirm with the operator before this branch — but the
        // service is idempotent, so a re-call is harmless.
        await em.query(
          `UPDATE payment_accounts
              SET active = FALSE, is_default = FALSE, updated_by = $2
            WHERE id = $1`,
          [id, userId],
        );
        return { id, mode: 'soft' as const };
      }

      // hard-delete: row has never been used, no historical state to
      // preserve. The metadata + sort_order live with the row, so a
      // delete is clean.
      await em.query(`DELETE FROM payment_accounts WHERE id = $1`, [id]);
      return { id, mode: 'hard' as const };
    });
  }

  async setDefault(id: string, userId: string) {
    return this.ds.transaction(async (em) => {
      const [row] = await em.query(
        `SELECT method, active FROM payment_accounts WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!row) throw new NotFoundException('payment_account not found');
      if (!row.active) {
        throw new BadRequestException(
          'لا يمكن جعل حساب غير مفعل افتراضياً. قم بتفعيله أولاً.',
        );
      }
      // Clear any prior default on this method, then promote `id`.
      await em.query(
        `UPDATE payment_accounts
            SET is_default = FALSE, updated_by = $2
          WHERE method = $1 AND is_default = TRUE AND id <> $3`,
        [row.method, userId, id],
      );
      await em.query(
        `UPDATE payment_accounts
            SET is_default = TRUE, updated_by = $2
          WHERE id = $1`,
        [id, userId],
      );
      // Same hotfix as create(): read inside the same transaction so
      // the just-flipped is_default is visible.
      return this.getById(id, em);
    });
  }

  /**
   * Resolve an account for posting. Returns null if the account_id is
   * absent (caller falls back to method default) or if the account
   * was hard-deleted (shouldn't happen — we deactivate, not delete).
   */
  async resolveForPosting(
    accountId: string | null | undefined,
    em?: { query(sql: string, p?: any[]): Promise<any[]> },
  ): Promise<{
    id: string;
    method: string;
    display_name: string;
    provider_key: string | null;
    identifier: string | null;
    gl_account_code: string;
    /**
     * PR-FIN-PAYACCT-4A — optional pin to a physical cashbox so the
     * customer/supplier payment posting (PR-FIN-PAYACCT-4C) can tag
     * the cash leg of the JE on this cashbox even when the account
     * lives on a shared GL code.
     */
    cashbox_id: string | null;
    /** PR-PAY-7 — operator-uploaded data URL or pasted URL, frozen
     *  into the snapshot so receipts render the right brand offline. */
    metadata: Record<string, unknown> | null;
  } | null> {
    if (!accountId) return null;
    const runner = em ?? this.ds;
    const [row] = await runner.query(
      `SELECT id, method::text AS method, provider_key, display_name,
              identifier, gl_account_code, cashbox_id, metadata
         FROM payment_accounts WHERE id = $1`,
      [accountId],
    );
    return row ?? null;
  }
}
