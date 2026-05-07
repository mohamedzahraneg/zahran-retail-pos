/**
 * stock-purchases-idempotency.spec.ts — PR-FE-IDEM-STOCK-PURCHASES-OPS
 *   (Sprint 5 / FE-IDEM PR 7C)
 *
 * Pins the FE half of the opt-in idempotency contract for eight
 * stock-transfer + purchase mutation routes already protected
 * backend-side. The helper is method-aware (POST + PATCH) since
 * the BE PurchasesController declares cancel/cancelReturn as PATCH.
 *
 *   · POST  /stock-transfers
 *   · POST  /stock-transfers/:id/ship
 *   · POST  /stock-transfers/:id/receive
 *   · POST  /stock-transfers/:id/cancel
 *   · POST  /purchases/:id/receive
 *   · POST  /purchases/:id/pay
 *   · PATCH /purchases/:id/cancel
 *   · PATCH /purchases/returns/:id/cancel  (no current FE caller)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getOrCreateStockTransferCreateIdempotencyKey,
  resetStockTransferCreateIdempotencyKey,
  _resetStockTransferCreateIdempotencyKeyForTests,
  getOrCreateStockTransferShipIdempotencyKey,
  resetStockTransferShipIdempotencyKey,
  _resetStockTransferShipIdempotencyKeyForTests,
  getOrCreateStockTransferReceiveIdempotencyKey,
  resetStockTransferReceiveIdempotencyKey,
  _resetStockTransferReceiveIdempotencyKeyForTests,
  getOrCreateStockTransferCancelIdempotencyKey,
  resetStockTransferCancelIdempotencyKey,
  _resetStockTransferCancelIdempotencyKeyForTests,
  getOrCreatePurchaseReceiveIdempotencyKey,
  resetPurchaseReceiveIdempotencyKey,
  _resetPurchaseReceiveIdempotencyKeyForTests,
  getOrCreatePurchasePayIdempotencyKey,
  resetPurchasePayIdempotencyKey,
  _resetPurchasePayIdempotencyKeyForTests,
  getOrCreatePurchaseCancelIdempotencyKey,
  resetPurchaseCancelIdempotencyKey,
  _resetPurchaseCancelIdempotencyKeyForTests,
  getOrCreatePurchaseReturnCancelIdempotencyKey,
  resetPurchaseReturnCancelIdempotencyKey,
  _resetPurchaseReturnCancelIdempotencyKeyForTests,
  attachStockPurchasesIdempotencyKeyIfApplicable,
} from './stock-purchases-idempotency';
import {
  attachCheckoutIdempotencyKeyIfApplicable,
  _resetCheckoutIdempotencyKeyForTests,
} from './checkout-idempotency';
import {
  attachShiftsIdempotencyKeyIfApplicable,
  _resetShiftsCloseIdempotencyKeyForTests,
  _resetShiftsApproveCloseIdempotencyKeyForTests,
  _resetShiftsAdjustCountIdempotencyKeyForTests,
} from './shifts-idempotency';

const BE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const TRANSFER_ID = 'aaaa1111-bbbb-2222-cccc-333344445555';
const PURCHASE_ID = 'pppp1111-qqqq-2222-rrrr-333344445555';
const RETURN_ID = 'rrrr1111-ssss-2222-tttt-333344445555';

beforeEach(() => {
  _resetStockTransferCreateIdempotencyKeyForTests();
  _resetStockTransferShipIdempotencyKeyForTests();
  _resetStockTransferReceiveIdempotencyKeyForTests();
  _resetStockTransferCancelIdempotencyKeyForTests();
  _resetPurchaseReceiveIdempotencyKeyForTests();
  _resetPurchasePayIdempotencyKeyForTests();
  _resetPurchaseCancelIdempotencyKeyForTests();
  _resetPurchaseReturnCancelIdempotencyKeyForTests();
  _resetCheckoutIdempotencyKeyForTests();
  _resetShiftsCloseIdempotencyKeyForTests();
  _resetShiftsApproveCloseIdempotencyKeyForTests();
  _resetShiftsAdjustCountIdempotencyKeyForTests();
});

// ── Per-action key lifecycle ─────────────────────────────────────────
describe('stock-purchases idempotency module — key lifecycle', () => {
  const cases: Array<[string, () => string, () => void]> = [
    ['stock-transfer-create',  getOrCreateStockTransferCreateIdempotencyKey,  resetStockTransferCreateIdempotencyKey],
    ['stock-transfer-ship',    getOrCreateStockTransferShipIdempotencyKey,    resetStockTransferShipIdempotencyKey],
    ['stock-transfer-receive', getOrCreateStockTransferReceiveIdempotencyKey, resetStockTransferReceiveIdempotencyKey],
    ['stock-transfer-cancel',  getOrCreateStockTransferCancelIdempotencyKey,  resetStockTransferCancelIdempotencyKey],
    ['purchase-receive',       getOrCreatePurchaseReceiveIdempotencyKey,      resetPurchaseReceiveIdempotencyKey],
    ['purchase-pay',           getOrCreatePurchasePayIdempotencyKey,          resetPurchasePayIdempotencyKey],
    ['purchase-cancel',        getOrCreatePurchaseCancelIdempotencyKey,       resetPurchaseCancelIdempotencyKey],
    ['purchase-return-cancel', getOrCreatePurchaseReturnCancelIdempotencyKey, resetPurchaseReturnCancelIdempotencyKey],
  ];
  it.each(cases)('%s: getOrCreate caches; reset mints fresh; matches BE_PATTERN', (_, get, reset) => {
    const a = get();
    expect(get()).toBe(a);
    expect(a).toMatch(BE_PATTERN);
    reset();
    expect(get()).not.toBe(a);
  });

  it('falls back to a regex-valid key when crypto.randomUUID is unavailable', () => {
    const realCrypto = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, 'crypto', {
        value: { ...realCrypto, randomUUID: undefined },
        configurable: true,
      });
      _resetStockTransferCreateIdempotencyKeyForTests();
      const k = getOrCreateStockTransferCreateIdempotencyKey();
      expect(k).toMatch(BE_PATTERN);
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: realCrypto,
        configurable: true,
      });
    }
  });
});

// ── Inter-action isolation ────────────────────────────────────────────
describe('inter-action isolation — eight keys are independent', () => {
  it('all 8 keys are distinct', () => {
    const keys = [
      getOrCreateStockTransferCreateIdempotencyKey(),
      getOrCreateStockTransferShipIdempotencyKey(),
      getOrCreateStockTransferReceiveIdempotencyKey(),
      getOrCreateStockTransferCancelIdempotencyKey(),
      getOrCreatePurchaseReceiveIdempotencyKey(),
      getOrCreatePurchasePayIdempotencyKey(),
      getOrCreatePurchaseCancelIdempotencyKey(),
      getOrCreatePurchaseReturnCancelIdempotencyKey(),
    ];
    expect(new Set(keys).size).toBe(8);
  });

  it('reset on purchase-pay does NOT affect any of the other 7 keys', () => {
    const c = getOrCreateStockTransferCreateIdempotencyKey();
    const s = getOrCreateStockTransferShipIdempotencyKey();
    const r = getOrCreateStockTransferReceiveIdempotencyKey();
    const cn = getOrCreateStockTransferCancelIdempotencyKey();
    const pr = getOrCreatePurchaseReceiveIdempotencyKey();
    getOrCreatePurchasePayIdempotencyKey();
    const pc = getOrCreatePurchaseCancelIdempotencyKey();
    const pcr = getOrCreatePurchaseReturnCancelIdempotencyKey();
    resetPurchasePayIdempotencyKey();
    expect(getOrCreateStockTransferCreateIdempotencyKey()).toBe(c);
    expect(getOrCreateStockTransferShipIdempotencyKey()).toBe(s);
    expect(getOrCreateStockTransferReceiveIdempotencyKey()).toBe(r);
    expect(getOrCreateStockTransferCancelIdempotencyKey()).toBe(cn);
    expect(getOrCreatePurchaseReceiveIdempotencyKey()).toBe(pr);
    expect(getOrCreatePurchaseCancelIdempotencyKey()).toBe(pc);
    expect(getOrCreatePurchaseReturnCancelIdempotencyKey()).toBe(pcr);
  });
});

// ── URL gate — method-aware (POST vs PATCH) ──────────────────────────
describe('attachStockPurchasesIdempotencyKeyIfApplicable — URL gate', () => {
  // POST routes
  const postCases: Array<[string, string, () => string]> = [
    ['stock-transfer-create',  '/stock-transfers',                          getOrCreateStockTransferCreateIdempotencyKey],
    ['stock-transfer-ship',    `/stock-transfers/${TRANSFER_ID}/ship`,      getOrCreateStockTransferShipIdempotencyKey],
    ['stock-transfer-receive', `/stock-transfers/${TRANSFER_ID}/receive`,   getOrCreateStockTransferReceiveIdempotencyKey],
    ['stock-transfer-cancel',  `/stock-transfers/${TRANSFER_ID}/cancel`,    getOrCreateStockTransferCancelIdempotencyKey],
    ['purchase-receive',       `/purchases/${PURCHASE_ID}/receive`,         getOrCreatePurchaseReceiveIdempotencyKey],
    ['purchase-pay',           `/purchases/${PURCHASE_ID}/pay`,             getOrCreatePurchasePayIdempotencyKey],
  ];
  it.each(postCases)('POST %s attaches the correct key', (_, url, getter) => {
    const cfg: any = { method: 'post', url, headers: {} };
    attachStockPurchasesIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBe(getter());
  });

  // PATCH routes
  const patchCases: Array<[string, string, () => string]> = [
    ['purchase-cancel',        `/purchases/${PURCHASE_ID}/cancel`,           getOrCreatePurchaseCancelIdempotencyKey],
    ['purchase-return-cancel', `/purchases/returns/${RETURN_ID}/cancel`,    getOrCreatePurchaseReturnCancelIdempotencyKey],
  ];
  it.each(patchCases)('PATCH %s attaches the correct key', (_, url, getter) => {
    const cfg: any = { method: 'patch', url, headers: {} };
    attachStockPurchasesIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBe(getter());
  });

  // Method specificity
  it('POST /purchases/:id/cancel does NOT attach (BE expects PATCH)', () => {
    const cfg: any = { method: 'post', url: `/purchases/${PURCHASE_ID}/cancel`, headers: {} };
    attachStockPurchasesIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('PATCH /stock-transfers/:id/ship does NOT attach (BE expects POST)', () => {
    const cfg: any = { method: 'patch', url: `/stock-transfers/${TRANSFER_ID}/ship`, headers: {} };
    attachStockPurchasesIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('PATCH /stock-transfers (would-be create) does NOT attach', () => {
    const cfg: any = { method: 'patch', url: '/stock-transfers', headers: {} };
    attachStockPurchasesIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  // Order-correctness for the two PATCH patterns: returns/:id/cancel
  // must match BEFORE the generic /:id/cancel pattern, otherwise a
  // request to /purchases/returns/:id/cancel would silently use the
  // purchase-cancel key instead of purchase-return-cancel.
  it('PATCH /purchases/returns/:id/cancel uses return-cancel key (NOT generic cancel)', () => {
    const cfg: any = { method: 'patch', url: `/purchases/returns/${RETURN_ID}/cancel`, headers: {} };
    attachStockPurchasesIdempotencyKeyIfApplicable(cfg);
    const k = cfg.headers['Idempotency-Key'];
    expect(k).toBe(getOrCreatePurchaseReturnCancelIdempotencyKey());
    expect(k).not.toBe(getOrCreatePurchaseCancelIdempotencyKey());
  });

  // Same-key + reset semantics
  it('SAME purchase-pay key on second POST for same intent (retry)', () => {
    const cfg1: any = { method: 'post', url: `/purchases/${PURCHASE_ID}/pay`, headers: {} };
    const cfg2: any = { method: 'post', url: `/purchases/${PURCHASE_ID}/pay`, headers: {} };
    attachStockPurchasesIdempotencyKeyIfApplicable(cfg1);
    attachStockPurchasesIdempotencyKeyIfApplicable(cfg2);
    expect(cfg1.headers['Idempotency-Key']).toBe(cfg2.headers['Idempotency-Key']);
  });

  it('after reset, next POST purchase-pay uses NEW key', () => {
    const cfg1: any = { method: 'post', url: `/purchases/${PURCHASE_ID}/pay`, headers: {} };
    attachStockPurchasesIdempotencyKeyIfApplicable(cfg1);
    const k1 = cfg1.headers['Idempotency-Key'];
    resetPurchasePayIdempotencyKey();
    const cfg2: any = { method: 'post', url: `/purchases/${PURCHASE_ID}/pay`, headers: {} };
    attachStockPurchasesIdempotencyKeyIfApplicable(cfg2);
    expect(cfg2.headers['Idempotency-Key']).not.toBe(k1);
  });

  // ── Out-of-scope rejections ──
  it('does NOT attach on POST /purchases (create — state)', () => {
    const cfg: any = { method: 'post', url: '/purchases', headers: {} };
    attachStockPurchasesIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('does NOT attach on POST /purchases/:id/edit (state)', () => {
    const cfg: any = { method: 'post', url: `/purchases/${PURCHASE_ID}/edit`, headers: {} };
    attachStockPurchasesIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('does NOT attach on POST /purchases/returns (createReturn — state)', () => {
    const cfg: any = { method: 'post', url: '/purchases/returns', headers: {} };
    attachStockPurchasesIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('does NOT attach on GETs for any /stock-transfers/* or /purchases/* path', () => {
    for (const url of [
      '/stock-transfers',
      `/stock-transfers/${TRANSFER_ID}`,
      `/stock-transfers/${TRANSFER_ID}/ship`,
      '/purchases',
      `/purchases/${PURCHASE_ID}`,
      `/purchases/${PURCHASE_ID}/receive`,
      `/purchases/${PURCHASE_ID}/pay`,
      '/purchases/returns',
      `/purchases/returns/${RETURN_ID}`,
    ]) {
      const cfg: any = { method: 'get', url, headers: {} };
      attachStockPurchasesIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('does NOT attach on PUT/DELETE on the eight target patterns', () => {
    for (const method of ['put', 'delete']) {
      for (const url of [
        '/stock-transfers',
        `/stock-transfers/${TRANSFER_ID}/ship`,
        `/stock-transfers/${TRANSFER_ID}/receive`,
        `/stock-transfers/${TRANSFER_ID}/cancel`,
        `/purchases/${PURCHASE_ID}/receive`,
        `/purchases/${PURCHASE_ID}/pay`,
        `/purchases/${PURCHASE_ID}/cancel`,
        `/purchases/returns/${RETURN_ID}/cancel`,
      ]) {
        const cfg: any = { method, url, headers: {} };
        attachStockPurchasesIdempotencyKeyIfApplicable(cfg);
        expect(cfg.headers['Idempotency-Key']).toBeUndefined();
      }
    }
  });

  it('does NOT attach on POSTs to look-alike URLs (exact regex anchor)', () => {
    for (const url of [
      // Suffix attacks
      `/stock-transfers/${TRANSFER_ID}/ship/anything-else`,
      `/purchases/${PURCHASE_ID}/pay/abc`,
      // Wrong action segment
      `/stock-transfers/${TRANSFER_ID}/finalize-shortage`, // doesn't exist in BE
      `/stock-transfers/${TRANSFER_ID}/approve`,
      `/purchases/${PURCHASE_ID}/void`,
      // Plural/singular trap
      `/stock-transfer/${TRANSFER_ID}/ship`,
      `/purchase/${PURCHASE_ID}/pay`,
      // Cross-controller siblings
      '/pos/invoices',
      '/cash-desk/transfer',
      '/accounts/journal',
      // Offline sync
      '/sync/push',
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachStockPurchasesIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('preserves a caller-provided Idempotency-Key in 3 casing variants', () => {
    const cfg1: any = {
      method: 'post', url: '/stock-transfers',
      headers: { 'Idempotency-Key': 'caller-supplied-create-1234' },
    };
    attachStockPurchasesIdempotencyKeyIfApplicable(cfg1);
    expect(cfg1.headers['Idempotency-Key']).toBe('caller-supplied-create-1234');

    const cfg2: any = {
      method: 'post', url: `/purchases/${PURCHASE_ID}/pay`,
      headers: { 'idempotency-key': 'caller-supplied-pay-1234' },
    };
    attachStockPurchasesIdempotencyKeyIfApplicable(cfg2);
    expect(cfg2.headers['idempotency-key']).toBe('caller-supplied-pay-1234');
    expect(cfg2.headers['Idempotency-Key']).toBeUndefined();

    const cfg3: any = {
      method: 'patch', url: `/purchases/${PURCHASE_ID}/cancel`,
      headers: { 'IDEMPOTENCY-KEY': 'caller-supplied-cancel-1234' },
    };
    attachStockPurchasesIdempotencyKeyIfApplicable(cfg3);
    expect(cfg3.headers['IDEMPOTENCY-KEY']).toBe('caller-supplied-cancel-1234');
    expect(cfg3.headers['Idempotency-Key']).toBeUndefined();
  });

  it('matches case-insensitively on the HTTP method', () => {
    const cfg1: any = { method: 'POST', url: '/stock-transfers', headers: {} };
    attachStockPurchasesIdempotencyKeyIfApplicable(cfg1);
    expect(cfg1.headers['Idempotency-Key']).toMatch(BE_PATTERN);
    const cfg2: any = { method: 'PATCH', url: `/purchases/${PURCHASE_ID}/cancel`, headers: {} };
    attachStockPurchasesIdempotencyKeyIfApplicable(cfg2);
    expect(cfg2.headers['Idempotency-Key']).toMatch(BE_PATTERN);
  });

  it('different transfer_ids on /ship SHARE the ship key (intent boundary is the click)', () => {
    const cfgA: any = { method: 'post', url: '/stock-transfers/aaaa-1111/ship', headers: {} };
    const cfgB: any = { method: 'post', url: '/stock-transfers/bbbb-2222/ship', headers: {} };
    attachStockPurchasesIdempotencyKeyIfApplicable(cfgA);
    attachStockPurchasesIdempotencyKeyIfApplicable(cfgB);
    expect(cfgA.headers['Idempotency-Key']).toBe(cfgB.headers['Idempotency-Key']);
  });
});

// ── Cross-route isolation against unrelated sibling helpers ──────────
describe('cross-route isolation — stock-purchases helper vs unrelated siblings', () => {
  it('stock-purchases helper does NOT attach to other controllers', () => {
    for (const url of [
      '/pos/invoices',
      '/cash-desk/transfer',
      '/cash-desk/deposit',
      `/reservations/${TRANSFER_ID}/cancel`,
      `/returns/${TRANSFER_ID}/refund`,
      '/exchanges',
      '/accounting/expenses',
      `/employees/${TRANSFER_ID}/bonuses`,
      `/shifts/${TRANSFER_ID}/close`,
      '/accounts/journal',
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachStockPurchasesIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('the checkout/shifts helpers do NOT attach to any of the 8 stock-purchases routes', () => {
    const fns = [attachCheckoutIdempotencyKeyIfApplicable, attachShiftsIdempotencyKeyIfApplicable];
    const targets: Array<[string, string]> = [
      ['post', '/stock-transfers'],
      ['post', `/stock-transfers/${TRANSFER_ID}/ship`],
      ['post', `/stock-transfers/${TRANSFER_ID}/receive`],
      ['post', `/stock-transfers/${TRANSFER_ID}/cancel`],
      ['post', `/purchases/${PURCHASE_ID}/receive`],
      ['post', `/purchases/${PURCHASE_ID}/pay`],
      ['patch', `/purchases/${PURCHASE_ID}/cancel`],
      ['patch', `/purchases/returns/${RETURN_ID}/cancel`],
    ];
    for (const [method, url] of targets) {
      for (const fn of fns) {
        const cfg: any = { method, url, headers: {} };
        fn(cfg);
        expect(cfg.headers['Idempotency-Key']).toBeUndefined();
      }
    }
  });
});
