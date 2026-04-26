import { describe, it, expect } from 'vitest';
import { visibleMethodsFor } from '../POS';

/**
 * PR-PAY-3 fix — lock the rule that the POS payment grid only ever
 * shows methods the cashier can actually use:
 *   • Cash is always visible.
 *   • Non-cash methods appear only when at least one ACTIVE
 *     payment_account exists for them.
 *   • Inactive accounts never make a method visible.
 *   • Visibility flips with the underlying account list — no rebuild
 *     required.
 *
 * Without this rule the grid used to render "Vodafone Cash" / "Orange
 * Cash" / "Mastercard" / "Meeza" / "Bank Transfer" cards with a "no
 * active account" subtitle, cluttering the cashier UX and inviting
 * the silent-cash fallback bug PR-PAY-1 already removed.
 */

describe('visibleMethodsFor', () => {
  it('shows only cash when no accounts exist', () => {
    expect(visibleMethodsFor([])).toEqual(['cash']);
  });

  it('shows only cash when every account is inactive', () => {
    expect(
      visibleMethodsFor([
        { method: 'instapay', active: false },
        { method: 'card_visa', active: false },
        { method: 'vodafone_cash', active: false },
      ]),
    ).toEqual(['cash']);
  });

  it('shows cash + only the methods with an active account', () => {
    expect(
      visibleMethodsFor([
        { method: 'instapay', active: true },
        { method: 'card_visa', active: true },
        { method: 'vodafone_cash', active: false },
      ]),
    ).toEqual(['cash', 'instapay', 'card_visa']);
  });

  it('preserves POS_METHODS order regardless of account row order', () => {
    expect(
      visibleMethodsFor([
        { method: 'bank_transfer', active: true },
        { method: 'instapay', active: true },
        { method: 'card_meeza', active: true },
      ]),
    ).toEqual(['cash', 'instapay', 'card_meeza', 'bank_transfer']);
  });

  it('treats one active and one inactive on the same method as visible', () => {
    expect(
      visibleMethodsFor([
        { method: 'instapay', active: false },
        { method: 'instapay', active: true },
      ]),
    ).toEqual(['cash', 'instapay']);
  });

  it('does not list duplicates when multiple active accounts share a method', () => {
    expect(
      visibleMethodsFor([
        { method: 'instapay', active: true },
        { method: 'instapay', active: true },
        { method: 'instapay', active: true },
      ]),
    ).toEqual(['cash', 'instapay']);
  });
});
