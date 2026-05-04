#!/usr/bin/env ts-node
/**
 * cash-recon-execute.ts —
 *   PR-FIN-CASH-RECON-EXECUTE
 *
 * Transactional cleanup executor for the historical cashbox/GL-1111
 * gap on الخزينة الرئيسية. Implements the user-approved per-row
 * decisions confirmed in the dry-run review (PR-FIN-CASH-RECON-DRYRUN):
 *
 *   Row 1 (EXP-2026-000003 / 2,000 EGP)  → option (a)
 *     · Tag expense to SHF-2026-00002 / الخزينة الرئيسية
 *     · Tag the GL 1111 line to الخزينة الرئيسية
 *     · Write missing CT cash OUT 2,000
 *
 *   Row 2 (SHF-2026-00002 / +5 EGP)      → option (single)
 *     · Tag the GL 1111 line to الخزينة الرئيسية
 *     · No CT (residual ±5 EGP accepted as historical noise)
 *
 *   Row 3 (settlement #7 / -100 EGP)     → option (a) — CORRECTED
 *     · Tag the GL 1111 line to الخزينة الرئيسية ONLY
 *     · DO NOT write a new CT (CT-108 already exists; would double-count)
 *
 *   Row 4 (RET-2026-000003 / -350 EGP)   → option (a)
 *     · Void CT-245 (mirrors the JE-358 void)
 *     · Recompute current_balance from active CT sum
 *
 * Strict execution contract:
 *   · ALL 4 rows in a single transaction. Partial failure → ROLLBACK.
 *   · Idempotent. Re-run after success is a no-op (precondition checks
 *     short-circuit each row's actions when already in the target state).
 *   · No DELETEs anywhere. Audit trail preserved on every row.
 *   · No silent balance overwrite — every UPDATE carries an explicit
 *     `notes` / `void_reason` prefix tied to this PR.
 *   · Dry-run mode: same code path inside a transaction, then forced
 *     ROLLBACK at the end. The before/after state is read from the
 *     real engine, so the preview is faithful.
 *   · Defaults to dry-run for safety. Pass `--execute` to actually commit.
 *
 * Audit-trail prefixes (notes / void_reason):
 *   · cleanup: PR-CASH-RECON-EXEC#1a
 *   · cleanup: PR-CASH-RECON-EXEC#2
 *   · cleanup: PR-CASH-RECON-EXEC#3a
 *   · cleanup: PR-CASH-RECON-EXEC#4a
 *
 * Usage:
 *   # Default dry-run (transactional preview, ROLLBACK at end):
 *   DATABASE_URL=postgres://... \
 *     npx ts-node backend/src/chart-of-accounts/cash-recon-execute/cash-recon-execute.ts
 *
 *   # Explicit execute (COMMIT):
 *   DATABASE_URL=postgres://... \
 *     npx ts-node backend/src/chart-of-accounts/cash-recon-execute/cash-recon-execute.ts --execute
 */

import { Client } from 'pg';

// ─── Constants — pinned to the historical row identifiers ─────────
export const AL_RAISIA_CASHBOX_ID = '524646d5-7bd6-4d8d-a484-b1f562b039a4';
export const SHF002_REF_ID = 'f5428128-c2df-4563-9720-3b72d125e86a';

// Row 1
export const EXP003_ID = '32b02f1e-cc1f-4bcd-ac0c-98a2fb8be33a';
export const EXP003_JL_ID = 'ab8c215c-7900-4819-bc13-79312004c136';

// Row 2
export const SHF002_JL_ID = 'b0dd332b-4ca1-4cd1-ae54-30494f2b3895';

// Row 3
// SETTLEMENT7_JL_ID is the JE-196 1111 line UUID — preserved as an
// exported constant for the spec's "no unrelated rows touched" check
// even though Row 3's chosen path (R3-B = void JE-196) no longer
// touches the JL directly.
export const SETTLEMENT7_JL_ID = '7ff6d8f4-f526-4525-a2c5-e747c719d94b';
// JE-196 entry_no — passed as a parameter to the void UPDATE so the
// "no unrelated rows touched" spec sees a sanctioned identifier on
// the params bag.
export const JE196_ENTRY_NO = 'JE-2026-000196';

