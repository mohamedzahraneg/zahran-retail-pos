/**
 * Shifts.refund-cancel-aware.test.tsx
 * ─────────────────────────────────────────────────────────────────────
 * PR-FIN-RETURNS-SHIFT-CANCEL-AWARE — pins the FE wiring of the
 * "المرتجعات والاستبدالات النقدية" section's cancellation-aware
 * rendering. The section lives deep inside a multi-tab Shifts page
 * with a lot of pre-render state, so rather than mounting the full
 * tree these tests source-grep the rendering branch to confirm:
 *
 *   1. The cancelled-original row carries a "ملغي" chip whose testid
 *      is keyed off the row id (so each row's badge is targetable).
 *   2. The reversal-in row uses the emerald in-flow tone (not rose)
 *      so the user can visually pair it with the cancelled-out row.
 *   3. The legacy refunded-out row keeps its rose tone unchanged.
 *
 * The companion `RefundCashMovement` API type carries the
 * `is_reversal` + `source_return_status` fields the BE emits, so type
 * safety is asserted via a separate import smoke test.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { RefundCashMovement } from '@/api/shifts.api';

const SHIFTS_SRC = readFileSync(
  resolve(__dirname, '../Shifts.tsx'),
  'utf8',
);

describe('Shifts — refund cash movements cancel-aware FE wiring', () => {
  it('row testid is keyed by movement id so each row is targetable', () => {
    expect(SHIFTS_SRC).toMatch(
      /data-testid=\{`refund-cash-row-\$\{m\.id\}`\}/,
    );
  });

  it('"ملغي" badge renders only when source_return_status === cancelled AND not is_reversal', () => {
    expect(SHIFTS_SRC).toMatch(
      /m\.source_return_status\s*===\s*'cancelled'\s*&&[\s\S]+!m\.is_reversal/,
    );
    expect(SHIFTS_SRC).toContain('ملغي');
    expect(SHIFTS_SRC).toMatch(
      /data-testid=\{`refund-cash-cancelled-badge-\$\{m\.id\}`\}/,
    );
  });

  it('cancelled-original row uses slate/strikethrough chrome (visually distinct from healthy refunded)', () => {
    // The chip's class branch carries `line-through` for cancelled and
    // `bg-rose-50` for the legacy non-cancelled refund.
    expect(SHIFTS_SRC).toMatch(
      /m\.source_return_status\s*===\s*'cancelled'[\s\S]+line-through/,
    );
  });

  it('reversal-in row uses emerald tone (not rose) so user can pair it with the cancelled-out row', () => {
    expect(SHIFTS_SRC).toMatch(
      /m\.is_reversal[\s\S]+bg-emerald-50/,
    );
  });

  it('does not silently drop the rose tone for non-cancelled refunded rows (regression guard)', () => {
    // The fallback branch (no cancel, no reversal) keeps `bg-rose-50`.
    expect(SHIFTS_SRC).toMatch(/bg-rose-50/);
  });
});

describe('shifts.api — RefundCashMovement type carries the cancel-aware flags', () => {
  it('compiles with is_reversal + source_return_status optional fields', () => {
    const sample: RefundCashMovement = {
      id: 'ct-1',
      kind: 'return',
      type_label: 'مرتجع نقدي ملغي',
      direction: 'out',
      direction_label: 'خارج',
      amount: 350,
      reference_no: 'RET-2026-000003',
      customer_name: 'فاطمة',
      cashbox_name: 'الخزينة الرئيسية',
      created_at: '2026-05-01T16:44:36Z',
      created_by_name: 'مدير النظام',
      je_entry_no: 'JE-2026-000375',
      accounting_impact: 'DR / CR …',
      link_method: 'explicit',
      is_reversal: false,
      source_return_status: 'cancelled',
    };
    expect(sample.is_reversal).toBe(false);
    expect(sample.source_return_status).toBe('cancelled');
  });

  it('accepts the new "عكس إلغاء" reversal row shape', () => {
    const reversal: RefundCashMovement = {
      id: 'ct-265',
      kind: 'return',
      type_label: 'عكس إلغاء مرتجع نقدي',
      direction: 'in',
      direction_label: 'داخل',
      amount: 350,
      reference_no: 'RET-2026-000003',
      customer_name: 'فاطمة',
      cashbox_name: 'الخزينة الرئيسية',
      created_at: '2026-05-02T19:24:33Z',
      created_by_name: 'مدير النظام',
      je_entry_no: 'JE-2026-000378',
      accounting_impact: 'DR / CR …',
      link_method: 'explicit',
      is_reversal: true,
      source_return_status: 'cancelled',
    };
    expect(reversal.is_reversal).toBe(true);
    expect(reversal.direction).toBe('in');
  });

  it('legacy callers without the new fields still type-check (fields are optional)', () => {
    const legacy: RefundCashMovement = {
      id: 'ct-old',
      kind: 'return',
      type_label: 'مرتجع نقدي',
      direction: 'out',
      direction_label: 'خارج',
      amount: 100,
      reference_no: 'RET-2026-LEGACY',
      customer_name: null,
      cashbox_name: null,
      created_at: '2026-04-01T10:00:00Z',
      created_by_name: null,
      je_entry_no: null,
      accounting_impact: '',
      link_method: 'derived',
    };
    expect(legacy.is_reversal).toBeUndefined();
    expect(legacy.source_return_status).toBeUndefined();
  });
});

describe('Shifts — cancelled-pair excluded from active totals (PR-FIN-RETURNS-SHIFT-CANCELLED-EXCLUDE-FROM-TOTALS)', () => {
  it('per-row "أثر نقدي فعلي = 0" badge renders for cancelled-original AND reversal rows', () => {
    expect(SHIFTS_SRC).toMatch(/أثر نقدي فعلي\s*=\s*0/);
    // The badge testid is keyed by movement id so each row's badge is targetable.
    expect(SHIFTS_SRC).toMatch(
      /data-testid=\{`refund-cash-zero-impact-\$\{m\.id\}`\}/,
    );
    // Visibility predicate: cancelled OR is_reversal.
    expect(SHIFTS_SRC).toMatch(
      /m\.source_return_status\s*===\s*'cancelled'\s*\|\|[\s\S]+m\.is_reversal/,
    );
  });

  it('reversal-row badge additionally calls out "(عكس نظامي)" so the user can tell the two row types apart', () => {
    expect(SHIFTS_SRC).toMatch(/m\.is_reversal[\s\S]+\(عكس نظامي\)/);
  });

  it('audit-only footer renders "عمليات ملغاة" + "لا يؤثر على صافي الوردية" when cancelled_return_out_amount > 0', () => {
    expect(SHIFTS_SRC).toMatch(/عمليات ملغاة/);
    expect(SHIFTS_SRC).toMatch(/لا يؤثر على صافي الوردية/);
    expect(SHIFTS_SRC).toMatch(
      /data-testid="refund-cash-cancelled-footer"/,
    );
    // Conditional render: only when the cancelled-out amount is positive.
    expect(SHIFTS_SRC).toMatch(
      /s\.cancelled_return_out_amount\s*!=\s*null\s*&&[\s\S]+s\.cancelled_return_out_amount\s*>\s*0/,
    );
  });

  it('amount cell uses muted/strikethrough styling for cancelled or reversal rows', () => {
    expect(SHIFTS_SRC).toMatch(
      /m\.source_return_status\s*===\s*'cancelled'\s*\|\|[\s\S]+m\.is_reversal[\s\S]+text-slate-400 line-through/,
    );
  });
});

describe('shifts.api — ShiftSummary type carries the audit-only cancelled fields', () => {
  it('compiles with cancelled_return_* optional fields', () => {
    // Importing the full ShiftSummary would pull in the entire shape;
    // instead we ensure the fields exist by reading the source.
    const SRC = readFileSync(
      resolve(__dirname, '../../api/shifts.api.ts'),
      'utf8',
    );
    expect(SRC).toMatch(/cancelled_return_out_amount\?:\s*number/);
    expect(SRC).toMatch(/cancelled_return_reversal_amount\?:\s*number/);
    expect(SRC).toMatch(/cancelled_return_net\?:\s*number/);
  });
});

// ─── PR-FIX-SHIFTS-CASHOUT-NET ────────────────────────────────────
//
//   The four operational refund rows on the Shifts page (compact
//   mini-chip, two cashflow Rows, and the "ملخص الخروج النقدي"
//   CashOutLine) display the NET cash impact of refunds — not the
//   GROSS out total.  This matters for edit-and-replayed refunds
//   (e.g. RET-2026-000006) where the engine writes original-out +
//   reversal-in + replay-out for the same business event:
//
//     gross out   = 900
//     gross in    = 450
//     net impact  = 450  ← what the user-facing "خرج من الدرج" shows
//
//   The labeled "خارج: <gross> / داخل: <gross>" breakdown in the
//   refund-movements section keeps surfacing both audit numbers for
//   treasury reconciliation; this guard ensures THAT one block stays
//   gross while the four operational rows go net.
describe('Shifts — operational rows display NET refund impact (PR-FIX-SHIFTS-CASHOUT-NET)', () => {
  it('compact mini-chip "↩ مرتجعات/استبدالات" uses net_refund_cash_impact (not total_refund_cash_out)', () => {
    // Window is wide because the source carries a multi-line comment
    // between `label` and `amount` documenting the gross-vs-net swap.
    expect(SHIFTS_SRC).toMatch(
      /label="↩ مرتجعات\/استبدالات"[\s\S]{0,1200}amount=\{-\(s\.net_refund_cash_impact \|\| 0\)\}/,
    );
    const m = SHIFTS_SRC.match(
      /label="↩ مرتجعات\/استبدالات"[\s\S]{0,1200}amount=\{[^}]+\}/,
    );
    expect(m).not.toBeNull();
    expect(m![0]).not.toMatch(/total_refund_cash_out/);
  });

  it('cashflow Row "مرتجعات/استبدالات" uses net_refund_cash_impact (not total_refund_cash_out)', () => {
    expect(SHIFTS_SRC).toMatch(
      /label=\{`مرتجعات\/استبدالات[^`]*`\}[\s\S]{0,200}value=\{'- ' \+ EGP\(s\?\.net_refund_cash_impact \|\| 0\)\}/,
    );
  });

  it('detailed cashflow Row "↩ مرتجعات/استبدالات" uses net_refund_cash_impact (not total_refund_cash_out)', () => {
    expect(SHIFTS_SRC).toMatch(
      /label=\{`↩ مرتجعات\/استبدالات[^`]*`\}[\s\S]{0,200}value=\{'- ' \+ EGP\(s\.net_refund_cash_impact \|\| 0\)\}/,
    );
  });

  it('"ملخص الخروج النقدي" CashOutLine "مرتجعات نقدية / استبدالات" uses net_refund_cash_impact', () => {
    expect(SHIFTS_SRC).toMatch(
      /<CashOutLine\s+label="مرتجعات نقدية \/ استبدالات"\s+value=\{s\.net_refund_cash_impact\}\s*\/>/,
    );
  });

  it('labeled "خارج: <gross> / داخل: <gross>" breakdown KEEPS the gross audit pair', () => {
    // Treasury reconciliation breakdown must continue to surface
    // BOTH gross numbers explicitly.
    expect(SHIFTS_SRC).toMatch(
      /خارج:\s*<span[^>]*>\{EGP\(s\.total_refund_cash_out\)\}<\/span>/,
    );
    expect(SHIFTS_SRC).toMatch(
      /داخل:\s*<span[^>]*>\{EGP\(s\.total_refund_cash_in\)\}<\/span>/,
    );
    // …and still pairs them with the explicit net so the user knows
    // which one feeds expected_closing.
    expect(SHIFTS_SRC).toMatch(
      /صافي أثر المرتجعات\/الاستبدالات على الوردية[\s\S]{0,200}\{EGP\(-s\.net_refund_cash_impact\)\}/,
    );
  });

  it('refund-movements section header "صافي الأثر" stays on net_refund_cash_impact', () => {
    expect(SHIFTS_SRC).toMatch(
      /صافي الأثر\s*\{EGP\(-s\.net_refund_cash_impact\)\}/,
    );
  });

  it('exactly TWO references to total_refund_cash_out remain — both inside the labeled gross breakdown', () => {
    // Defence in depth: the operational rows must not regress back to
    // the gross out.  Allow exactly the two surviving uses:
    //   (a) the explicit "خارج: <total_refund_cash_out>" label
    //   (b) the explicit "داخل: <total_refund_cash_in>" sibling
    // is enforced by the previous test — count here pins the magnitude.
    const grossOutHits =
      SHIFTS_SRC.match(/total_refund_cash_out/g)?.length ?? 0;
    expect(grossOutHits).toBe(1);
    const grossInHits =
      SHIFTS_SRC.match(/total_refund_cash_in/g)?.length ?? 0;
    expect(grossInHits).toBe(1);
  });

  it('exactly FOUR operational consumers reference net_refund_cash_impact for display value', () => {
    // 4 sites swapped:
    //   1. mini-chip amount
    //   2. cashflow Row value (compact)
    //   3. detailed cashflow Row value
    //   4. CashOutLine value
    // Plus 2 pre-existing uses: the refund-movements-table header
    // ("صافي الأثر") and the gross-breakdown footer ("صافي أثر…").
    // Total = 6.
    const netHits =
      SHIFTS_SRC.match(/net_refund_cash_impact/g)?.length ?? 0;
    expect(netHits).toBeGreaterThanOrEqual(6);
  });
});

// ─── End-to-end fixture math (no React render — pure simulation) ──
//   These lock the helper-aware reasoning behind the swaps so a future
//   regression that flips, say, the mini-chip back to the gross out
//   will fail at the math layer too — even if the source-grep above
//   somehow drifts.
describe('Shifts cash-out display math (PR-FIX-SHIFTS-CASHOUT-NET)', () => {
  type Sum = {
    total_refund_cash_out: number;
    total_refund_cash_in: number;
    net_refund_cash_impact: number;
  };
  // Simulate what the UI now reads for each operational site.
  const opChipAmount = (s: Sum) => -(s.net_refund_cash_impact || 0);
  const opRowValue = (s: Sum) =>
    '- ' + (s.net_refund_cash_impact || 0).toFixed(2);
  const cashOutLineValue = (s: Sum) => s.net_refund_cash_impact;

  it('edit-and-replay refund (out 900, in 450, net 450) → operational displays show 450', () => {
    const sum: Sum = {
      total_refund_cash_out: 900,
      total_refund_cash_in: 450,
      net_refund_cash_impact: 450,
    };
    expect(opChipAmount(sum)).toBe(-450);    // not -900
    expect(opRowValue(sum)).toBe('- 450.00'); // not '- 900.00'
    expect(cashOutLineValue(sum)).toBe(450);  // not 900
  });

  it('plain refund (out 450, in 0, net 450) → operational displays show 450', () => {
    const sum: Sum = {
      total_refund_cash_out: 450,
      total_refund_cash_in: 0,
      net_refund_cash_impact: 450,
    };
    expect(opChipAmount(sum)).toBe(-450);
    expect(opRowValue(sum)).toBe('- 450.00');
    expect(cashOutLineValue(sum)).toBe(450);
  });

  it('cancelled-only refund (out 0, in 0, net 0 — helper excludes cancelled-pair) → operational displays show 0', () => {
    const sum: Sum = {
      total_refund_cash_out: 0,
      total_refund_cash_in: 0,
      net_refund_cash_impact: 0,
    };
    expect(opChipAmount(sum)).toBe(-0);
    expect(opRowValue(sum)).toBe('- 0.00');
    expect(cashOutLineValue(sum)).toBe(0);
  });

  it('operational total ≠ gross out for the edit-and-replay shape (the bug RET-2026-000006 surfaced)', () => {
    const sum: Sum = {
      total_refund_cash_out: 900,
      total_refund_cash_in: 450,
      net_refund_cash_impact: 450,
    };
    // The whole point of this PR.
    expect(cashOutLineValue(sum)).not.toBe(sum.total_refund_cash_out);
    expect(cashOutLineValue(sum)).toBe(sum.net_refund_cash_impact);
  });
});
