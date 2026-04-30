/**
 * uuid-or-null.test.ts — PR-FIN-PAYACCT-4D-UX-FIX-6
 *
 * Pins the `uuidOrNull` / `isMissingUuid` contract used by API
 * payload builders to neutralize the three "stringified-empty"
 * footguns that produced
 * `invalid input syntax for type uuid: "undefined"` in production.
 */
import { describe, it, expect } from 'vitest';
import { uuidOrNull, isMissingUuid } from '../uuid-or-null';

const SAMPLE_UUID = '524646d5-7bd6-4d8d-a484-b1f562b039a4';

describe('isMissingUuid — PR-FIN-PAYACCT-4D-UX-FIX-6', () => {
  it('treats undefined and null as missing', () => {
    expect(isMissingUuid(undefined)).toBe(true);
    expect(isMissingUuid(null)).toBe(true);
  });

  it('treats empty + whitespace-only strings as missing', () => {
    expect(isMissingUuid('')).toBe(true);
    expect(isMissingUuid('   ')).toBe(true);
    expect(isMissingUuid('\t\n')).toBe(true);
  });

  it('treats the literal sentinels "undefined" and "null" as missing', () => {
    expect(isMissingUuid('undefined')).toBe(true);
    expect(isMissingUuid('null')).toBe(true);
    expect(isMissingUuid('  undefined  ')).toBe(true);
    expect(isMissingUuid('  null  ')).toBe(true);
  });

  it('does NOT treat valid uuid-like strings as missing', () => {
    expect(isMissingUuid(SAMPLE_UUID)).toBe(false);
    expect(isMissingUuid('any-non-empty-string')).toBe(false);
  });

  it('non-string non-null values are NOT considered missing (caller decides)', () => {
    expect(isMissingUuid(123)).toBe(false);
    expect(isMissingUuid({})).toBe(false);
    expect(isMissingUuid([])).toBe(false);
  });
});

describe('uuidOrNull — PR-FIN-PAYACCT-4D-UX-FIX-6', () => {
  it('returns null for the missing-uuid sentinels', () => {
    expect(uuidOrNull(undefined)).toBeNull();
    expect(uuidOrNull(null)).toBeNull();
    expect(uuidOrNull('')).toBeNull();
    expect(uuidOrNull('   ')).toBeNull();
    expect(uuidOrNull('undefined')).toBeNull();
    expect(uuidOrNull('null')).toBeNull();
    expect(uuidOrNull('  undefined  ')).toBeNull();
    expect(uuidOrNull('  null  ')).toBeNull();
  });

  it('passes valid uuid strings through untouched', () => {
    expect(uuidOrNull(SAMPLE_UUID)).toBe(SAMPLE_UUID);
  });

  it('does NOT format-validate — passes any non-sentinel string through', () => {
    // Format-validation happens server-side via class-validator's
    // `@IsUUID()` — the helper's job is only to neutralize sentinels.
    expect(uuidOrNull('not-a-uuid-but-not-a-sentinel')).toBe(
      'not-a-uuid-but-not-a-sentinel',
    );
  });
});