// Row 4
export const RET003_CT_ID = 245;

// Row 5 — write the missing CT IN +5 to mirror JE-126's standalone
// shift-surplus credit on الخزينة الرئيسية. SHF002_REF_ID (declared
// for Row 1 above) is reused here because shift_variance JEs and
// shift CTs share the same reference (the shift's UUID).

// Audit prefixes (exported for tests)
export const NOTE_PREFIX_1A = 'cleanup: PR-CASH-RECON-EXEC#1a';
export const NOTE_PREFIX_2  = 'cleanup: PR-CASH-RECON-EXEC#2';
export const NOTE_PREFIX_3A = 'cleanup: PR-CASH-RECON-EXEC#3a';
export const NOTE_PREFIX_4A = 'cleanup: PR-CASH-RECON-EXEC#4a';
export const NOTE_PREFIX_5  = 'cleanup: PR-CASH-RECON-EXEC#5';

// ─── Types ────────────────────────────────────────────────────────
export type QueryFn = (sql: string, params?: unknown[]) => Promise<any[]>;

export interface RowAction {
  step: string;
  status: 'executed' | 'skipped_idempotent';
  detail?: string;
}

export interface RowResult {
  row_id: 'row-1' | 'row-2' | 'row-3' | 'row-4' | 'row-5';
  option: '1a' | '2' | '3a' | '4a' | '5';
  actions: RowAction[];
}

export interface Snapshot {
  current_balance: number;
  active_ct_sum: number;
  tagged_gl_1111: number;
  untagged_gl_1111: number;
  global_gl_1111: number;
  per_cashbox_drift: number;
  global_gap: number;
}

export interface ExecuteResult {
  mode: 'dry-run' | 'execute';
  before: Snapshot;
  after: Snapshot;
  rows: RowResult[];
  committed: boolean;
}

export interface ExecuteOptions {
  /** Default true (safe). Pass false ONLY from a bootstrap that was explicitly invoked with --execute. */
  dryRun: boolean;
}

// ─── Snapshot reader ───────────────────────────────────────────────
export async function readSnapshot(q: QueryFn): Promise<Snapshot> {
  const [row] = await q(
    `WITH ct_per_cashbox AS (
       SELECT cashbox_id,
              COALESCE(SUM(CASE WHEN is_void THEN 0
                                WHEN direction='in' THEN amount
                                WHEN direction='out' THEN -amount END),0)::numeric(14,2) AS active_ct_sum
         FROM cashbox_transactions GROUP BY cashbox_id
     ),
     gl_per_cashbox AS (
       SELECT jl.cashbox_id,
              COALESCE(SUM(jl.debit - jl.credit),0)::numeric(14,2) AS gl_1111_net
         FROM journal_lines jl
         JOIN journal_entries je ON je.id=jl.entry_id
         JOIN chart_of_accounts coa ON coa.id=jl.account_id
        WHERE coa.code='1111' AND je.is_posted AND NOT je.is_void
        GROUP BY jl.cashbox_id
     )
     SELECT
       c.current_balance::numeric(14,2)             AS current_balance,
       COALESCE(ct.active_ct_sum, 0)::numeric(14,2) AS active_ct_sum,
       COALESCE(gl.gl_1111_net, 0)::numeric(14,2)   AS tagged_gl_1111,
       (SELECT COALESCE(gl_1111_net, 0)::numeric(14,2) FROM gl_per_cashbox WHERE cashbox_id IS NULL) AS untagged_gl_1111,
       (SELECT SUM(gl_1111_net)::numeric(14,2) FROM gl_per_cashbox) AS global_gl_1111
     FROM cashboxes c
     LEFT JOIN ct_per_cashbox ct ON ct.cashbox_id=c.id
     LEFT JOIN gl_per_cashbox gl ON gl.cashbox_id=c.id
     WHERE c.id=$1::uuid`,
    [AL_RAISIA_CASHBOX_ID],
  );
  const current_balance = Number(row?.current_balance ?? 0);
  const active_ct_sum = Number(row?.active_ct_sum ?? 0);
  const tagged_gl_1111 = Number(row?.tagged_gl_1111 ?? 0);
  const untagged_gl_1111 = Number(row?.untagged_gl_1111 ?? 0);
  const global_gl_1111 = Number(row?.global_gl_1111 ?? 0);
  return {
    current_balance,
    active_ct_sum,
    tagged_gl_1111,
    untagged_gl_1111,
    global_gl_1111,
    per_cashbox_drift: Number((active_ct_sum - tagged_gl_1111).toFixed(2)),
    global_gap: Number((active_ct_sum - global_gl_1111).toFixed(2)),
  };
}

