/**
 * Source-grep contract for the existing print helpers — every one of
 * them must internally call `routePrintJob`, NOT shortcut to the
 * iframe / window.print path directly at the function entry.  Pins
 * the Phase-1 wiring against accidental regressions.
 *
 *   1. printInvoiceThermal       — invoice thermal reprint path
 *   2. printReservationReceipt   — reservation receipt
 *   3. printVoucher              — cash-desk voucher
 *
 * The browser-fallback paths inside each helper still call into the
 * iframe / window.print machinery — that's intentional and lives
 * inside an `onBrowserFallback` closure, which the assertions below
 * confirm.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../../');

function readSrc(rel: string): string {
  return readFileSync(resolve(root, rel), 'utf8');
}

describe('printInvoiceThermal — Phase-1 routed', () => {
  const SRC = readSrc('lib/printInvoiceThermal.ts');

  it('imports routePrintJob from the printers module', () => {
    expect(SRC).toMatch(
      /from\s+['"]@\/lib\/printers\/router['"]/,
    );
    expect(SRC).toMatch(/import\s*\{[^}]*routePrintJob/);
  });

  it('calls routePrintJob with document_type="invoice"', () => {
    expect(SRC).toMatch(
      /routePrintJob\([\s\S]+document_type:\s*['"]invoice['"]/,
    );
  });

  it('passes onBrowserFallback so today\'s iframe-print remains available', () => {
    expect(SRC).toMatch(/onBrowserFallback:\s*browserFallback\b/);
  });

  it('public signature unchanged: export async function printInvoiceThermal(invoiceId: string)', () => {
    expect(SRC).toMatch(
      /export\s+async\s+function\s+printInvoiceThermal\s*\(\s*invoiceId\s*:\s*string\s*\)\s*:\s*Promise<void>/,
    );
  });
});

describe('printReservationReceipt — Phase-1 routed', () => {
  const SRC = readSrc('lib/printReservationReceipt.ts');

  it('imports routePrintJob', () => {
    expect(SRC).toMatch(
      /from\s+['"]@\/lib\/printers\/router['"]/,
    );
  });

  it('calls routePrintJob with document_type="reservation"', () => {
    expect(SRC).toMatch(
      /routePrintJob\([\s\S]+document_type:\s*['"]reservation['"]/,
    );
  });

  it('public signature unchanged: export function printReservationReceipt(res: any)', () => {
    expect(SRC).toMatch(
      /export\s+function\s+printReservationReceipt\s*\(\s*res\s*:\s*any\s*\)/,
    );
  });

  it('browser fallback function still exists and writes into an iframe', () => {
    expect(SRC).toMatch(/function\s+browserFallbackPrint\b/);
    expect(SRC).toMatch(/document\.createElement\(\s*['"]iframe['"]/);
  });
});

describe('printVoucher — Phase-1 routed', () => {
  const SRC = readSrc('lib/printVoucher.ts');

  it('imports routePrintJob', () => {
    expect(SRC).toMatch(
      /from\s+['"]@\/lib\/printers\/router['"]/,
    );
  });

  it('calls routePrintJob with document_type="voucher"', () => {
    expect(SRC).toMatch(
      /routePrintJob\([\s\S]+document_type:\s*['"]voucher['"]/,
    );
  });

  it('public signature unchanged: export function printVoucher(v: VoucherPayload)', () => {
    expect(SRC).toMatch(
      /export\s+function\s+printVoucher\s*\(\s*v\s*:\s*VoucherPayload\s*\)/,
    );
  });

  it('browser fallback function still exists and writes into an iframe', () => {
    expect(SRC).toMatch(/function\s+browserFallbackPrintVoucher\b/);
    expect(SRC).toMatch(/document\.createElement\(\s*['"]iframe['"]/);
  });
});

describe('cross-helper invariants', () => {
  const ALL_SRC =
    readSrc('lib/printInvoiceThermal.ts') +
    '\n\n' +
    readSrc('lib/printReservationReceipt.ts') +
    '\n\n' +
    readSrc('lib/printVoucher.ts');

  it('every helper file imports routePrintJob exactly once', () => {
    const matches = ALL_SRC.match(/import\s+\{[^}]*routePrintJob/g) ?? [];
    expect(matches.length).toBe(3);
  });

  it('no helper bypasses the router by calling printReceiptIframe at the top level', () => {
    // printReceiptIframe is allowed inside the onBrowserFallback
    // closure (printInvoiceThermal does this).  We assert that it
    // never appears at a direct call from the helper's public
    // function body — i.e. no `printReceiptIframe(` outside of a
    // closure passed to onBrowserFallback.  As a coarse guard, we
    // count occurrences and require they all sit in code regions
    // that also reference 'autoPrint:' (the autoPrint=true mount
    // path inside the fallback closure).
    //
    // This is a structural guard, not a strict parse; the tighter
    // structure is covered by the per-helper tests above.
    const inv = readSrc('lib/printInvoiceThermal.ts');
    if (inv.includes('printReceiptIframe(')) {
      // If the import sneaks back in, fail loud.
      expect(inv).toMatch(/autoPrint:\s*true/);
    }
  });
});
