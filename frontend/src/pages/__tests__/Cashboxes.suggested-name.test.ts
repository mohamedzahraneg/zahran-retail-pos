/**
 * Cashboxes.suggested-name.test.ts — PR-FIN-PAYACCT-4D-UX-FIX-4
 *
 * Pins the `suggestedCashboxName(method, kind)` mapping that pre-fills
 * the cashbox name when the operator clicks "إنشاء خزنة مناسبة" from
 * inside the PaymentAccountModal empty-state.
 *
 * The mapping must produce method-specific Arabic names so the
 * operator gets a sensible default and the form's intent is obvious
 * (e.g. opening kind=ewallet from an InstaPay flow shouldn't show a
 * generic "إضافة محفظة إلكترونية" with empty input — it should
 * pre-fill "خزنة InstaPay").
 *
 * Locks the regression: anyone removing or regressing a mapping
 * fails CI.
 */
import { describe, it, expect } from 'vitest';
import { suggestedCashboxName } from '../Cashboxes';

describe('suggestedCashboxName — PR-FIN-PAYACCT-4D-UX-FIX-4', () => {
  it('instapay → kind=ewallet → "خزنة InstaPay"', () => {
    expect(suggestedCashboxName('instapay', 'ewallet')).toBe('خزنة InstaPay');
  });

  it('vodafone_cash → kind=ewallet → "خزنة Vodafone Cash"', () => {
    expect(suggestedCashboxName('vodafone_cash', 'ewallet')).toBe('خزنة Vodafone Cash');
  });

  it('orange_cash → kind=ewallet → "خزنة Orange Cash"', () => {
    expect(suggestedCashboxName('orange_cash', 'ewallet')).toBe('خزنة Orange Cash');
  });

  it('wallet → kind=ewallet → "خزنة محفظة WE Pay"', () => {
    expect(suggestedCashboxName('wallet', 'ewallet')).toBe('خزنة محفظة WE Pay');
  });

  it('card_visa → kind=bank → "حساب POS Visa"', () => {
    expect(suggestedCashboxName('card_visa', 'bank')).toBe('حساب POS Visa');
  });

  it('card_mastercard → kind=bank → "حساب POS Mastercard"', () => {
    expect(suggestedCashboxName('card_mastercard', 'bank')).toBe('حساب POS Mastercard');
  });

  it('card_meeza → kind=bank → "حساب POS Meeza"', () => {
    expect(suggestedCashboxName('card_meeza', 'bank')).toBe('حساب POS Meeza');
  });

  it('bank_transfer → kind=bank → "حساب بنكي"', () => {
    expect(suggestedCashboxName('bank_transfer', 'bank')).toBe('حساب بنكي');
  });

  it('check → kind=check → "حساب شيكات"', () => {
    expect(suggestedCashboxName('check', 'check')).toBe('حساب شيكات');
  });

  it('cash → kind=cash → "خزنة نقدية"', () => {
    expect(suggestedCashboxName('cash', 'cash')).toBe('خزنة نقدية');
  });

  it('null method falls back to the kind label', () => {
    expect(suggestedCashboxName(null, 'bank')).toBe('حساب بنكي');
    expect(suggestedCashboxName(null, 'ewallet')).toBe('خزنة محفظة إلكترونية');
    expect(suggestedCashboxName(null, 'check')).toBe('حساب شيكات');
    expect(suggestedCashboxName(null, 'cash')).toBe('خزنة نقدية');
  });

  it('returns a non-empty string for every supported method', () => {
    const methods = [
      'cash', 'instapay', 'vodafone_cash', 'orange_cash', 'wallet',
      'bank_transfer', 'card_visa', 'card_mastercard', 'card_meeza', 'check',
    ] as const;
    for (const m of methods) {
      const out = suggestedCashboxName(m, 'cash');
      expect(out.length).toBeGreaterThan(0);
    }
  });
});
