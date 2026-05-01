/**
 * cashboxDriftCategorize.test.ts — PR-FIN-PAYACCT-4D-REPORTS-1A-UX-FIX
 *
 * Pure-function tests for the per-reference-id drift categorization.
 * Production fixture: 15 rows summing to +250.00 EGP, with 3 real
 * economic gaps (sum +250) and 12 self-cancelling label-mismatch
 * pairs (sum 0). Verified live during the REPORTS-1A-UX-FIX audit.
 */
import { describe, it, expect } from 'vitest';
import type { CashboxDriftDetailRow } from '@/api/cash-desk.api';
import { categorizeDrift, topContributors } from '../cashboxDriftCategorize';

function row(over: Partial<CashboxDriftDetailRow>): CashboxDriftDetailRow {
  return {
    cashbox_id: 'cb-1', cashbox_name: 'الرئيسية',
    reference_type: 'invoice', reference_id: 'r-1',
    reference_no: null, coverage: 'both',
    ct_count: 1, je_line_count: 1,
    ct_signed_amount: '0', je_signed_amount: '0', drift_amount: '0',
    first_seen_at: null, last_seen_at: null, sample_entry_no: null,
    ...over,
  };
}

describe('categorizeDrift — PR-FIN-PAYACCT-4D-REPORTS-1A-UX-FIX', () => {
  it('returns empty groups for empty input', () => {
    const out = categorizeDrift([]);
    expect(out.real).toEqual([]);
    expect(out.selfCancelling).toEqual([]);
    expect(out.realSum).toBe(0);
    expect(out.selfCancellingSum).toBe(0);
  });

  it('classifies a single non-paired row as "real" (no other row to cancel it)', () => {
    const r = row({ reference_id: 'inv-1', drift_amount: '700.00' });
    const out = categorizeDrift([r]);
    expect(out.real).toHaveLength(1);
    expect(out.selfCancelling).toHaveLength(0);
    expect(out.realSum).toBeCloseTo(700, 2);
  });

  it('classifies inverted-sign pair on the same reference_id as "self-cancelling"', () => {
    const a = row({ reference_type: 'shift',          reference_id: 'shift-1', drift_amount: '17.99'  });
    const b = row({ reference_type: 'shift_variance', reference_id: 'shift-1', drift_amount: '-17.99' });
    const out = categorizeDrift([a, b]);
    expect(out.real).toHaveLength(0);
    expect(out.selfCancelling).toHaveLength(2);
    expect(out.selfCancellingSum).toBeCloseTo(0, 2);
  });

  it('production-shaped fixture: 15 rows sum to +250 with 3 real (+250) + 12 self-cancelling (0)', () => {
    // Compact reproduction of the production state pinned in the audit:
    //   • 3 real economic gaps: invoice +700, return -650, invoice +200.
    //   • 6 self-cancelling pairs (same reference_id, opposite signs):
    //       shift / shift_variance × 3
    //       other / employee_settlement × 1
    //       other / supplier_payment × 1
    //       customer_payment / other × 1
    const real = [
      row({ reference_type: 'invoice', reference_id: 'inv-A', drift_amount: '700.00'  }),
      row({ reference_type: 'return',  reference_id: 'ret-A', drift_amount: '-650.00', coverage: 'CT_only' }),
      row({ reference_type: 'invoice', reference_id: 'inv-B', drift_amount: '200.00'  }),
    ];
    const pairs = [
      ['shift', 'shift_variance', 'shift-1',  '17.99'],
      ['shift', 'shift_variance', 'shift-2',  '-7.00'],
      ['shift', 'shift_variance', 'shift-3',  '-4.00'],
      ['other', 'employee_settlement', 'es-1', '-500.00'],
      ['other', 'supplier_payment',    'sp-1', '-10.00'],
      ['other', 'customer_payment',    'cp-1', '10.00'],
    ] as const;
    const selfRows: CashboxDriftDetailRow[] = [];
    for (const [t1, t2, refId, amt] of pairs) {
      const num = Number(amt);
      selfRows.push(row({ reference_type: t1, reference_id: refId, drift_amount: String(num) }));
      selfRows.push(row({ reference_type: t2, reference_id: refId, drift_amount: String(-num) }));
    }
    const all = [...real, ...selfRows];
    expect(all).toHaveLength(15);

    const out = categorizeDrift(all);
    expect(out.real).toHaveLength(3);
    expect(out.realSum).toBeCloseTo(250, 2);
    expect(out.selfCancelling).toHaveLength(12);
    expect(out.selfCancellingSum).toBeCloseTo(0, 2);
  });

  it('uses 0.01 epsilon to treat near-zero pair sums as self-cancelling', () => {
    // Floating-point noise: 0.10 + 0.20 - 0.30 = 5.55e-17 in IEEE-754,
    // not exactly 0. The categorizer must not classify those as "real".
    const r1 = row({ reference_id: 'rid', drift_amount: '0.10' });
    const r2 = row({ reference_id: 'rid', drift_amount: '0.20' });
    const r3 = row({ reference_id: 'rid', drift_amount: '-0.30' });
    const out = categorizeDrift([r1, r2, r3]);
    expect(out.selfCancelling).toHaveLength(3);
    expect(out.real).toHaveLength(0);
  });
});

describe('topContributors — PR-FIN-PAYACCT-4D-REPORTS-1A-UX-FIX', () => {
  it('returns rows sorted by absolute drift desc', () => {
    const r1 = row({ reference_id: 'r1', drift_amount: '100.00' });
    const r2 = row({ reference_id: 'r2', drift_amount: '-700.00' });
    const r3 = row({ reference_id: 'r3', drift_amount: '200.00' });
    const out = topContributors([r1, r2, r3]);
    expect(out.map((r) => r.reference_id)).toEqual(['r2', 'r3', 'r1']);
  });

  it('honours the limit (default 5)', () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row({ reference_id: `r${i}`, drift_amount: String(i + 1) }),
    );
    expect(topContributors(rows)).toHaveLength(5);
    expect(topContributors(rows, 3)).toHaveLength(3);
    expect(topContributors(rows, 0)).toHaveLength(0);
  });

  it('does not mutate the input array', () => {
    const rows = [
      row({ reference_id: 'a', drift_amount: '10' }),
      row({ reference_id: 'b', drift_amount: '20' }),
    ];
    const before = rows.map((r) => r.reference_id);
    topContributors(rows);
    expect(rows.map((r) => r.reference_id)).toEqual(before);
  });
});