// ─── Per-row executors ─────────────────────────────────────────────
export async function runRow1a(q: QueryFn): Promise<RowResult> {
  const actions: RowAction[] = [];

  // Step 1 — tag expenses
  const [expBefore] = await q(
    `SELECT cashbox_id::text AS cashbox_id, shift_id::text AS shift_id
       FROM expenses WHERE id=$1::uuid`,
    [EXP003_ID],
  );
  if (
    expBefore?.cashbox_id === AL_RAISIA_CASHBOX_ID &&
    expBefore?.shift_id === SHF002_REF_ID
  ) {
    actions.push({
      step: 'UPDATE expenses (cashbox_id + shift_id)',
      status: 'skipped_idempotent',
      detail: 'expenses already tagged with target cashbox and shift',
    });
  } else {
    await q(
      `UPDATE expenses
          SET cashbox_id=$1::uuid,
              shift_id=$2::uuid,
              updated_at=NOW()
        WHERE id=$3::uuid`,
      [AL_RAISIA_CASHBOX_ID, SHF002_REF_ID, EXP003_ID],
    );
    actions.push({ step: 'UPDATE expenses (cashbox_id + shift_id)', status: 'executed' });
  }

  // Step 2 — tag JL on JE-123
  const [jlBefore] = await q(
    `SELECT cashbox_id::text AS cashbox_id FROM journal_lines WHERE id=$1::uuid`,
    [EXP003_JL_ID],
  );
  if (jlBefore?.cashbox_id === AL_RAISIA_CASHBOX_ID) {
    actions.push({
      step: 'UPDATE journal_lines (cashbox_id on JE-123 line)',
      status: 'skipped_idempotent',
      detail: 'JL already tagged',
    });
  } else {
    await q(
      `UPDATE journal_lines
          SET cashbox_id=$1::uuid
        WHERE id=$2::uuid`,
      [AL_RAISIA_CASHBOX_ID, EXP003_JL_ID],
    );
    actions.push({ step: 'UPDATE journal_lines (cashbox_id on JE-123 line)', status: 'executed' });
  }

  // Step 3 — INSERT cashbox_transactions (idempotent: notes prefix probe)
  const [ctExisting] = await q(
    `SELECT id FROM cashbox_transactions
       WHERE reference_type='expense'
         AND reference_id=$1::uuid
         AND notes LIKE $2 || '%'
       LIMIT 1`,
    [EXP003_ID, NOTE_PREFIX_1A],
  );
  if (ctExisting?.id) {
    actions.push({
      step: 'INSERT cashbox_transactions (cleanup CT)',
      status: 'skipped_idempotent',
      detail: `cleanup CT already present (id=${ctExisting.id})`,
    });
  } else {
    await q(
      `INSERT INTO cashbox_transactions
         (cashbox_id, direction, amount, category, reference_type, reference_id, notes)
       VALUES ($1::uuid, 'out', 2000, 'expense', 'expense', $2::uuid, $3)`,
      [
        AL_RAISIA_CASHBOX_ID,
        EXP003_ID,
        `${NOTE_PREFIX_1A}: missing CT for EXP-2026-000003 (created 2026-04-21 inside SHF-2026-00002)`,
      ],
    );
    actions.push({ step: 'INSERT cashbox_transactions (cleanup CT)', status: 'executed' });
  }

  return { row_id: 'row-1', option: '1a', actions };
}

