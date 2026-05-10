/**
 * Print router — the single entry point every print helper now goes
 * through.  Its job is to decide between two outcomes for a given
 * print intent:
 *
 *   1. **Bridge route** — a printer profile is configured for this
 *      document type, the bridge is reachable, the printer's
 *      `connection !== 'browser'`.  We POST the print job; on success
 *      the caller is done.  On failure we fall through to (2).
 *
 *   2. **Browser fallback** — call the supplied `onBrowserFallback`
 *      callback, which the existing `printInvoiceThermal()` /
 *      `printReservationReceipt()` / `printVoucher()` helpers already
 *      know how to do (mount the receipt, call `printReceiptIframe`).
 *
 * The contract: the router NEVER throws.  Anything that goes wrong
 * with the bridge ends up in the fallback path with a structured
 * `RouteOutcome` so call-sites + tests + future telemetry can see
 * what happened.
 *
 * Phase 1 scope: every existing call site keeps working bit-for-bit
 * when no printer is configured (no DB writes, no DOM changes).
 */

import type {
  DocumentType,
  PrintJob,
  PrintPayload,
  Printer,
  RouteOutcome,
} from './types';
import { probeBridge, submitJob } from './bridge';
import { markPrintResult, resolveDefaultPrinter } from './store';

export interface PrintRouteRequest {
  document_type: DocumentType;
  document_id: string;
  /** Receipt-template id from `shop.receipt_templates`. Optional. */
  template_id?: string;
  copies?: number;
  /**
   * Builds the bridge payload only when the bridge route is taken.
   * Lazy because most call sites already render an iframe for the
   * fallback path; we only pay the HTML serialization cost when we
   * actually need to ship bytes to the bridge.
   */
  buildPayload: () => PrintPayload | Promise<PrintPayload>;
  /**
   * Existing browser-print path.  Must be supplied by the caller —
   * the router never invents a render path of its own.
   * Allowed to be async (mount-then-print is async on most browsers).
   */
  onBrowserFallback: () => void | Promise<void>;
  /**
   * Override for tests.  When set, bypasses the default-resolution
   * step and uses this printer directly (still respects
   * `printer.connection === 'browser'` → fallback).
   */
  printerOverride?: Printer | null;
}

/** Tiny UUID v4 — no dependency on `crypto.randomUUID` (older mobile browsers). */
function uuidv4(): string {
  // RFC 4122 v4 with `Math.random` fallback.  Sufficient for job_id —
  // collision-resistant in single-device usage, which is all we need.
  if (
    typeof crypto !== 'undefined' &&
    typeof (crypto as any).randomUUID === 'function'
  ) {
    return (crypto as any).randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Route a print request.  Always resolves; never throws.  Returns a
 * `RouteOutcome` describing the route taken — useful for tests and
 * future telemetry, but the public call-sites don't need to read it.
 */
export async function routePrintJob(
  req: PrintRouteRequest,
): Promise<RouteOutcome> {
  const printer =
    req.printerOverride === undefined
      ? resolveDefaultPrinter(req.document_type)
      : req.printerOverride;

  // 1. No printer configured — fallback immediately.
  if (!printer) {
    await safeFallback(req.onBrowserFallback);
    return { route: 'browser_fallback', reason: 'no_printer_configured' };
  }

  if (!printer.enabled) {
    await safeFallback(req.onBrowserFallback);
    return { route: 'browser_fallback', reason: 'printer_disabled' };
  }

  // 2. The user explicitly chose the browser-print path for this
  //    document type — never reach the bridge.
  if (printer.connection === 'browser') {
    await safeFallback(req.onBrowserFallback);
    return { route: 'browser_fallback', reason: 'browser_printer_explicit' };
  }

  // 3. Probe the bridge.  Short timeout — must not stall the print
  //    button.  Any failure → fallback.
  const probe = await probeBridge();
  if (!probe.ok) {
    await safeFallback(req.onBrowserFallback);
    return { route: 'browser_fallback', reason: 'bridge_unreachable' };
  }

  // 4. Build the payload + submit the job.
  let payload: PrintPayload;
  try {
    payload = await req.buildPayload();
  } catch {
    await safeFallback(req.onBrowserFallback);
    return { route: 'browser_fallback', reason: 'bridge_error' };
  }
  const job: PrintJob = {
    job_id: uuidv4(),
    document_type: req.document_type,
    document_id: req.document_id,
    template_id: req.template_id,
    printer_id: printer.printer_id,
    copies: Math.max(1, Math.floor(req.copies ?? 1)),
    payload,
    emitted_at: new Date().toISOString(),
  };
  const submit = await submitJob(job);
  if (submit.ok) {
    markPrintResult(printer.printer_id, {
      ok: true,
      at: new Date().toISOString(),
    });
    return { route: 'bridge', printer_id: printer.printer_id, job_id: job.job_id };
  }

  // 5. Bridge accepted the job but failed to print — fallback so the
  //    user still gets something on paper.  Record the error on the
  //    printer profile so the PrintersTab can surface it.
  markPrintResult(printer.printer_id, {
    ok: false,
    error: submit.message || submit.reason,
  });
  await safeFallback(req.onBrowserFallback);
  return { route: 'browser_fallback', reason: 'bridge_error' };
}

/**
 * Wraps `onBrowserFallback` so an error inside it (e.g. the iframe
 * helper throws on a malformed template) doesn't bubble up to the
 * print-button click handler.  Print failures must never crash the
 * surrounding page.
 */
async function safeFallback(cb: () => void | Promise<void>): Promise<void> {
  try {
    await cb();
  } catch (err) {
    if (typeof console !== 'undefined' && console.error) {
      console.error('[printers] browser fallback failed', err);
    }
  }
}
