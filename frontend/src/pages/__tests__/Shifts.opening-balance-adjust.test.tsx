/**
 * Shifts.opening-balance-adjust.test.tsx
 * PR-FIX-SHIFTS-OPENING-BALANCE-ADJUST (migration 128)
 *
 * Pins the FE wiring of the new opening-balance adjustment surface
 * on the Shifts page.  Following the established pattern for the
 * Shifts page (which is too large + state-heavy to mount in a focused
 * unit test), this spec is mostly source-grep driven — it locks the
 * exact conditions / copy / API calls / query invalidations into
 * place so a future regression in any of them fails CI.
 *
 * Behavior covered (mirrors the brief's required-test list):
 *
 *   1. Button visible only when shift.status === 'open' AND
 *      hasPermission('shifts.opening_balance.adjust') — checked via
 *      the surrounding conditional wrapping the button JSX.
 *   2. Button hidden when status !== 'open' (closed / pending_close).
 *   3. Button hidden for users without the permission.
 *   4. Modal reason validation: trim().length >= 5.
 *   5. Modal numeric validation: finite + >= 0 + |Δ| > 0.005.
 *   6. Movements-aware acknowledgement checkbox required when the
 *      summary's cash totals indicate any movement.
 *   7. Submit calls `shiftsApi.adjustOpeningBalance(id, body)` with
 *      the spec'd body shape (new_opening_balance + reason + notes).
 *   8. Success handler invalidates the three relevant query keys
 *      (shift-detail, shift-opening-balance-adjustments, shifts).
 *   9. Adjustment history component renders with the spec'd table
 *      columns + "تعديل" counter.
 *  10. Source-grep — no JE / CT / SM strings, no accounting_only,
 *      no approveApproval / rejectApproval calls introduced by
 *      this PR (regression guard against scope creep).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { ShiftOpeningBalanceAdjustment } from '@/api/shifts.api';

const SHIFTS_SRC = readFileSync(
  resolve(__dirname, '../Shifts.tsx'),
  'utf8',
);

const API_SRC = readFileSync(
  resolve(__dirname, '../../api/shifts.api.ts'),
  'utf8',
);

// ─── 1. Button visibility ───────────────────────────────────────────

describe('Shifts — تعديل الرصيد الافتتاحي button visibility', () => {
  it('button is gated on isOpen && canAdjustOpeningBalance', () => {
    expect(SHIFTS_SRC).toMatch(
      /isOpen\s*&&\s*canAdjustOpeningBalance[\s\S]+تعديل الرصيد الافتتاحي/,
    );
    // Test-id used by the future render-level test if one ships.
    expect(SHIFTS_SRC).toContain(
      'data-testid="shift-adjust-opening-balance-trigger"',
    );
  });

  it('canAdjustOpeningBalance is sourced from the new permission', () => {
    expect(SHIFTS_SRC).toMatch(
      /const canAdjustOpeningBalance = hasPermission\([\s\S]*?['"]shifts\.opening_balance\.adjust['"]/,
    );
  });

  it('the closed-shift adjust-COUNT button stays gated on !isOpen (regression guard for the existing PR-B1 path)', () => {
    // The old "تعديل مبلغ الإقفال" button must still be gated on
    // !isOpen — we did NOT relax it as part of this PR.
    expect(SHIFTS_SRC).toMatch(
      /!isOpen\s*&&\s*canAdjustCount[\s\S]+تعديل مبلغ الإقفال/,
    );
  });
});

// ─── 2. Modal validation ───────────────────────────────────────────

describe('Shifts — AdjustOpeningBalanceModal validation', () => {
  it('reason validation requires trim().length >= 5', () => {
    expect(SHIFTS_SRC).toMatch(
      /reasonValid\s*=\s*reason\.trim\(\)\.length\s*>=\s*5/,
    );
  });

  it('numeric validation: finite + non-negative + non-noop delta', () => {
    expect(SHIFTS_SRC).toMatch(
      /Number\.isFinite\(newOpeningNum\)[\s\S]+newOpeningNum\s*>=\s*0[\s\S]+Math\.abs\(newOpeningNum\s*-\s*currentOpening\)\s*>\s*0\.005/,
    );
  });

  it('movements-aware acknowledgement gate: hasMovements ? acknowledged : true', () => {
    expect(SHIFTS_SRC).toMatch(
      /movementGate\s*=\s*hasMovements\s*\?\s*acknowledged\s*:\s*true/,
    );
    expect(SHIFTS_SRC).toMatch(
      /canSave\s*=\s*newOpeningValid\s*&&\s*reasonValid\s*&&\s*movementGate/,
    );
  });

  it('checkbox label carries the spec\'d Arabic copy (only when hasMovements)', () => {
    // The full "أفهم أن المتوقع وفروقات الكاش ستُعاد حسابها" string
    // appears INSIDE a conditional `{hasMovements && (` block.
    expect(SHIFTS_SRC).toMatch(
      /\{hasMovements\s*&&\s*\([\s\S]+أفهم أن المتوقع وفروقات الكاش ستُعاد حسابها/,
    );
  });

  it('shows the standalone movements warning when hasMovements is true', () => {
    expect(SHIFTS_SRC).toMatch(
      /\{hasMovements\s*&&\s*\([\s\S]+هذه الوردية لديها حركات كاش\. تعديل الرصيد الافتتاحي سيعيد\s*حساب المتوقع والفروقات/,
    );
  });

  it('renders the readonly current-balance display in the modal', () => {
    expect(SHIFTS_SRC).toContain(
      'data-testid="shift-adjust-opening-balance-current"',
    );
    expect(SHIFTS_SRC).toMatch(
      /الرصيد الحالي[\s\S]+EGP\(currentOpening\)/,
    );
  });

  it('numeric input has min=0 step=0.01 + the spec\'d test id', () => {
    expect(SHIFTS_SRC).toMatch(
      /<input[\s\S]+type="number"[\s\S]+min="0"[\s\S]+step="0\.01"[\s\S]+data-testid="shift-adjust-opening-balance-input"/,
    );
  });
});

// ─── 3. Submit wiring ───────────────────────────────────────────────

describe('Shifts — AdjustOpeningBalanceModal submit', () => {
  it('save mutation calls shiftsApi.adjustOpeningBalance with the spec\'d body', () => {
    expect(SHIFTS_SRC).toMatch(
      /mutationFn:\s*\(\)\s*=>\s*shiftsApi\.adjustOpeningBalance\(shift\.id,\s*\{[\s\S]+new_opening_balance:\s*newOpeningNum[\s\S]+reason:\s*reason\.trim\(\)[\s\S]+notes:\s*notes\.trim\(\)\s*\|\|\s*undefined/,
    );
  });

  it('success toast carries the spec\'d Arabic copy', () => {
    expect(SHIFTS_SRC).toContain(
      "toast.success('تم تعديل الرصيد الافتتاحي بنجاح')",
    );
  });

  it('onSaved invalidates the three relevant query keys', () => {
    // The onSaved closure invalidates: shift-detail (by id),
    // shift-opening-balance-adjustments (by id), and shifts (list).
    expect(SHIFTS_SRC).toMatch(
      /queryKey:\s*\['shift-detail',\s*shift\.id\][\s\S]+queryKey:\s*\['shift-opening-balance-adjustments',\s*shift\.id\][\s\S]+queryKey:\s*\['shifts'\]/,
    );
  });

  it('hasMovements signal is derived from the live summary cash totals', () => {
    // The detail-modal render passes hasMovements down using
    // total_cash_in / total_cash_out from the summary.
    expect(SHIFTS_SRC).toMatch(
      /hasMovements=\{[\s\S]+s\?\.total_cash_in[\s\S]+s\?\.total_cash_out[\s\S]+\}/,
    );
  });

  it('submit button is disabled until canSave + not pending', () => {
    expect(SHIFTS_SRC).toMatch(
      /disabled=\{!canSave\s*\|\|\s*save\.isPending\}[\s\S]+data-testid="shift-adjust-opening-balance-submit"/,
    );
  });
});

// ─── 4. History display ─────────────────────────────────────────────

describe('Shifts — opening-balance adjustment history display', () => {
  it('useQuery loads opening-balance adjustments via the new endpoint', () => {
    expect(SHIFTS_SRC).toMatch(
      /queryKey:\s*\['shift-opening-balance-adjustments',\s*shift\.id\][\s\S]+queryFn:\s*\(\)\s*=>\s*shiftsApi\.listOpeningBalanceAdjustments\(shift\.id\)/,
    );
  });

  it('history component renders only when there is at least one adjustment', () => {
    expect(SHIFTS_SRC).toMatch(
      /openingAdjustments\.length\s*>\s*0[\s\S]+ShiftOpeningBalanceAdjustmentHistory/,
    );
  });

  it('history table carries the spec\'d columns', () => {
    const idx = SHIFTS_SRC.indexOf('ShiftOpeningBalanceAdjustmentHistory');
    expect(idx).toBeGreaterThan(-1);
    // The component declaration block (about 80 lines below the
    // first reference) lists the table headers.
    expect(SHIFTS_SRC).toMatch(/سجل تعديلات الرصيد الافتتاحي/);
    // Header row.
    expect(SHIFTS_SRC).toMatch(/التاريخ والوقت[\s\S]+من عدّل[\s\S]+السبب[\s\S]+القديم[\s\S]+الجديد[\s\S]+عند التعديل/);
    // Per-row "movements at adjust" badge.
    expect(SHIFTS_SRC).toContain('يوجد حركات');
    expect(SHIFTS_SRC).toContain('لا حركات');
    // Container test-id.
    expect(SHIFTS_SRC).toContain('data-testid="shift-opening-balance-history"');
  });

  it('the api client exports adjustOpeningBalance + listOpeningBalanceAdjustments', () => {
    expect(API_SRC).toMatch(
      /adjustOpeningBalance:\s*\(\s*id: string,[\s\S]+api\.post\(`\/shifts\/\$\{id\}\/adjust-opening-balance`/,
    );
    expect(API_SRC).toMatch(
      /listOpeningBalanceAdjustments:\s*\(\s*id: string\)\s*=>[\s\S]+api\.get\(`\/shifts\/\$\{id\}\/opening-balance-adjustments`/,
    );
  });
});

// ─── 5. Type smoke test ─────────────────────────────────────────────

describe('shifts.api — ShiftOpeningBalanceAdjustment type', () => {
  it('compiles with all the BE-projected fields', () => {
    const sample: ShiftOpeningBalanceAdjustment = {
      id: 'a-1',
      shift_id: 'sh-1',
      old_opening_balance: '500.00',
      new_opening_balance: '1000.00',
      old_expected_closing: '500.00',
      new_expected_closing: '1000.00',
      shift_status_at_adjust: 'open',
      has_movements_at_adjust: false,
      reason: 'تصحيح بعد إعادة العد',
      notes: null,
      adjusted_by: 'u-1',
      adjusted_by_name: 'مدير النظام',
      adjusted_at: '2026-05-10T08:00:00Z',
    };
    expect(sample.has_movements_at_adjust).toBe(false);
    expect(sample.shift_status_at_adjust).toBe('open');
  });
});

// ─── 6. No new financial mutation surface (source-grep) ─────────────

describe('Shifts — no financial mutation introduced by this PR', () => {
  // Strip JS comments so the negative-grep doesn't false-positive on
  // prose mentioning the forbidden keywords (this file already has
  // many "NO journal_entries" doc lines).
  const CODE = SHIFTS_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(
    /(^|[^:])\/\/[^\n]*/g,
    '$1',
  );

  function modalBody(): string {
    const idx = CODE.indexOf('function AdjustOpeningBalanceModal');
    expect(idx).toBeGreaterThan(-1);
    // Window large enough to cover the modal + the history component
    // until the next top-level function.
    const tail = CODE.substring(idx);
    const closing = tail.indexOf('\n/* ──');
    return tail.substring(0, closing > 0 ? closing : 8000);
  }

  it('AdjustOpeningBalanceModal body has zero JE / CT / SM / accounting_only strings', () => {
    const body = modalBody();
    expect(body).not.toMatch(/\bjournal_entries\b/);
    expect(body).not.toMatch(/\bcashbox_transactions\b/);
    expect(body).not.toMatch(/\bstock_movements\b/);
    expect(body).not.toMatch(/\baccounting_only\b/);
  });

  it('AdjustOpeningBalanceModal body uses ONLY shiftsApi.adjustOpeningBalance — no approve / reject / apply / refund calls', () => {
    const body = modalBody();
    expect(body).toMatch(/shiftsApi\.adjustOpeningBalance/);
    // No accidental scope creep into other endpoints.
    expect(body).not.toMatch(/approveApproval/);
    expect(body).not.toMatch(/rejectApproval/);
    expect(body).not.toMatch(/shiftsApi\.close\(/);
    expect(body).not.toMatch(/shiftsApi\.adjustCount\(/);
    expect(body).not.toMatch(/shiftsApi\.open\(/);
  });
});
