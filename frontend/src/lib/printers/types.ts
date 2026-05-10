/**
 * Printer profiles + print-job types — Phase 1 of the direct-print
 * system (browser fallback only; the Android Print Bridge ships in
 * Phase 2 and consumes the same types over a local HTTP boundary).
 *
 * Storage policy: profiles live in `localStorage` per device.  No
 * backend tables, no migrations, no DB writes for Phase 1.  The
 * existing receipt-template look (paper width, fonts, colours …) is
 * unchanged and continues to live in the `settings` table under
 * `shop.receipt_templates`.
 *
 * Stability guarantee: every consumer of `printInvoiceThermal()` /
 * `printReservationReceipt()` / `printVoucher()` keeps its existing
 * signature.  When no printer profile is configured AND the bridge
 * is unreachable, the router falls back to today's iframe-print
 * behaviour bit-for-bit.
 */

/**
 * Document categories we route by.  These are the buckets the admin
 * picks "default printer for …" against.
 */
export type DocumentType =
  | 'invoice'
  | 'return'
  | 'exchange'
  | 'expense'
  | 'shift_close'
  | 'general_report'
  | 'voucher'
  | 'reservation'
  | 'barcode_label';

/**
 * Where the bytes ultimately go.
 *
 *   · `thermal_escpos` — ESC/POS receipt printer (80mm or 58mm).
 *                        Phase 2 bridge speaks RFCOMM Bluetooth
 *                        Classic to these, or TCP :9100 for
 *                        network ESC/POS.
 *   · `android_system` — Android `PrintManager` for A4/A5 over
 *                        Mopria / vendor plugins (Phase 3).
 *   · `network_ip`     — TCP socket directly to a fixed-IP printer
 *                        (Phase 4 — placeholder type for now).
 *   · `browser`        — explicit "use the browser print dialog
 *                        even if a bridge is available".  Always
 *                        skips the bridge.  This is the safety-net
 *                        type for users who want to keep today's
 *                        behaviour for a specific document type.
 */
export type PrinterType =
  | 'thermal_escpos'
  | 'android_system'
  | 'network_ip'
  | 'browser';

/**
 * Physical paper.  `80mm` / `58mm` map to thermal widths (raster
 * width = 576 / 384 dots at 203 dpi).  `A4` / `A5` go through the
 * Android system print path or the browser fallback.
 */
export type PaperSize = '80mm' | '58mm' | 'A4' | 'A5';

/**
 * Transport layer.  This is what the bridge dispatches on; for
 * `browser` printers we never reach the bridge at all.
 */
export type ConnectionKind = 'bluetooth' | 'network' | 'system' | 'browser';

/**
 * One printer profile, persisted in localStorage.  All fields except
 * `printer_id` / `name` / `type` / `paper` / `connection` /
 * `enabled` / `created_at` are optional so adding a profile is a
 * forgiving operation.
 */
export interface Printer {
  /** UUID v4 generated client-side. */
  printer_id: string;
  /** Human-readable label, e.g. "كاشير 1 — حراري". */
  name: string;
  type: PrinterType;
  paper: PaperSize;
  connection: ConnectionKind;
  /** Display-only; the bridge resolves to MAC for the actual write. */
  bluetooth_name?: string;
  bluetooth_mac?: string;
  ip_host?: string;
  /** Default 9100 if `connection==='network'`. */
  ip_port?: number;
  enabled: boolean;
  /** ISO-8601 timestamp. */
  created_at: string;
  /** ISO-8601 of the last successful print routed via this printer. */
  last_print_ok_at?: string;
  /** Last error string surfaced from a print attempt; cleared on next success. */
  last_error?: string | null;
}

/**
 * The defaults map: which printer to use for which document type.
 * Stored separately from the printer list itself so admins can swap
 * a printer without rewriting every default.
 *
 * Missing keys mean "no preference" → the router falls back to the
 * browser print path for that document type.
 */
export type DocumentTypeDefaults = Partial<Record<DocumentType, string>>;

/**
 * The bridge config: where the FE looks for the local Android bridge.
 *
 *   default = `http://127.0.0.1:8911`
 *
 * Stored separately so a user with multiple bridges (rare) can
 * override.  Also lets us flip the protocol to `https://` later if
 * we add a TLS fronting on the bridge.
 */
export interface BridgeConfig {
  base_url: string;
}

/**
 * The single payload the FE sends to the bridge — or, in the
 * browser-fallback path, hands to the existing iframe-print helper.
 *
 * Phase 1 only emits `kind: 'escpos_html'` (HTML the bridge will
 * convert to ESC/POS) and `kind: 'html'` (HTML the bridge will
 * render via WebView → PDF → PrintManager).  `escpos_raw` and `pdf`
 * are reserved for power-user paths in later phases.
 */
export type PrintPayload =
  | {
      kind: 'escpos_html';
      html: string;
      width_mm: 80 | 58;
    }
  | {
      kind: 'escpos_raw';
      bytes_base64: string;
    }
  | {
      kind: 'pdf';
      pdf_base64: string;
      paper: 'A4' | 'A5';
    }
  | {
      kind: 'html';
      html: string;
      paper: 'A4' | 'A5';
    };

/**
 * The print job sent to the bridge.  `job_id` is a UUID so the
 * bridge can be idempotent on retry.
 */
export interface PrintJob {
  job_id: string;
  document_type: DocumentType;
  document_id: string;
  /** Receipt-template id from `shop.receipt_templates`.  Optional in Phase 1. */
  template_id?: string;
  /** Resolved at routing time.  May be omitted on the browser-fallback branch. */
  printer_id?: string;
  copies: number;
  payload: PrintPayload;
  emitted_at: string;
}

/**
 * Bridge health response.  The FE only relies on `ok`; the rest is
 * purely informational for the PrintersTab status indicator.
 */
export interface BridgeHealth {
  ok: true;
  version?: string;
  /** Paired BT printers the bridge can see right now. */
  printers?: Array<{
    name: string;
    paper?: PaperSize;
    connection: ConnectionKind;
    bonded?: boolean;
  }>;
}

/**
 * Routing decision returned by `routePrintJob()`.  Useful for tests
 * + telemetry — the call sites (existing print helpers) don't need
 * to inspect it; `route: 'browser_fallback'` already covers the
 * unhappy path.
 */
export type RouteOutcome =
  | { route: 'bridge'; printer_id: string; job_id: string }
  | { route: 'browser_fallback'; reason: BrowserFallbackReason }
  | { route: 'failed'; reason: string };

export type BrowserFallbackReason =
  | 'no_printer_configured'
  | 'printer_disabled'
  | 'browser_printer_explicit'
  | 'bridge_unreachable'
  | 'bridge_error';
