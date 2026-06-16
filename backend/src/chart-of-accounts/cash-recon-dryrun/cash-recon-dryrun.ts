#!/usr/bin/env ts-node
/**
 * cash-recon-dryrun.ts —
 *   PR-FIN-CASH-RECON-DRYRUN
 *
 * READ-ONLY dry-run script for the historical cashbox/GL-1111
 * reconciliation. Produces a per-row before/after report under each
 * available option, plus a JSON `decisions.json` skeleton the user
 * can edit and feed into the PR-3 execute script.
 *
 * STRICT CONTRACT — this script does NOT perform any DML:
 *   · every query goes through `runSelect()` which validates the SQL
 *     starts with `SELECT` or `WITH` (a CTE that ultimately SELECTs)
 *   · no `INSERT` / `UPDATE` / `DELETE` / `TRUNCATE` / `DROP` /
 *     `ALTER` statements anywhere in this file (the spec asserts this)
 *   · no `cashboxes.current_balance` recompute / rebuild
 *   · no historical row mutation
 *   · no cleanup execution
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx ts-node backend/scripts/cash-recon-dryrun.ts
 *   # or
 *   npm run dryrun:cash-recon
 *
 * Output:
 *   - stdout: human-readable Markdown report
 *   - ./cash-recon-decisions.json: JSON skeleton for PR-3 (per-row
 *     option choices the user fills in)
 *
 * Deliberately unwired from the NestJS bootstrap — fewer moving parts
 * for a one-off audit tool.
 */

import { Client } from 'pg';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

// ─── Types ────────────────────────────────────────────────────────
export interface CashReconSnapshot {
  cashbox_id: string;
  cashbox_name: string;
  current_balance: number;
  active_ct_sum: number;
  tagged_gl_1111: number;
  untagged_gl_1111: number;
  global_gl_1111: number;
  ct_minus_global_gl: number;
}

export interface RowEvidence {
  row_id: string;
  reference_no: string;
  reference_id: string | null;
  description: string;
  amount: number;
  current_state: string;
  contribution_to_gap: number;
  bucket:
    | 'untagged_gl_no_ct'
    | 'untagged_gl_with_ct'
    | 'cancelled_return_orphan_ct'
    | 'untagged_corrective_je';
}

export interface ProposedOption {
  label: string;
  steps: string[];
  before_invariant: Record<string, number>;
  after_invariant: Record<string, number>;
  dml_summary: string;
  audit_trail: string;
}

export interface CashReconRow {
  id: string;
  evidence: RowEvidence;
  options: ProposedOption[];
}

export interface CashReconReport {
  generated_at: string;
  snapshot: CashReconSnapshot;
  rows: CashReconRow[];
  total_gap_before: number;
  decisions_skeleton: Record<string, string>;
}

// ─── Pure SELECT runner ────────────────────────────────────────────
type QueryFn = (sql: string, params?: unknown[]) => Promise<any[]>;

export async function runSelect(
  q: QueryFn,
  sql: string,
  params: unknown[] = [],
): Promise<any[]> {
  const trimmed = sql.trimStart();
  const upper = trimmed.toUpperCase();
  if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) {
    throw new Error(
      `cash-recon-dryrun: refusing to run non-SELECT query: ${trimmed.slice(0, 60)}…`,
    );
  }
  return q(sql, params);
}

// ─── Builder (pure) ────────────────────────────────────────────────
const AL_RAISIA_ID = '524646d5-7bd6-4d8d-a484-b1f562b039a4';
const EXP003_ID = '32b02f1e-cc1f-4bcd-ac0c-98a2fb8be33a';
const EXP003_JL_ID = 'ab8c215c-7900-4819-bc13-79312004c136';
const SHF002_REF_ID = 'f5428128-c2df-4563-9720-3b72d125e86a';
const SHF002_JL_ID = 'b0dd332b-4ca1-4cd1-ae54-30494f2b3895';
const SETTLEMENT7_REF_ID = 'dd9a85ab-01fd-5911-bddc-93a23e821b11';
const SETTLEMENT7_JL_ID = '7ff6d8f4-f526-4525-a2c5-e747c719d94b';
const RET003_REF_ID = 'b65e0e45-09b8-44ce-987a-a67c9dcd9e4f';
const RET003_CT_ID = 245;
const SHF002_CASHBOX_ID = AL_RAISIA_ID;

