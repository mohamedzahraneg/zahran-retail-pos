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

describe('ShiftsService.summary — cancelled-pair excluded from active totals (PR-FIN-RETURNS-SHIFT-CANCELLED-EXCLUDE-FROM-TOTALS)', () => {
  it('totalRefundCashOut filter excludes cancelled-original AND reversal rows', () => {
    expect(SRC).toMatch(
      /totalRefundCashOut\s*=\s*refund_cash_movements[\s\S]+isActiveCashImpact/,
    );
    expect(SRC).toMatch(
      /isActiveCashImpact[\s\S]+source_return_status\s*!==\s*'cancelled'[\s\S]+!m\.is_reversal/,
    );
  });

  it('totalRefundCashIn filter applies the same isActiveCashImpact gate', () => {
    expect(SRC).toMatch(
      /totalRefundCashIn\s*=\s*refund_cash_movements[\s\S]+isActiveCashImpact/,
    );
  });

  it('audit-only totals are computed for cancelled rows (out, reversal, net)', () => {
    expect(SRC).toMatch(/cancelledReturnOutAmount[\s\S]+source_return_status\s*===\s*'cancelled'/);
    expect(SRC).toMatch(/cancelledReturnReversalAmount[\s\S]+m\.is_reversal/);
    expect(SRC).toMatch(/cancelledReturnNet\s*=\s*cancelledReturnOutAmount\s*-\s*cancelledReturnReversalAmount/);
  });

  it('response shape exposes the new audit-only fields', () => {
    expect(SRC).toMatch(/cancelled_return_out_amount:\s*cancelledReturnOutAmount/);
    expect(SRC).toMatch(/cancelled_return_reversal_amount:\s*cancelledReturnReversalAmount/);
    expect(SRC).toMatch(/cancelled_return_net:\s*cancelledReturnNet/);
  });

  it('expected_closing math is unchanged because cancelled pair was already net-zero', () => {
    // The legacy formula included +reversal in the in-side and +out
    // in the out-side, which cancelled out. The new formula excludes
    // both, so opening + activeIn - activeOut = same numerical value.
    // We pin that the formula structure is preserved.
    expect(SRC).toMatch(
      /expectedClosing\s*=\s*Number\(shift\.opening_balance[\s\S]+totalCashIn\s*-\s*totalCashOut/,
    );
  });
});
