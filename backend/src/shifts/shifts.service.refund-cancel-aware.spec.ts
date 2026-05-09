/**
 * shifts.service.refund-cancel-aware.spec.ts
 * ─────────────────────────────────────────────────────────────────────
 * PR-FIN-RETURNS-SHIFT-CANCEL-AWARE — pins the SQL contract for the
 * refund_cash_movements section of the shift summary report.
 *
 * The bug: the original CT scan filtered to
 *   reference_type::text IN ('return','exchange')
 * which silently excluded the cancellation reversal CTs that
 * `posting.reverseByReference` writes with `reference_type='other'` +
 * `category LIKE 'reversal_%'`. A user who cancelled a cash refund
 * still saw the original "out" line in the shift report with no
 * matching "in" → net effect of the cancelled return ≠ 0.
 *
 * The fix expands the WHERE clause to also include rows where
 *   reference_type::text = 'other' AND category LIKE 'reversal_%'
 * and bridges those CTs back to their source return via the reversal
 * JE chain so the FE can pair the original-out and reversal-in rows
 * for the same return_no.
 *
 * These tests pin the new SQL shape via a stub DataSource — no
 * Postgres is required.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(
  resolve(__dirname, './shifts.service.ts'),
  'utf8',
);

describe('ShiftsService.summary — refund_cash_movements cancel-aware SQL', () => {
  it('CT scan WHERE clause now also accepts reference_type=other + category LIKE reversal_%', () => {
    expect(SRC).toMatch(
      /reference_type::text\s*=\s*'other'[\s\S]+category\s+LIKE\s+'reversal_%'/,
    );
  });

  it('keeps the original (return/exchange) branch — non-cancel flows still aggregated', () => {
    expect(SRC).toMatch(
      /reference_type::text\s+IN\s*\(\s*'return'\s*,\s*'exchange'\s*\)/,
    );
  });

  it('bridges reversal CT → original JE → return via a single LEFT JOIN hop', () => {
    // PR-FIN-RETURNS-SHIFT-CANCEL-AWARE-BRIDGE-FIX —
    // `posting.reverseByReference` writes paired CT rows with
    // `reference_id = orig.id` (the ORIGINAL JE id, NOT the
    // newly-created reversal JE id). So the reversal CT's
    // `reference_id` already points directly at the original return
    // JE, and the bridge needs ONE hop, not three.
    expect(SRC).toMatch(
      /je_orig[\s\S]+je_orig\.id\s*=\s*ct\.reference_id[\s\S]+je_orig\.reference_type::text\s*=\s*'return'/,
    );
    expect(SRC).toMatch(
      /r_via_je[\s\S]+r_via_je\.id\s*=\s*je_orig\.reference_id/,
    );
    // The old (broken) intermediate `je_rev` JOIN must be gone.
    expect(SRC).not.toMatch(/je_rev\.id\s*=\s*ct\.reference_id/);
    expect(SRC).not.toMatch(/je_orig\.id\s*=\s*je_rev\.reversal_of/);
  });

  it('exposes source_return_status so the FE can render "ملغي" badges', () => {
    expect(SRC).toMatch(/source_return_status/);
  });

  it('exposes is_reversal so the FE can pair rows + label عكس correctly', () => {
    expect(SRC).toMatch(/is_reversal/);
    // The mapped row label set covers all three states.
    expect(SRC).toMatch(/'عكس إلغاء مرتجع نقدي'/);
    expect(SRC).toMatch(/'مرتجع نقدي ملغي'/);
    expect(SRC).toMatch(/'مرتجع نقدي'/);
  });

  it('classifies reversal-bridged rows as a fourth link_method then maps to explicit', () => {
    // Inside the SQL CTE the link_method may be set to 'reversal'
    // (so we never lose the row to the WHERE link_method IS NOT NULL
    // filter), and the JS mapping flattens that to 'explicit' so the
    // existing FE consumer keeps its narrow union type.
    expect(SRC).toMatch(/link_method\s*===\s*'reversal'\s*\?\s*'explicit'/);
  });

  it('only-active CTs are aggregated (is_void=FALSE) — no double-count if the original refund is later voided', () => {
    expect(SRC).toMatch(/ct\.is_void\s*=\s*FALSE/);
  });

  it('filters reversal CTs to THIS shift via the bridged return.shift_id (no cross-shift bleed)', () => {
    expect(SRC).toMatch(
      /reference_type::text\s*=\s*'other'[\s\S]+resolved_return_id\s+IS\s+NOT\s+NULL[\s\S]+src_shift_id\s*=\s*\$4/,
    );
  });

  it('emits no DELETE / no UPDATE / no fn_record_cashbox_txn — read-only refund report block', () => {
    // Defense-in-depth: the refund_cash_movements builder must never
    // mutate state. Walk a slice of the source covering the SQL.
    const start = SRC.indexOf('PR-FIN-RETURNS-SHIFT-CANCEL-AWARE');
    const window = SRC.substring(start, start + 8000);
    expect(window).not.toMatch(/^\s*DELETE\s/im);
    expect(window).not.toMatch(/^\s*UPDATE\s/im);
    expect(window).not.toMatch(/fn_record_cashbox_txn/);
  });
});

describe('ShiftsService.summary — cancelled-pair excluded from active totals (PR-FIN-RETURNS-SHIFT-CANCELLED-EXCLUDE-FROM-TOTALS, updated by PR-FIX-SHIFT-CASH-APPLY-REVERSAL-NET)', () => {
  it('isActiveCashImpact predicate keys ONLY off source_return_status (no longer drops reversal rows blindly)', () => {
    // After PR-FIX-SHIFT-CASH-APPLY-REVERSAL-NET, the apply
    // reverse-and-replay scenario needs the reversal-in to count.
    // The predicate is now scoped purely by source_return_status.
    //
    // We isolate the predicate window (between the const declaration
    // and the closing arrow) so the broader source's audit-only
    // filters — which legitimately still use `!m.is_reversal` for
    // cancelled-pair detection — don't false-positive this check.
    const predicateMatch = SRC.match(
      /const\s+isActiveCashImpact\s*=[\s\S]*?=>\s*[\s\S]*?;/,
    );
    expect(predicateMatch).not.toBeNull();
    const predicate = predicateMatch![0];
    expect(predicate).toMatch(/source_return_status\s*!==\s*'cancelled'/);
    expect(predicate).not.toMatch(/!m\.is_reversal/);
  });

  it('totalRefundCash{Out,In} are computed via the exported helper', () => {
    expect(SRC).toMatch(/computeRefundCashTotals\(/);
    expect(SRC).toMatch(/totalRefundCashOut\s*=\s*refundTotals\.totalRefundCashOut/);
    expect(SRC).toMatch(/totalRefundCashIn\s*=\s*refundTotals\.totalRefundCashIn/);
  });

  it('audit-only cancelled-out total still requires source_return_status === cancelled', () => {
    expect(SRC).toMatch(
      /cancelledReturnOutAmount[\s\S]+source_return_status\s*===\s*'cancelled'/,
    );
  });

  it('audit-only cancelled-reversal total ALSO requires source_return_status === cancelled (so apply-reversals are not counted)', () => {
    // PR-FIX-SHIFT-CASH-APPLY-REVERSAL-NET tightening: the apply
    // case writes a reversal CT whose source return is `refunded`,
    // and that must NOT contribute to the cancelled-reversal audit
    // total.
    expect(SRC).toMatch(
      /cancelledReturnReversalAmount[\s\S]+m\.is_reversal[\s\S]+source_return_status\s*===\s*'cancelled'/,
    );
  });

  it('cancelledReturnNet still equals out − reversal', () => {
    expect(SRC).toMatch(
      /cancelledReturnNet\s*=\s*cancelledReturnOutAmount\s*-\s*cancelledReturnReversalAmount/,
    );
  });

  it('response shape exposes the audit-only fields', () => {
    expect(SRC).toMatch(/cancelled_return_out_amount:\s*cancelledReturnOutAmount/);
    expect(SRC).toMatch(/cancelled_return_reversal_amount:\s*cancelledReturnReversalAmount/);
    expect(SRC).toMatch(/cancelled_return_net:\s*cancelledReturnNet/);
  });

  it('expected_closing math is unchanged — formula structure preserved', () => {
    expect(SRC).toMatch(
      /expectedClosing\s*=\s*Number\(shift\.opening_balance[\s\S]+totalCashIn\s*-\s*totalCashOut/,
    );
  });
});

// ─── Behavioural tests on the exported helper ─────────────────────
//   PR-FIX-SHIFT-CASH-APPLY-REVERSAL-NET — these drive the actual
//   filter+reduce logic (no SQL, no DataSource needed) so a future
//   regression that flips the predicate back gets caught here, not
//   in production.

import { computeRefundCashTotals } from './shifts.service';

describe('computeRefundCashTotals — behavioural (PR-FIX-SHIFT-CASH-APPLY-REVERSAL-NET)', () => {
  it('apply reverse-and-replay on a refunded return: original out 450 + reversal in 450 + replay out 450 → net -450 (NOT -900)', () => {
    // The exact CT shape that landed for RET-2026-000006 after apply.
    // Both `out` rows have source_return_status='refunded'.  The
    // reversal `in` row's source resolves through the JE-bridge to
    // the same `refunded` return.  All three must contribute.
    const totals = computeRefundCashTotals([
      // CT 378 — original refund
      {
        direction: 'out',
        amount: 450,
        is_reversal: false,
        source_return_status: 'refunded',
      },
      // CT 390 — reversal of the original (engine writes this with
      //          reference_type='other', is_reversal=true; the
      //          source still resolves to the refunded return)
      {
        direction: 'in',
        amount: 450,
        is_reversal: true,
        source_return_status: 'refunded',
      },
      // CT 391 — re-post after apply
      {
        direction: 'out',
        amount: 450,
        is_reversal: false,
        source_return_status: 'refunded',
      },
    ]);
    expect(totals.totalRefundCashOut).toBe(900);
    expect(totals.totalRefundCashIn).toBe(450);
    expect(totals.netRefundCashImpact).toBe(450);
    // Display sign is `-net` in the FE; `EGP(-net) = -450`.
    // Audit-only fields stay zero — nothing was cancelled.
    expect(totals.cancelledReturnOutAmount).toBe(0);
    expect(totals.cancelledReturnReversalAmount).toBe(0);
    expect(totals.cancelledReturnNet).toBe(0);
  });

  it('cancelled return: original out 450 + reversal in 450 → net 0 (both excluded from active totals)', () => {
    const totals = computeRefundCashTotals([
      {
        direction: 'out',
        amount: 450,
        is_reversal: false,
        source_return_status: 'cancelled',
      },
      {
        direction: 'in',
        amount: 450,
        is_reversal: true,
        source_return_status: 'cancelled',
      },
    ]);
    expect(totals.totalRefundCashOut).toBe(0);
    expect(totals.totalRefundCashIn).toBe(0);
    expect(totals.netRefundCashImpact).toBe(0);
    // Both surface in the audit-only fields for the FE footer.
    expect(totals.cancelledReturnOutAmount).toBe(450);
    expect(totals.cancelledReturnReversalAmount).toBe(450);
    expect(totals.cancelledReturnNet).toBe(0);
  });

  it('apply-reversal on a refunded return is NOT counted in cancelledReturnReversalAmount', () => {
    // Regression guard: the previous filter
    //   cancelledReturnReversalAmount = m.is_reversal && direction='in'
    // would have included the apply-reversal too — wrong.
    const totals = computeRefundCashTotals([
      {
        direction: 'in',
        amount: 450,
        is_reversal: true,
        source_return_status: 'refunded',
      },
    ]);
    expect(totals.cancelledReturnReversalAmount).toBe(0);
    // It DOES contribute to the active totals though.
    expect(totals.totalRefundCashIn).toBe(450);
  });

  it('mixed shift — refunded apply trio + a cancelled pair: each scenario nets correctly side-by-side', () => {
    const totals = computeRefundCashTotals([
      // Apply trio on refunded return → net -450
      { direction: 'out', amount: 450, is_reversal: false, source_return_status: 'refunded' },
      { direction: 'in',  amount: 450, is_reversal: true,  source_return_status: 'refunded' },
      { direction: 'out', amount: 450, is_reversal: false, source_return_status: 'refunded' },
      // Cancelled pair → net 0 (both excluded from active)
      { direction: 'out', amount: 200, is_reversal: false, source_return_status: 'cancelled' },
      { direction: 'in',  amount: 200, is_reversal: true,  source_return_status: 'cancelled' },
      // Plain refund on a refunded return → -100
      { direction: 'out', amount: 100, is_reversal: false, source_return_status: 'refunded' },
    ]);
    // Active: out = 450 + 450 + 100 = 1000; in = 450; net = 550
    expect(totals.totalRefundCashOut).toBe(1000);
    expect(totals.totalRefundCashIn).toBe(450);
    expect(totals.netRefundCashImpact).toBe(550);
    // Audit-only: cancelled pair contributes 200/200/0
    expect(totals.cancelledReturnOutAmount).toBe(200);
    expect(totals.cancelledReturnReversalAmount).toBe(200);
    expect(totals.cancelledReturnNet).toBe(0);
  });

  it('plain single refund on a refunded return: out 450 → net -450', () => {
    const totals = computeRefundCashTotals([
      { direction: 'out', amount: 450, is_reversal: false, source_return_status: 'refunded' },
    ]);
    expect(totals.totalRefundCashOut).toBe(450);
    expect(totals.totalRefundCashIn).toBe(0);
    expect(totals.netRefundCashImpact).toBe(450);
  });

  it('empty input → all zeros', () => {
    const totals = computeRefundCashTotals([]);
    expect(totals).toEqual({
      totalRefundCashOut: 0,
      totalRefundCashIn: 0,
      netRefundCashImpact: 0,
      cancelledReturnOutAmount: 0,
      cancelledReturnReversalAmount: 0,
      cancelledReturnNet: 0,
    });
  });
});