export async function buildReport(q: QueryFn): Promise<CashReconReport> {
  // 1) Snapshot of the alرئيسية cashbox + global GL 1111
  const [snap] = await runSelect(
    q,
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
       c.id::text AS cashbox_id,
       c.name_ar AS cashbox_name,
       c.current_balance::numeric(14,2)              AS current_balance,
       COALESCE(ct.active_ct_sum, 0)::numeric(14,2) AS active_ct_sum,
       COALESCE(gl.gl_1111_net, 0)::numeric(14,2)   AS tagged_gl_1111,
       (SELECT COALESCE(gl_1111_net, 0)::numeric(14,2) FROM gl_per_cashbox WHERE cashbox_id IS NULL) AS untagged_gl_1111,
       (SELECT SUM(gl_1111_net)::numeric(14,2) FROM gl_per_cashbox) AS global_gl_1111
     FROM cashboxes c
     LEFT JOIN ct_per_cashbox ct ON ct.cashbox_id=c.id
     LEFT JOIN gl_per_cashbox gl ON gl.cashbox_id=c.id
     WHERE c.id=$1::uuid`,
    [AL_RAISIA_ID],
  );
  const snapshot: CashReconSnapshot = {
    cashbox_id: snap.cashbox_id,
    cashbox_name: snap.cashbox_name,
    current_balance: Number(snap.current_balance),
    active_ct_sum: Number(snap.active_ct_sum),
    tagged_gl_1111: Number(snap.tagged_gl_1111),
    untagged_gl_1111: Number(snap.untagged_gl_1111),
    global_gl_1111: Number(snap.global_gl_1111),
    ct_minus_global_gl:
      Number(snap.current_balance) - Number(snap.global_gl_1111),
  };

  // 2) Per-row evidence
  const [exp003] = await runSelect(
    q,
    `SELECT expense_no, expense_date::text AS expense_date, amount,
            cashbox_id::text, shift_id::text, payment_method::text
       FROM expenses WHERE id=$1::uuid`,
    [EXP003_ID],
  );
  const [retEvidence] = await runSelect(
    q,
    `SELECT reference_id::text, amount, direction::text, is_void, notes
       FROM cashbox_transactions WHERE id=$1`,
    [RET003_CT_ID],
  );
  const [settle7Evidence] = await runSelect(
    q,
    `SELECT je.entry_no, je.description, je.is_posted, je.is_void
       FROM journal_entries je
      WHERE je.reference_id=$1::uuid AND je.entry_no='JE-2026-000196'`,
    [SETTLEMENT7_REF_ID],
  );

  const rows: CashReconRow[] = [
    // Row 1 — EXP-2026-000003 (2,000 untagged historical)
    {
      id: 'row-1',
      evidence: {
        row_id: 'row-1',
        reference_no: 'EXP-2026-000003 / JE-2026-000123',
        reference_id: EXP003_ID,
        description:
          'مصروف نقدي 2,000 EGP بتاريخ 2026-04-21، ' +
          'expenses.cashbox_id=NULL مع payment_method=cash، JE-123 ' +
          'يقيد CR 1111 بقيمة 2,000 بدون cashbox_id ولا CT مقابل.',
        amount: 2000,
        current_state: `expenses.cashbox_id=${exp003.cashbox_id ?? 'NULL'}, ct_count=0, JE-123 jl_1111.cashbox_id=NULL`,
        contribution_to_gap: 2000, // pushes operational ABOVE GL by 2,000
        bucket: 'untagged_gl_no_ct',
      },
      options: [
        {
          label: 'option (a) — link to السهيفت/الخزنة + write missing CT',
          steps: [
            `UPDATE expenses SET cashbox_id='${SHF002_CASHBOX_ID}', shift_id='${SHF002_REF_ID}' WHERE id='${EXP003_ID}'`,
            `UPDATE journal_lines SET cashbox_id='${SHF002_CASHBOX_ID}' WHERE id='${EXP003_JL_ID}'`,
            `INSERT INTO cashbox_transactions (cashbox_id, direction, amount, category, reference_type, reference_id, notes) VALUES ('${SHF002_CASHBOX_ID}','out',2000,'expense','expense','${EXP003_ID}','cleanup PR-CASH-RECON: missing CT for EXP-2026-000003')`,
          ],
          before_invariant: {
            current_balance: snapshot.current_balance,
            tagged_gl_1111: snapshot.tagged_gl_1111,
            untagged_gl_1111: snapshot.untagged_gl_1111,
            global_gl_1111: snapshot.global_gl_1111,
          },
          after_invariant: {
            current_balance: snapshot.current_balance - 2000, // CT pushes balance down
            tagged_gl_1111: snapshot.tagged_gl_1111 - 2000,   // tag flips JL to الرئيسية
            untagged_gl_1111: snapshot.untagged_gl_1111 + 2000,
            global_gl_1111: snapshot.global_gl_1111,           // unchanged (only re-tag)
          },
          dml_summary:
            '2× UPDATE (expenses, journal_lines) + 1× INSERT (cashbox_transactions). 0 DELETE. Audit-trail tags on every row.',
          audit_trail:
            "notes prefix 'cleanup: PR-CASH-RECON-EXEC#1' on the new CT; an engine_bypass_alerts row may be auto-recorded by migration-063 trigger on the UPDATE.",
        },
        {
          label: 'option (b) — reverse the expense entirely (DR 1111, CR 5xx) — only if EXP was a typo',
          steps: [
            `INSERT INTO journal_entries (..., reference_type='expense_reversal', reference_id='${EXP003_ID}', description='تصحيح EXP-000003 — قيد عكسي') VALUES (...)`,
            `INSERT INTO journal_lines: DR 1111 +2,000 (cashbox_id NULL preserved to keep symmetry with the original) + CR 5xx -2,000`,
          ],
          before_invariant: {
            current_balance: snapshot.current_balance,
            global_gl_1111: snapshot.global_gl_1111,
          },
          after_invariant: {
            current_balance: snapshot.current_balance, // unchanged (no CT)
            global_gl_1111: snapshot.global_gl_1111 + 2000, // GL bumps up by 2,000
          },
          dml_summary:
            '2× INSERT (1 JE + 2 JLs). 0 UPDATE. 0 DELETE. Original EXP-000003 row stays for audit.',
          audit_trail:
            'New JE references EXP-000003. Original is_void=FALSE; the new JE is the canonical reversal entry.',
        },
      ],
    },

    // Row 2 — SHF-2026-00002 / JE-126 (+5 EGP untagged historical)
    {
      id: 'row-2',
      evidence: {
        row_id: 'row-2',
        reference_no: 'SHF-2026-00002 / JE-2026-000126',
        reference_id: SHF002_REF_ID,
        description:
          'فرق وردية موجب +5 EGP. JE-126 يقيد DR 1111 بـ +5 بدون cashbox_id؛ ' +
          'الوردية SHF-2026-00002 ملك للخزينة الرئيسية (cashbox_id معروف).',
        amount: 5,
        current_state: 'JE-126 jl_1111.cashbox_id=NULL, shift.cashbox_id=الرئيسية',
        contribution_to_gap: -5, // GL > CT by 5
        bucket: 'untagged_gl_with_ct',
      },
      options: [
        {
          label: 'option (single) — tag JL to the shift\'s cashbox',
          steps: [
            `UPDATE journal_lines SET cashbox_id='${SHF002_CASHBOX_ID}' WHERE id='${SHF002_JL_ID}'`,
          ],
          before_invariant: {
            tagged_gl_1111: snapshot.tagged_gl_1111,
            untagged_gl_1111: snapshot.untagged_gl_1111,
            global_gl_1111: snapshot.global_gl_1111,
          },
          after_invariant: {
            tagged_gl_1111: snapshot.tagged_gl_1111 + 5,
            untagged_gl_1111: snapshot.untagged_gl_1111 - 5,
            global_gl_1111: snapshot.global_gl_1111, // unchanged
          },
          dml_summary: '1× UPDATE (single field on journal_lines). 0 INSERT. 0 DELETE.',
          audit_trail: 'engine_bypass_alerts will auto-record this UPDATE via the migration-063 trigger.',
        },
      ],
    },

    // Row 3 — settlement #7 / JE-196 (-100 EGP untagged historical)
    {
      id: 'row-3',
      evidence: {
        row_id: 'row-3',
        reference_no: `JE-2026-000196 (employee_settlement #7)`,
        reference_id: SETTLEMENT7_REF_ID,
        description:
          'قيد تصحيح "صرف نقدي لصالح الموظف ابو يوسف" بقيمة 100 EGP، ' +
          'CR 1111 بدون cashbox_id ولا CT مقابل. ' +
          (settle7Evidence?.description ?? ''),
        amount: 100,
        current_state: 'JE-196 jl_1111.cashbox_id=NULL, no matching CT, settlement reference orphan',
        contribution_to_gap: 100, // pushes operational ABOVE GL by 100
        bucket: 'untagged_corrective_je',
      },
      options: [
        {
          label: 'option (a) — write missing CT on الرئيسية + tag JL (assumes 100 EGP physically left the drawer)',
          steps: [
            `UPDATE journal_lines SET cashbox_id='${SHF002_CASHBOX_ID}' WHERE id='${SETTLEMENT7_JL_ID}'`,
            `INSERT INTO cashbox_transactions (cashbox_id, direction, amount, category, reference_type, reference_id, notes) VALUES ('${SHF002_CASHBOX_ID}','out',100,'employee_settlement','employee_settlement','${SETTLEMENT7_REF_ID}','cleanup PR-CASH-RECON: missing CT for settlement #7')`,
          ],
          before_invariant: {
            current_balance: snapshot.current_balance,
            global_gl_1111: snapshot.global_gl_1111,
          },
          after_invariant: {
            current_balance: snapshot.current_balance - 100,
            global_gl_1111: snapshot.global_gl_1111, // unchanged
          },
          dml_summary: '1× UPDATE + 1× INSERT. 0 DELETE.',
          audit_trail: "notes prefix 'cleanup: PR-CASH-RECON-EXEC#3a'.",
        },
        {
          label: 'option (b) — classify JE-196 as accounting-only (no physical cash moved)',
          steps: [
            'No DML on journal_lines; instead post a SECOND corrective JE that reverses JE-196 and re-records under accounting_only=true through the engine.',
            'This requires the engine path; implementer must use FinancialEngine.recordTransaction with accounting_only=true.',
          ],
          before_invariant: {
            current_balance: snapshot.current_balance,
            global_gl_1111: snapshot.global_gl_1111,
          },
          after_invariant: {
            current_balance: snapshot.current_balance,
            global_gl_1111: snapshot.global_gl_1111 + 100, // GL recoups the 100
          },
          dml_summary:
            '1 new JE (engine-mediated) + paired logger.warn from the new accounting_only flow. 0 raw UPDATE/DELETE.',
          audit_trail:
            'New JE description: "تصحيح JE-196 — قيد محاسبي بحت بدون حركة نقدية".',
        },
      ],
    },

    // Row 4 — RET-2026-000003 / CT-245 (-350 EGP cancelled-return orphan)
    {
      id: 'row-4',
      evidence: {
        row_id: 'row-4',
        reference_no: `RET-2026-000003 / CT-${RET003_CT_ID}`,
        reference_id: RET003_REF_ID,
        description:
          'مرتجع تم إلغاؤه بالخطأ. JE-358 (الأصل) is_void=TRUE، JE-378 (reversal) ' +
          'is_void=FALSE يعيد قيد +350 على GL 1111 الرئيسية. لكن CT-245 ' +
          '(cash OUT 350 EGP من الرئيسية، is_void=FALSE) ما زال نشطًا — ' +
          `notes: ${retEvidence?.notes ?? '(none)'}`,
        amount: 350,
        current_state: `CT-${RET003_CT_ID} active (is_void=${retEvidence?.is_void ?? '?'}), JE-358 voided, JE-378 reversal active`,
        contribution_to_gap: -350, // GL > CT by 350 (because reversal +350 stayed but CT -350 also stayed)
        bucket: 'cancelled_return_orphan_ct',
      },
      options: [
        {
          label: 'option (a) — void CT-245 (mirrors the JE-358 void)',
          steps: [
            `UPDATE cashbox_transactions SET is_void=TRUE, void_reason='cleanup PR-CASH-RECON: cancelled return RET-2026-000003 (JE-358 voided, mirror CT void)', voided_at=NOW() WHERE id=${RET003_CT_ID}`,
          ],
          before_invariant: {
            current_balance: snapshot.current_balance,
            tagged_gl_1111: snapshot.tagged_gl_1111,
          },
          after_invariant: {
            current_balance: snapshot.current_balance + 350, // void reverses the OUT
            tagged_gl_1111: snapshot.tagged_gl_1111,         // unchanged
          },
          dml_summary: '1× UPDATE (set is_void on the orphan CT). 0 INSERT. 0 DELETE.',
          audit_trail: 'void_reason field carries the cleanup tag.',
        },
        {
          label: 'option (b) — write counter-CT cash IN +350 (additive, preserves CT-245)',
          steps: [
            `INSERT INTO cashbox_transactions (cashbox_id, direction, amount, category, reference_type, reference_id, notes) VALUES ('${SHF002_CASHBOX_ID}','in',350,'refund_cancellation','reversal','${RET003_REF_ID}','cleanup PR-CASH-RECON: counter-CT for cancelled return RET-2026-000003 (mirrors JE-378 reversal)')`,
          ],
          before_invariant: {
            current_balance: snapshot.current_balance,
            tagged_gl_1111: snapshot.tagged_gl_1111,
          },
          after_invariant: {
            current_balance: snapshot.current_balance + 350,
            tagged_gl_1111: snapshot.tagged_gl_1111,
          },
          dml_summary: '1× INSERT (counter-CT). 0 UPDATE. 0 DELETE. CT-245 stays.',
          audit_trail: "notes prefix 'cleanup: PR-CASH-RECON-EXEC#4b'.",
        },
      ],
    },
  ];

  const total_gap_before = snapshot.ct_minus_global_gl;

  return {
    generated_at: new Date().toISOString(),
    snapshot,
    rows,
    total_gap_before,
    decisions_skeleton: {
      'row-1': '<choose: a | b>',
      'row-2': 'single',
      'row-3': '<choose: a | b>',
      'row-4': '<choose: a | b>',
    },
  };
}

