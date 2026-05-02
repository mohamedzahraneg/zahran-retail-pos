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
