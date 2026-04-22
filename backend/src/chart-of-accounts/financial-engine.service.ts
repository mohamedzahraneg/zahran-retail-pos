import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

/**
 * FinancialEngineService — the SINGLE primitive through which every money
 * mutation in the system must pass. Replaces the previous scattered
 * pattern where POS, expenses, cash-desk, shifts, returns, and reconciliation
 * each built journal entries and moved cash on their own (which led to the
 * drift bugs: doubled expenses, orphan supplier payments, unsynced shift
 * variance, fire-and-forget failures).
 *
 * ════════════════════════════════════════════════════════════════════════
 *   HARD INVARIANTS
 * ════════════════════════════════════════════════════════════════════════
 *
 *   1. Nobody else writes journal_entries / journal_lines directly. Every
 *      financial event calls `recordTransaction()`.
 *
 *   2. Nobody else calls `UPDATE cashboxes SET current_balance`. The only
 *      path that mutates a cashbox balance is via `fn_record_cashbox_txn`
 *      (the plpgsql function in migration 035) — and we are the only JS
 *      caller of it.
 *
 *   3. Reports read from the GL. `cashboxes.current_balance` is a DERIVED
 *      convenience column maintained by the cashbox-transactions ledger;
 *      it is never the source of truth.
 *
 *   4. Every `recordTransaction()` call is idempotent on
 *      (reference_type, reference_id). Retries never double-post. A
 *      voided entry does NOT block a re-post (so admin-triggered
 *      reversals-and-replay still work).
 *
 *   5. Cash moves and GL posts happen inside the SAME database
 *      transaction. If either half fails, neither is committed.
 *
 *   6. No fire-and-forget. Every call is awaited. If a caller genuinely
 *      wants to log-and-continue they can wrap in `.catch()` themselves,
 *      but the engine itself always returns a definitive result.
 *
 * ════════════════════════════════════════════════════════════════════════
 *   TRANSACTION KINDS
 * ════════════════════════════════════════════════════════════════════════
 *
 *   Each `kind` has a fixed accounting shape. Callers only supply the
 *   amounts + the cashbox — the engine resolves the account codes and
 *   builds the balanced entry.
 *
 *     sale              DR Cash/Receivables  · CR Sales + VAT + Inventory (COGS)
 *     refund            DR Sales Refund       · CR Cash (+ Inventory reversal)
 *     expense           DR Expense category   · CR Cash
 *     customer_payment  DR Cash               · CR Receivables (or Deposit liability)
 *     supplier_payment  DR Suppliers payable  · CR Cash
 *     shift_variance    DR Cash / Deficit     · CR Surplus / Cash
 *     opening_balance   DR Assets             · CR Liabilities + Capital (plug)
 *     cashbox_transfer  DR Dest cash          · CR Source cash
 *     manual_adjustment caller supplies lines verbatim
 *
 * ════════════════════════════════════════════════════════════════════════
 */

type QueryFn = (sql: string, params?: any[]) => Promise<any[]>;

export type TransactionKind =
  | 'sale'
  | 'refund'
  | 'expense'
  | 'customer_payment'
  | 'supplier_payment'
  | 'shift_variance'
  | 'opening_balance'
  | 'cashbox_transfer'
  | 'manual_adjustment';

/**
 * A single GL line. Exactly ONE of {debit, credit} must be > 0, the
 * other must be 0. Exactly ONE of {account_code, account_id, cashbox_id}
 * must be supplied to identify the account.
 */
export interface EngineGlLine {
  /** Resolve by COA code (e.g. "411" sales, "1131" inventory, "51" COGS). */
  account_code?: string;
  /** Or explicit account UUID when already resolved. */
  account_id?: string;
  /**
   * Or resolve by cashbox: the engine looks for an explicit
   * chart_of_accounts.cashbox_id match first, then falls back to the
   * cashbox's kind → default-code mapping (cash=1111, bank=1113,
   * ewallet=1114, check=1115).
   */
  resolve_from_cashbox_id?: string;

  debit?: number;
  credit?: number;

