import {
  METHOD_DEFAULT_GL_CODE,
  PAYMENT_PROVIDERS,
  isCashMethod,
  PaymentMethodCode,
} from './providers.catalog';

/**
 * PR-PAY-1 — Lock the GL routing contract.
 *
 * postInvoice's silent-fallback bug (`|| '1114'`) was only possible
 * because the method-default map and the DB enum drifted. These tests
 * fail loudly the moment someone:
 *   • adds a new enum value without mapping it (or explicitly opting
 *     into "throw on unknown" via `other`),
 *   • points a default at a wrong account family (cash-leaning method
 *     pointing at 1114, etc.),
 *   • marks something other than `cash` as a cash method.
 */

describe('PR-PAY-1 payment method routing contract', () => {
  // The full enum lives in the DB. We mirror it here as the
  // canonical list the backend code must exhaustively handle.
  const ENUM_VALUES: PaymentMethodCode[] = [
    'cash',
    'card_visa',
    'card_mastercard',
    'card_meeza',
    'instapay',
    'vodafone_cash',
    'orange_cash',
    'bank_transfer',
    'credit',
    'other',
  ];

  it('METHOD_DEFAULT_GL_CODE covers every enum value except `other`', () => {
    for (const v of ENUM_VALUES) {
      if (v === 'other') {
        // `other` is intentionally absent — posting must throw rather
        // than fall through to a default. PR-PAY-1 removed the silent
        // `|| '1114'` fallback exactly to make this explicit.
        expect((METHOD_DEFAULT_GL_CODE as any)[v]).toBeUndefined();
      } else {
        expect(METHOD_DEFAULT_GL_CODE[v]).toBeDefined();
      }
    }
  });

  it('routes cash → 1111', () => {
    expect(METHOD_DEFAULT_GL_CODE.cash).toBe('1111');
  });

  it('routes every card_* and bank_transfer → 1113', () => {
    expect(METHOD_DEFAULT_GL_CODE.card_visa).toBe('1113');
    expect(METHOD_DEFAULT_GL_CODE.card_mastercard).toBe('1113');
    expect(METHOD_DEFAULT_GL_CODE.card_meeza).toBe('1113');
    expect(METHOD_DEFAULT_GL_CODE.bank_transfer).toBe('1113');
  });

  it('routes instapay/vodafone_cash/orange_cash → 1114 (e-wallets)', () => {
    expect(METHOD_DEFAULT_GL_CODE.instapay).toBe('1114');
    expect(METHOD_DEFAULT_GL_CODE.vodafone_cash).toBe('1114');
    expect(METHOD_DEFAULT_GL_CODE.orange_cash).toBe('1114');
  });

  it('routes credit → 1121 receivables (matches existing unpaid-portion logic)', () => {
    expect(METHOD_DEFAULT_GL_CODE.credit).toBe('1121');
  });

  it('isCashMethod identifies only cash as a cash method', () => {
    expect(isCashMethod('cash')).toBe(true);
    for (const v of ENUM_VALUES) {
      if (v === 'cash') continue;
      expect(isCashMethod(v)).toBe(false);
    }
  });

  it('every provider points at an account in the allowed set', () => {
    const allowed = new Set(['1111', '1113', '1114', '1115', '1121']);
    for (const p of PAYMENT_PROVIDERS) {
      expect(allowed.has(p.default_gl_account_code)).toBe(true);
    }
  });

  it('every provider.method is a valid enum value', () => {
    for (const p of PAYMENT_PROVIDERS) {
      expect(ENUM_VALUES).toContain(p.method);
    }
  });

  it('every wallet/bank/card provider requires a reference; cash does not', () => {
    for (const p of PAYMENT_PROVIDERS) {
      if (p.group === 'cash') {
        expect(p.requires_reference).toBe(false);
      } else {
        expect(p.requires_reference).toBe(true);
      }
    }
  });
});