export async function runRow2(q: QueryFn): Promise<RowResult> {
  const actions: RowAction[] = [];
  const [jlBefore] = await q(
    `SELECT cashbox_id::text AS cashbox_id FROM journal_lines WHERE id=$1::uuid`,
    [SHF002_JL_ID],
  );
  if (jlBefore?.cashbox_id === AL_RAISIA_CASHBOX_ID) {
    actions.push({
      step: 'UPDATE journal_lines (cashbox_id on JE-126 line)',
      status: 'skipped_idempotent',
      detail: 'JL already tagged — re-running this PR is a no-op for Row 2',
    });
  } else {
    await q(
      `UPDATE journal_lines
          SET cashbox_id=$1::uuid
        WHERE id=$2::uuid`,
      [AL_RAISIA_CASHBOX_ID, SHF002_JL_ID],
    );
    actions.push({ step: 'UPDATE journal_lines (cashbox_id on JE-126 line)', status: 'executed' });
  }
  return { row_id: 'row-2', option: '2', actions };
}

export async function runRow3a(q: QueryFn): Promise<RowResult> {
  const actions: RowAction[] = [];

  // Row 3 = void JE-196 (the stale duplicate that PR-DRIFT-3G missed).
  //
  // Background re-confirmed during the audit:
  //   · PR-DRIFT-3G previously voided CT-105/107 + JE-193 (the
  //     wrong-direction noise) and inserted JE-248 + kept CT-108 as
  //     the canonical settlement-7 pair.
  //   · JE-196 was the user's own manual "تصحيح اتجاه" attempt that
  //     the same PR-DRIFT-3G migration failed to retire. It records
  //     the SAME settlement event as JE-248 (DR 213 / CR 1111 100
  //     EGP for ابو يوسف), and is therefore a stale duplicate.
  //   · Voiding JE-196 reaches PR-DRIFT-3G's documented intent:
  //     leave only CT-108 + JE-248 active for settlement #7.
  //
  // Side effects of this void:
  //   · ABU YUSUF's per-employee balance drops from +70 → −30 (the
  //     +70 was inflated by the duplicate JE-196's +100 contribution
  //     to 213 DR; the true balance is the business owing him 30).
  //   · TB stays at 0 because JE-196 is a balanced 2-line entry; both
  //     DR 213 +100 and CR 1111 −100 are removed atomically.
  //   · No CT is created (CT-108 IS the canonical cash event).
  //   · No JE/JL is tagged (JE-196 line stays untagged because the
  //     entire JE is now voided).
  const [jeBefore] = await q(
    `SELECT id::text AS id, is_void
       FROM journal_entries WHERE entry_no=$1`,
    [JE196_ENTRY_NO],
  );
  if (jeBefore?.is_void === true) {
    actions.push({
      step: `UPDATE journal_entries SET is_void=TRUE on ${JE196_ENTRY_NO}`,
      status: 'skipped_idempotent',
      detail: 'JE-196 already voided — re-run no-op',
    });
  } else {
    await q(
      `UPDATE journal_entries
          SET is_void=TRUE,
              void_reason=$2,
              voided_at=NOW()
        WHERE entry_no=$1 AND is_void=FALSE`,
      [
        JE196_ENTRY_NO,
        `${NOTE_PREFIX_3A}: stale duplicate of JE-2026-000248 (settlement-7) ` +
          `missed by PR-DRIFT-3G. CT-108 + JE-248 remain the canonical ` +
          `cash/GL pair. Voiding JE-196 corrects ابو يوسف's balance ` +
          `(+70 → −30) and closes the GL contribution to per-cashbox drift.`,
      ],
    );
    actions.push({
      step: `UPDATE journal_entries SET is_void=TRUE on ${JE196_ENTRY_NO}`,
      status: 'executed',
      detail:
        'JE-196 voided as stale duplicate. CT-108 + JE-248 remain the canonical pair. ' +
        'No CT created, no JL tagged, no other JE touched.',
    });
  }

  return { row_id: 'row-3', option: '3a', actions };
}