  /** Optional per-line narrative (defaults to entry description). */
  description?: string;
  /** Party tagging — powers customer/supplier ledger reports. */
  customer_id?: string;
  supplier_id?: string;
  warehouse_id?: string;
  cashbox_id?: string;
  cost_center_id?: string;
}

/**
 * A physical cash movement. Multiple movements can accompany one GL
 * entry (e.g. a cashbox_transfer has two). Each one is written via
 * fn_record_cashbox_txn which atomically INSERTs the ledger row AND
 * updates cashboxes.current_balance.
 */
export interface EngineCashMovement {
  cashbox_id: string;
  direction: 'in' | 'out';
  amount: number;
  /**
   * Free-form category for the cashbox_transactions row. Typical values:
   * sale, refund, receipt, payment, expense, opening_balance,
   * shift_variance, transfer_in, transfer_out, manual.
   */
  category: string;
  notes?: string;
}

export interface RecordTransactionSpec {
  kind: TransactionKind;

  /**
   * Idempotency key. Every replay of the same (reference_type,
   * reference_id) returns { skipped: true } with the original entry.
   */
  reference_type: string;
  reference_id: string;

  /** Document date. If omitted, today. */
  entry_date?: string;

  /** Human-readable narrative — shown on the journal list. */
  description: string;

  /** GL legs. Σ debits must equal Σ credits. */
  gl_lines: EngineGlLine[];

  /** Optional physical cash moves accompanying the GL entry. */
  cash_movements?: EngineCashMovement[];

  /** Who triggered this. Stored on journal_entries.created_by/posted_by. */
  user_id: string | null;

  /**
   * Caller-managed transaction. If supplied, everything runs inside it
   * (good for composing with the caller's own writes). If omitted, the
   * engine wraps its own transaction.
   */
  em?: EntityManager;
}

export type RecordTransactionResult =
  | {
      ok: true;
      skipped: true;
      entry_id: string;
      reason: 'idempotent-replay';
    }
  | {
      ok: true;
      entry_id: string;
      entry_no: string;
      cash_txn_ids: number[];
    }
  | {
      ok: false;
      error: string;
    };

@Injectable()
export class FinancialEngineService {
  private readonly logger = new Logger('FinancialEngine');

  constructor(private readonly ds: DataSource) {}

  // ══════════════════════════════════════════════════════════════════
  //   PUBLIC API — the single entry point
  // ══════════════════════════════════════════════════════════════════