// ─── Renderer (pure) ───────────────────────────────────────────────
export function renderReport(report: CashReconReport): string {
  const lines: string[] = [];
  lines.push('# Cash/GL reconciliation — DRY RUN (read-only)\n');
  lines.push(`Generated at: ${report.generated_at}\n`);
  lines.push('## Snapshot — الخزينة الرئيسية\n');
  const s = report.snapshot;
  lines.push('| Field | Value |');
  lines.push('|---|---:|');
  lines.push(`| current_balance | ${s.current_balance.toFixed(2)} |`);
  lines.push(`| active CT sum | ${s.active_ct_sum.toFixed(2)} |`);
  lines.push(`| tagged GL 1111 | ${s.tagged_gl_1111.toFixed(2)} |`);
  lines.push(`| untagged GL 1111 | ${s.untagged_gl_1111.toFixed(2)} |`);
  lines.push(`| global GL 1111 | ${s.global_gl_1111.toFixed(2)} |`);
  lines.push(`| **gap (operational − global GL)** | **${s.ct_minus_global_gl.toFixed(2)}** |`);
  lines.push('');
  lines.push(`Total gap = **${report.total_gap_before.toFixed(2)} EGP** distributed across the 4 rows below.\n`);
  for (const r of report.rows) {
    lines.push(`## ${r.id}: ${r.evidence.reference_no}\n`);
    lines.push(`**Bucket:** \`${r.evidence.bucket}\`  `);
    lines.push(`**Amount:** ${r.evidence.amount.toFixed(2)} EGP  `);
    lines.push(`**Contribution to gap:** ${r.evidence.contribution_to_gap.toFixed(2)} EGP  `);
    lines.push(`**Current state:** ${r.evidence.current_state}\n`);
    lines.push(`> ${r.evidence.description}\n`);
    for (const opt of r.options) {
      lines.push(`### ${opt.label}\n`);
      lines.push('**Steps:**');
      for (const step of opt.steps) {
        lines.push('```sql');
        lines.push(step);
        lines.push('```');
      }
      lines.push(`**DML summary:** ${opt.dml_summary}  `);
      lines.push(`**Audit trail:** ${opt.audit_trail}\n`);
      lines.push('| Invariant | Before | After |');
      lines.push('|---|---:|---:|');
      const keys = Array.from(
        new Set([...Object.keys(opt.before_invariant), ...Object.keys(opt.after_invariant)]),
      );
      for (const k of keys) {
        const b = opt.before_invariant[k];
        const a = opt.after_invariant[k];
        lines.push(`| ${k} | ${b !== undefined ? b.toFixed(2) : '—'} | ${a !== undefined ? a.toFixed(2) : '—'} |`);
      }
      lines.push('');
    }
  }
  lines.push('## Decisions skeleton (paste into PR-3 input)\n');
  lines.push('```json');
  lines.push(JSON.stringify(report.decisions_skeleton, null, 2));
  lines.push('```\n');
  lines.push('### Safety');
  lines.push('- This script issued only SELECT queries.');
  lines.push('- No DML was executed.');
  lines.push('- No historical row was modified.');
  lines.push('- The `cashboxes.current_balance` was not rebuilt.');
  lines.push('- Run PR-3 with the filled-in decisions file to actually execute the chosen options.');
  return lines.join('\n');
}

// ─── CLI bootstrap (only runs when invoked directly) ───────────────
async function main(): Promise<void> {
  const url =
    process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? '';
  if (!url) {
    console.error(
      'cash-recon-dryrun: DATABASE_URL (or SUPABASE_DB_URL) required',
    );
    process.exit(2);
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const q: QueryFn = async (sql, params = []) => {
      const r = await client.query(sql, params as any[]);
      return r.rows;
    };
    const report = await buildReport(q);
    const md = renderReport(report);
    process.stdout.write(md + '\n');
    const outPath = resolve(process.cwd(), 'cash-recon-decisions.json');
    writeFileSync(
      outPath,
      JSON.stringify(report.decisions_skeleton, null, 2) + '\n',
      'utf8',
    );
    console.error(`\nWrote decisions skeleton to ${outPath}`);
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('cash-recon-dryrun failed:', err);
    process.exit(1);
  });
}