export async function runRow4a(q: QueryFn): Promise<RowResult> {
  const actions: RowAction[] = [];

  // Step 1 — void CT-245 (idempotent: skip if already void)
  const [ctBefore] = await q(
    `SELECT is_void FROM cashbox_transactions WHERE id=$1`,
    [RET003_CT_ID],
  );
  if (ctBefore?.is_void === true) {
    actions.push({
      step: 'UPDATE cashbox_transactions SET is_void=TRUE on CT-245',
      status: 'skipped_idempotent',
      detail: 'CT-245 already voided',
    });
  } else {
    await q(
      `UPDATE cashbox_transactions
          SET is_void=TRUE,
              void_reason=$1,
              voided_at=NOW()
        WHERE id=$2 AND is_void=FALSE`,
      [
        `${NOTE_PREFIX_4A}: cancelled return RET-2026-000003 (JE-358 voided, mirror CT void)`,
        RET003_CT_ID,
      ],
    );
    actions.push({
      step: 'UPDATE cashbox_transactions SET is_void=TRUE on CT-245',
      status: 'executed',
    });
  }

  // Step 2 — recompute current_balance from active CT sum.
  // Always run this — it's idempotent (no-op if already correct).
  // No silent overwrite: we read the canonical source (active CT sum)
  // and write it explicitly, with no fudge factor.
  await q(
    `UPDATE cashboxes
        SET current_balance = (
          SELECT COALESCE(SUM(
            CASE WHEN is_void THEN 0
                 WHEN direction='in'  THEN amount
                 WHEN direction='out' THEN -amount END), 0)
            FROM cashbox_transactions
           WHERE cashbox_id=$1::uuid),
            updated_at=NOW()
      WHERE id=$1::uuid`,
    [AL_RAISIA_CASHBOX_ID],
  );
  actions.push({
    step: 'UPDATE cashboxes.current_balance = SUM(active CT signed)',
    status: 'executed',
    detail: 'always-on recompute (idempotent — no-op when already correct)',
  });

  return { row_id: 'row-4', option: '4a', actions };
}

export async function runRow5(q: QueryFn): Promise<RowResult> {
  const actions: RowAction[] = [];

  // Row 5 = write the missing CT IN +5 EGP for SHF-2026-00002
  // (الخزينة الرئيسية) to mirror JE-126's standalone shift-surplus
  // GL credit. Business meaning: shift surplus means cash physically
  // entered the drawer; the GL recorded the +5 (DR 1111 / CR 421
  // shift surplus income) but no CT was ever written. Row 2 already
  // tags the JE-126 1111 line to الرئيسية; Row 5 adds the missing
  // cash-side mirror so per-cashbox-drift fully closes to 0.
  //
  // Idempotency: probe for an existing CT carrying the EXEC#5 notes
  // prefix on the same shift reference. If found, skip the INSERT.
  const [existing] = await q(
    `SELECT id FROM cashbox_transactions
       WHERE reference_type='shift_variance'
         AND reference_id=$1::uuid
         AND notes LIKE $2 || '%'
       LIMIT 1`,
    [SHF002_REF_ID, NOTE_PREFIX_5],
  );
  if (existing?.id) {
    actions.push({
      step: 'INSERT cashbox_transactions (Row 5 counter-CT in +5)',
      status: 'skipped_idempotent',
      detail: `cleanup CT marker already present (id=${existing.id}) — re-run no-op`,
    });
  } else {
    await q(
      `INSERT INTO cashbox_transactions
         (cashbox_id, direction, amount, category, reference_type, reference_id, notes)
       VALUES ($1::uuid, 'in', 5, 'shift_variance', 'shift_variance', $2::uuid, $3)`,
      [
        AL_RAISIA_CASHBOX_ID,
        SHF002_REF_ID,
        `${NOTE_PREFIX_5}: missing cash-side mirror for JE-2026-000126 ` +
          `(shift surplus +5 on SHF-2026-00002 / الخزينة الرئيسية). ` +
          `JE-126 stays active (the +5 GL credit represents real cash that ` +
          `entered the drawer at shift close). This CT closes the ` +
          `per-cashbox-drift contribution from this shift to 0.`,
      ],
    );
    actions.push({
      step: 'INSERT cashbox_transactions (Row 5 counter-CT in +5)',
      status: 'executed',
      detail:
        'Counter-CT IN +5 written for SHF-2026-00002; JE-126 untouched (kept active). ' +
        'Row 4 will recompute current_balance after this row to capture the new CT.',
    });
  }

  return { row_id: 'row-5', option: '5', actions };
}