  /**
   * The only method anyone in the codebase should call to produce a
   * financial side-effect. Runs atomically, is idempotent, and never
   * throws — returns { ok: false, error } instead so callers can decide
   * whether to surface to the user.
   */
  async recordTransaction(
    spec: RecordTransactionSpec,
  ): Promise<RecordTransactionResult> {
    try {
      this.validateSpec(spec);
    } catch (err: any) {
      this.logger.error(
        `spec rejected for ${spec.reference_type}/${spec.reference_id}: ${err?.message ?? err}`,
      );
      return { ok: false, error: err?.message ?? String(err) };
    }

    // When the caller gave us an EntityManager, stay inside it. Otherwise
    // we open our own transaction so the cash + GL halves are atomic.
    const run = async (em: EntityManager): Promise<RecordTransactionResult> => {
      const q: QueryFn = (sql, params) => em.query(sql, params);

      // ── Idempotency guard. Only LIVE entries block a replay; a voided
      //    entry is explicitly allowed to be superseded.
      const [existing] = await q(
        `SELECT id FROM journal_entries
          WHERE reference_type = $1 AND reference_id = $2
            AND is_posted = TRUE AND is_void = FALSE
          LIMIT 1`,
        [spec.reference_type, spec.reference_id],
      );
      if (existing) {
        return {
          ok: true,
          skipped: true,
          entry_id: existing.id,
          reason: 'idempotent-replay',
        };
      }

      // ── Phase 1 — move the physical cash. Do this first so an FX
      //    failure, insufficient-funds check, or row lock breaks fast
      //    before we write the GL side.
      const cashTxnIds: number[] = [];
      for (const mv of spec.cash_movements ?? []) {
        const txnId = await this.moveCash(q, spec, mv);
        cashTxnIds.push(txnId);
      }

      // ── Phase 2 — resolve accounts and build the GL entry.
      interface ResolvedLine {
        account_id: string;
        debit: number;
        credit: number;
        description: string;
        cashbox_id: string | null;
        warehouse_id: string | null;
        customer_id: string | null;
        supplier_id: string | null;
        cost_center_id: string | null;
      }
      const resolvedLines: ResolvedLine[] = [];
      for (const line of spec.gl_lines) {
        const accountId = await this.resolveAccount(q, line);
        if (!accountId) {
          throw new Error(
            `could not resolve GL account for line (code=${line.account_code}, cashbox=${line.resolve_from_cashbox_id})`,
          );
        }
        resolvedLines.push({
          account_id: accountId,
          debit: Number(line.debit || 0),
          credit: Number(line.credit || 0),
          description: line.description ?? spec.description,
          cashbox_id: line.cashbox_id ?? null,
          warehouse_id: line.warehouse_id ?? null,
          customer_id: line.customer_id ?? null,
          supplier_id: line.supplier_id ?? null,
          cost_center_id: line.cost_center_id ?? null,
        });
      }

      // ── Phase 3 — balance check. Belt-and-braces: the DB trigger
      //    fn_je_enforce_balance also enforces this on UPDATE is_posted.
      const sumD = resolvedLines.reduce((s, l) => s + l.debit, 0);
      const sumC = resolvedLines.reduce((s, l) => s + l.credit, 0);
      if (Math.abs(sumD - sumC) > 0.01) {
        throw new Error(
          `unbalanced ${spec.kind} ${spec.reference_type}/${spec.reference_id}: DR ${sumD.toFixed(2)} vs CR ${sumC.toFixed(2)}`,
        );
      }
      if (sumD < 0.01) {
        // Zero-value events are valid (e.g. approved expense of exactly 0)
        // but we skip the actual post to avoid cluttering the journal.
        return {
          ok: true,
          entry_id: '',
          entry_no: '',
          cash_txn_ids: cashTxnIds,
        };
      }

      // ── Phase 4 — insert header + lines, then flip is_posted. Split
      //    so the balance trigger validates against the real lines.
      const entryDate = spec.entry_date ?? this.today();
      const [{ seq }] = await q(
        `SELECT nextval('seq_journal_entry_no') AS seq`,
      );
      const entryNo = `JE-${entryDate.slice(0, 4)}-${String(seq).padStart(6, '0')}`;

      const [entry] = await q(
        `INSERT INTO journal_entries
           (entry_no, entry_date, description, reference_type, reference_id,
            is_posted, posted_by, posted_at, created_by)
         VALUES ($1, $2, $3, $4, $5, FALSE, $6, NOW(), $6)
         RETURNING id`,
        [
          entryNo,
          entryDate,
          spec.description,
          spec.reference_type,
          spec.reference_id,
          spec.user_id,
        ],
      );

      const hasPartyCols = await this.hasPartyColumns(q);
      let lineNo = 1;
      for (const l of resolvedLines) {
        if (l.debit === 0 && l.credit === 0) continue;

        if (hasPartyCols) {
          await q(
            `INSERT INTO journal_lines
               (entry_id, line_no, account_id, debit, credit, description,
                cashbox_id, warehouse_id, customer_id, supplier_id, cost_center_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [
              entry.id,
              lineNo++,
              l.account_id,
              l.debit,
              l.credit,
              l.description,
              l.cashbox_id,
              l.warehouse_id,
              l.customer_id,
              l.supplier_id,
              l.cost_center_id,
            ],
          );
        } else {
          // Pre-051 installs where party columns haven't been added yet.
          await q(
            `INSERT INTO journal_lines
               (entry_id, line_no, account_id, debit, credit, description,
                cashbox_id, warehouse_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              entry.id,
              lineNo++,
              l.account_id,
              l.debit,
              l.credit,
              l.description,
              l.cashbox_id,
              l.warehouse_id,
            ],
          );
        }
      }

      await q(
        `UPDATE journal_entries
            SET is_posted = TRUE, posted_at = NOW()
          WHERE id = $1`,
        [entry.id],
      );

      // ── Phase 5 — audit log (lightweight, append-only). Missing on
      //    pre-057 installs; the outer try catches and ignores the
      //    insert error so older deployments still work.
      try {
        await q(
          `INSERT INTO financial_event_log
             (event_kind, reference_type, reference_id, entry_id,
              amount, user_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [
            spec.kind,
            spec.reference_type,
            spec.reference_id,
            entry.id,
            sumD,
            spec.user_id,
          ],
        );
      } catch {
        /* table may not exist on pre-057 installs — ignore */
      }

      return {
        ok: true,
        entry_id: entry.id,
        entry_no: entryNo,
        cash_txn_ids: cashTxnIds,
      };
    };

    try {
      if (spec.em) {
        return await run(spec.em);
      }
      return await this.ds.transaction((em) => run(em));
    } catch (err: any) {
      // Any exception inside run() rolls back the transaction. We log
      // and return an error — never leak exceptions to callers.
      this.logger.error(
        `recordTransaction ${spec.kind} ${spec.reference_type}/${spec.reference_id} failed: ${err?.message ?? err}`,
      );
      return { ok: false, error: err?.message ?? String(err) };
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //   INTERNALS — not exported; every caller uses recordTransaction()
  // ══════════════════════════════════════════════════════════════════

  private validateSpec(spec: RecordTransactionSpec) {
    if (!spec.reference_type || !spec.reference_id) {
      throw new BadRequestException('reference_type + reference_id required');
    }
    if (!spec.description) {
      throw new BadRequestException('description required');
    }
    if (!Array.isArray(spec.gl_lines) || spec.gl_lines.length < 2) {
      throw new BadRequestException('gl_lines must contain at least 2 entries');
    }
    for (const l of spec.gl_lines) {
      const d = Number(l.debit || 0);
      const c = Number(l.credit || 0);
      if (d < 0 || c < 0) {
        throw new BadRequestException('debit/credit must be non-negative');
      }
      if (d > 0 && c > 0) {
        throw new BadRequestException(
          'a line cannot have both debit and credit > 0',
        );
      }
      const refs = [l.account_code, l.account_id, l.resolve_from_cashbox_id]
        .filter(Boolean).length;
      if (refs !== 1) {
        throw new BadRequestException(
          'each line must specify exactly one of account_code / account_id / resolve_from_cashbox_id',
        );
      }
    }
    for (const mv of spec.cash_movements ?? []) {
      if (!mv.cashbox_id) {
        throw new BadRequestException('cash movement missing cashbox_id');
      }
      if (!(Number(mv.amount) > 0)) {
        throw new BadRequestException('cash movement amount must be > 0');
      }
      if (mv.direction !== 'in' && mv.direction !== 'out') {
        throw new BadRequestException('direction must be in/out');
      }
    }
  }

  /**
   * Write a cashbox_transactions row AND update cashboxes.current_balance
   * atomically. Delegates to the plpgsql function fn_record_cashbox_txn
   * (migration 035) which holds the `FOR UPDATE` row lock and guarantees
   * the running balance stays correct under concurrency.
   */
  private async moveCash(
    q: QueryFn,
    spec: RecordTransactionSpec,
    mv: EngineCashMovement,
  ): Promise<number> {
    const [row] = await q(
      `SELECT fn_record_cashbox_txn(
         $1::uuid, $2::text, $3::numeric, $4::text,
         $5::text, $6::uuid, $7::uuid, $8::text
       ) AS id`,
      [
        mv.cashbox_id,
        mv.direction,
        Number(mv.amount),
        mv.category,
        // fn_record_cashbox_txn casts reference_type to entity_type enum;
        // map our narrow list of kinds onto the enum values it accepts.
        this.mapToEntityType(spec.reference_type),
        spec.reference_id,
        spec.user_id,
        mv.notes ?? spec.description,
      ],
    );
    return Number(row?.id);
  }

  /**
   * Translate our transaction `reference_type` (free-form string) into
   * one of the values accepted by the `entity_type` Postgres enum used
   * by cashbox_transactions. Unrecognized types map to 'other'.
   */
  private mapToEntityType(refType: string): string {
    const allowed = new Set([
      'user', 'product', 'variant', 'warehouse', 'stock',
      'invoice', 'invoice_item', 'customer', 'supplier',
      'purchase', 'reservation', 'return', 'exchange',
      'coupon', 'discount', 'expense', 'shift', 'cashbox',
      'setting', 'role', 'other',
    ]);
    // Common aliases we know about.
    const aliases: Record<string, string> = {
      customer_payment: 'customer',
      supplier_payment: 'supplier',
      shift_variance: 'shift',
      cashbox_transfer: 'cashbox',
      opening_balance: 'cashbox',
      manual_adjustment: 'cashbox',
    };
    const mapped = aliases[refType] ?? refType;
    return allowed.has(mapped) ? mapped : 'other';
  }

  /** Resolve a line's GL account by code, explicit id, or cashbox link. */
  private async resolveAccount(
    q: QueryFn,
    line: EngineGlLine,
  ): Promise<string | null> {
    if (line.account_id) return line.account_id;
    if (line.account_code) {
      return this.accountIdByCode(q, line.account_code);
    }
    if (line.resolve_from_cashbox_id) {
      return this.cashboxAccountId(q, line.resolve_from_cashbox_id);
    }
    return null;
  }

  private async accountIdByCode(
    q: QueryFn,
    code: string,
  ): Promise<string | null> {
    const [row] = await q(
      `SELECT id FROM chart_of_accounts
        WHERE code = $1 AND is_active = TRUE
        LIMIT 1`,
      [code],
    );
    return row?.id ?? null;
  }

  /**
   * Resolve a cashbox → GL account:
   *   1. explicit chart_of_accounts.cashbox_id link, if present
   *   2. kind-based fallback: cash=1111, bank=1113, ewallet=1114, check=1115
   *   3. last resort: 1111 default cash
   */
  private async cashboxAccountId(
    q: QueryFn,
    cashboxId: string,
  ): Promise<string | null> {
    const [explicit] = await q(
      `SELECT a.id FROM chart_of_accounts a
        WHERE a.cashbox_id = $1 AND a.is_active = TRUE
        LIMIT 1`,
      [cashboxId],
    );
    if (explicit) return explicit.id;

    const [cb] = await q(
      `SELECT kind FROM cashboxes WHERE id = $1`,
      [cashboxId],
    );
    const fallback: Record<string, string> = {
      cash: '1111',
      bank: '1113',
      ewallet: '1114',
      check: '1115',
    };
    const code = fallback[cb?.kind ?? 'cash'] || '1111';
    return this.accountIdByCode(q, code);
  }

  /** Cache the party-columns probe across a single request (cheap query). */
  private _partyColsCache: boolean | undefined;
  private async hasPartyColumns(q: QueryFn): Promise<boolean> {
    if (this._partyColsCache !== undefined) return this._partyColsCache;
    const [row] = await q(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_name = 'journal_lines' AND column_name = 'customer_id'
       ) AS has_col`,
    );
    this._partyColsCache = !!row?.has_col;
    return this._partyColsCache;
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  // ══════════════════════════════════════════════════════════════════
  //   CONVENIENCE HELPERS — per-kind recipes for callers that know
  //   exactly what shape they want. Each one builds a RecordTransactionSpec
  //   and delegates to recordTransaction(). These are thin wrappers so
  //   flows don't have to remember which account codes go where.
  // ══════════════════════════════════════════════════════════════════

  /**
   * Expense → DR expense-category-or-Misc(529) · CR cashbox-resolved-cash.
   * Callers supply: expense_id, amount, category's GL account_id (or null),
   * cashbox_id (or null for non-cash), user_id, entry_date.
   */
  async recordExpense(args: {
    expense_id: string;
    expense_no?: string;
    amount: number;
    category_account_id: string | null;
    cashbox_id: string | null;
    payment_method: string;
    user_id: string | null;
    entry_date?: string;
    em?: EntityManager;
    description?: string;
  }): Promise<RecordTransactionResult> {
    if (!(args.amount > 0)) {
      return { ok: false, error: 'expense amount must be positive' };
    }

    // If category isn't linked to a COA account, fall back to 529
    // (Miscellaneous Expenses) — the seeded catch-all.
    const dr: EngineGlLine = args.category_account_id
      ? { account_id: args.category_account_id, debit: args.amount }
      : { account_code: '529', debit: args.amount };

    // Credit side: cash if it's a cash expense with a cashbox, else
    // accounts-payable (210) for credit purchases.
    const isCash =
      args.payment_method === 'cash' && !!args.cashbox_id;
    const cr: EngineGlLine = isCash
      ? {
          resolve_from_cashbox_id: args.cashbox_id!,
          credit: args.amount,
          cashbox_id: args.cashbox_id!,
        }
      : { account_code: '210', credit: args.amount };

    const description =
      args.description ??
      `مصروف ${args.expense_no ?? ''}`.trim();

    return this.recordTransaction({
      kind: 'expense',
      reference_type: 'expense',
      reference_id: args.expense_id,
      entry_date: args.entry_date,
      description,
      gl_lines: [dr, cr],
      cash_movements: isCash
        ? [
            {
              cashbox_id: args.cashbox_id!,
              direction: 'out',
              amount: args.amount,
              category: 'expense',
              notes: description,
            },
          ]
        : [],
      user_id: args.user_id,
      em: args.em,
    });
  }

  /**
   * Shift variance at close — moves the counted cash into alignment with
   * expected, posts DR Cash/Deficit · CR Surplus/Cash, and writes the
   * matching cashbox_transactions row so cashboxes.current_balance
   * agrees with the physical count.
   *
   *   variance = actual_closing − expected_closing
   *   variance > 0   → surplus: DR Cash (1111) · CR Shift Surplus (421)
   *   variance < 0   → deficit: DR Shift Deficit (531) · CR Cash (1111)
   */
  async recordShiftVariance(args: {
    shift_id: string;
    shift_no?: string;
    cashbox_id: string;
    variance: number;
    user_id: string | null;
    entry_date?: string;
    em?: EntityManager;
  }): Promise<RecordTransactionResult> {
    const v = Number(args.variance) || 0;
    if (Math.abs(v) < 0.01) {
      // Zero variance — nothing to do. Not an error.
      return { ok: true, skipped: true, entry_id: '', reason: 'idempotent-replay' };
    }
    const abs = Math.abs(v);
    const description =
      `تسوية فروقات وردية ${args.shift_no ?? ''}`.trim();

    if (v > 0) {
      // Surplus — physical cash is MORE than expected.
      return this.recordTransaction({
        kind: 'shift_variance',
        reference_type: 'shift_variance',
        reference_id: args.shift_id,
        entry_date: args.entry_date,
        description,
        gl_lines: [
          {
            resolve_from_cashbox_id: args.cashbox_id,
            debit: abs,
            cashbox_id: args.cashbox_id,
          },
          { account_code: '421', credit: abs },
        ],
        cash_movements: [
          {
            cashbox_id: args.cashbox_id,
            direction: 'in',
            amount: abs,
            category: 'shift_variance',
            notes: description,
          },
        ],
        user_id: args.user_id,
        em: args.em,
      });
    }

    // Deficit — physical cash is LESS than expected.
    return this.recordTransaction({
      kind: 'shift_variance',
      reference_type: 'shift_variance',
      reference_id: args.shift_id,
      entry_date: args.entry_date,
      description,
      gl_lines: [
        { account_code: '531', debit: abs },
        {
          resolve_from_cashbox_id: args.cashbox_id,
          credit: abs,
          cashbox_id: args.cashbox_id,
        },
      ],
      cash_movements: [
        {
          cashbox_id: args.cashbox_id,
          direction: 'out',
          amount: abs,
          category: 'shift_variance',
          notes: description,
        },
      ],
      user_id: args.user_id,
      em: args.em,
    });
  }
}