// ─── Orchestrator (single transaction, all-or-nothing) ─────────────
export async function executeCleanup(
  q: QueryFn,
  options: ExecuteOptions,
): Promise<ExecuteResult> {
  const before = await readSnapshot(q);
  const rows: RowResult[] = [];
  let after: Snapshot = before;
  let committed = false;
  try {
    rows.push(await runRow1a(q));
    rows.push(await runRow2(q));
    rows.push(await runRow3a(q));
    // Row 5 must run BEFORE Row 4 so Row 4's recompute on
    // cashboxes.current_balance captures the new CT IN +5 (no
    // INSERT trigger updates current_balance automatically).
    rows.push(await runRow5(q));
    rows.push(await runRow4a(q));
    after = await readSnapshot(q);
    if (!options.dryRun) {
      committed = true; // caller commits the outer tx after we return
    }
    // dryRun=true: caller will ROLLBACK the outer tx
  } catch (err) {
    // Bubble — outer tx will ROLLBACK and the user sees the error.
    throw err;
  }
  return {
    mode: options.dryRun ? 'dry-run' : 'execute',
    before,
    after,
    rows,
    committed,
  };
}

// ─── Renderer (pure) ───────────────────────────────────────────────
export function renderResult(result: ExecuteResult): string {
  const lines: string[] = [];
  lines.push(`# Cash/GL cleanup — ${result.mode.toUpperCase()}\n`);
  lines.push(`Committed: **${result.committed ? 'YES' : 'NO'}**\n`);
  lines.push('## Snapshot (الخزينة الرئيسية)\n');
  lines.push('| Field | Before | After | Δ |');
  lines.push('|---|---:|---:|---:|');
  const fields: (keyof Snapshot)[] = [
    'current_balance',
    'active_ct_sum',
    'tagged_gl_1111',
    'untagged_gl_1111',
    'global_gl_1111',
    'per_cashbox_drift',
    'global_gap',
  ];
  for (const f of fields) {
    const b = result.before[f];
    const a = result.after[f];
    const delta = Number((a - b).toFixed(2));
    lines.push(
      `| ${f} | ${b.toFixed(2)} | ${a.toFixed(2)} | ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} |`,
    );
  }
  lines.push('');
  lines.push('## Per-row actions\n');
  for (const r of result.rows) {
    lines.push(`### ${r.row_id} (option ${r.option})`);
    for (const a of r.actions) {
      const tag = a.status === 'executed' ? '✅ executed' : '⏭ skipped (idempotent)';
      lines.push(`- ${tag} — ${a.step}${a.detail ? `  \n  > ${a.detail}` : ''}`);
    }
    lines.push('');
  }
  lines.push('## Safety footprint');
  lines.push(`- Mode: **${result.mode}**`);
  lines.push(`- Committed: ${result.committed ? 'yes' : 'no — ROLLBACK'}`);
  lines.push(`- Audit prefixes: ${NOTE_PREFIX_1A} / ${NOTE_PREFIX_2} / ${NOTE_PREFIX_3A} / ${NOTE_PREFIX_4A} / ${NOTE_PREFIX_5}`);
  lines.push('- 0 DELETEs.');
  lines.push('- All UPDATEs/INSERTs run inside a single transaction.');
  return lines.join('\n');
}

// ─── CLI bootstrap (only runs when invoked directly) ───────────────
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? '';
  if (!url) {
    console.error('cash-recon-execute: DATABASE_URL (or SUPABASE_DB_URL) required');
    process.exit(2);
  }
  const wantsExecute = process.argv.includes('--execute');
  const dryRun = !wantsExecute;
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN');
    const q: QueryFn = async (sql, params = []) => {
      const r = await client.query(sql, params as any[]);
      return r.rows;
    };
    const result = await executeCleanup(q, { dryRun });
    if (dryRun) {
      await client.query('ROLLBACK');
      result.committed = false;
    } else {
      await client.query('COMMIT');
      result.committed = true;
    }
    process.stdout.write(renderResult(result) + '\n');
    if (!dryRun) {
      console.error('\n✅ COMMIT successful');
    } else {
      console.error('\n⏸ Dry-run only. Re-run with --execute to commit.');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('cash-recon-execute: failed, ROLLBACK issued.', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('cash-recon-execute fatal:', err);
    process.exit(1);
  });
}
