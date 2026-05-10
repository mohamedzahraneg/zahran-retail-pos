/**
 * Printer profile store — pure localStorage CRUD.
 *
 * Storage keys (versioned so we can migrate cleanly later):
 *   · `zahran.printers.v1`           → Printer[]
 *   · `zahran.printers.defaults.v1`  → DocumentTypeDefaults
 *   · `zahran.bridge.v1`             → BridgeConfig
 *
 * Failure model: every read returns a sane default if localStorage
 * is unavailable, contains corrupt JSON, or contains the wrong
 * shape.  No throw can escape this module — the printer subsystem
 * must NEVER crash the POS UI.  Writes silently no-op when storage
 * is unavailable (e.g. private-mode quotas).
 *
 * No backend calls.  No DB.  No telemetry beyond `console.warn` on
 * corruption — the UI surfaces "no printers configured" instead.
 */

import type {
  BridgeConfig,
  DocumentType,
  DocumentTypeDefaults,
  Printer,
} from './types';

const KEY_PRINTERS = 'zahran.printers.v1';
const KEY_DEFAULTS = 'zahran.printers.defaults.v1';
const KEY_BRIDGE = 'zahran.bridge.v1';

/** Default bridge URL — Phase 2's Android Print Bridge listens here. */
export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8911';

// ─── Internals ────────────────────────────────────────────────────

function safeStorage(): Storage | null {
  // localStorage can be missing (SSR, locked-down browsers) or throw on
  // access (Safari private mode + quota).  Probe defensively.
  try {
    if (typeof window === 'undefined') return null;
    const ls = window.localStorage;
    // Round-trip a tiny test write to confirm we can actually use it.
    const probe = '__zahran_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}

function readJson<T>(key: string, fallback: T, validator: (v: unknown) => v is T): T {
  const ls = safeStorage();
  if (!ls) return fallback;
  let raw: string | null;
  try {
    raw = ls.getItem(key);
  } catch {
    return fallback;
  }
  if (raw == null) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt JSON — log once + return the safe fallback.  We don't
    // wipe the bad value here so a developer can inspect it; on next
    // write we'll overwrite with a healthy shape.
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(`[printers] corrupt JSON in localStorage at ${key}; using default`);
    }
    return fallback;
  }
  if (!validator(parsed)) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(`[printers] unexpected shape at ${key}; using default`);
    }
    return fallback;
  }
  return parsed;
}

function writeJson(key: string, value: unknown): void {
  const ls = safeStorage();
  if (!ls) return;
  try {
    ls.setItem(key, JSON.stringify(value));
  } catch {
    // Quota / availability — silently no-op.  The UI's next read
    // returns whatever was last successfully written.
  }
}

// ─── Validators ───────────────────────────────────────────────────

function isPrinter(v: unknown): v is Printer {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.printer_id === 'string' &&
    typeof p.name === 'string' &&
    typeof p.type === 'string' &&
    typeof p.paper === 'string' &&
    typeof p.connection === 'string' &&
    typeof p.enabled === 'boolean' &&
    typeof p.created_at === 'string'
  );
}

function isPrinterArray(v: unknown): v is Printer[] {
  return Array.isArray(v) && v.every(isPrinter);
}

function isDefaultsMap(v: unknown): v is DocumentTypeDefaults {
  if (!v || typeof v !== 'object') return false;
  for (const val of Object.values(v as Record<string, unknown>)) {
    if (typeof val !== 'string') return false;
  }
  return true;
}

function isBridgeConfig(v: unknown): v is BridgeConfig {
  if (!v || typeof v !== 'object') return false;
  return typeof (v as Record<string, unknown>).base_url === 'string';
}

// ─── Printer CRUD ─────────────────────────────────────────────────

export function listPrinters(): Printer[] {
  return readJson<Printer[]>(KEY_PRINTERS, [], isPrinterArray);
}

export function getPrinter(printerId: string): Printer | undefined {
  return listPrinters().find((p) => p.printer_id === printerId);
}

/**
 * Upserts the printer (matched by `printer_id`).  Returns the saved
 * list for callers that want to refresh local state without re-reading.
 */
export function upsertPrinter(input: Printer): Printer[] {
  const list = listPrinters();
  const idx = list.findIndex((p) => p.printer_id === input.printer_id);
  if (idx === -1) {
    list.push(input);
  } else {
    list[idx] = input;
  }
  writeJson(KEY_PRINTERS, list);
  return list;
}

export function deletePrinter(printerId: string): Printer[] {
  const list = listPrinters().filter((p) => p.printer_id !== printerId);
  writeJson(KEY_PRINTERS, list);
  // Clean up any defaults that pointed at the removed printer.
  const defs = getDefaults();
  let changed = false;
  for (const k of Object.keys(defs) as DocumentType[]) {
    if (defs[k] === printerId) {
      delete defs[k];
      changed = true;
    }
  }
  if (changed) writeJson(KEY_DEFAULTS, defs);
  return list;
}

/**
 * Marks the printer's last-print outcome.  Pure helper used by
 * the router after a routing attempt.  Silently no-ops when the
 * printer is missing (the user could have deleted it mid-flight).
 */
export function markPrintResult(
  printerId: string,
  result: { ok: true; at: string } | { ok: false; error: string },
): void {
  const list = listPrinters();
  const idx = list.findIndex((p) => p.printer_id === printerId);
  if (idx === -1) return;
  if (result.ok) {
    list[idx] = {
      ...list[idx]!,
      last_print_ok_at: result.at,
      last_error: null,
    };
  } else {
    list[idx] = { ...list[idx]!, last_error: result.error };
  }
  writeJson(KEY_PRINTERS, list);
}

// ─── Defaults map ─────────────────────────────────────────────────

export function getDefaults(): DocumentTypeDefaults {
  return readJson<DocumentTypeDefaults>(KEY_DEFAULTS, {}, isDefaultsMap);
}

export function setDefaultPrinter(
  documentType: DocumentType,
  printerId: string | null,
): DocumentTypeDefaults {
  const defs = getDefaults();
  if (printerId == null) {
    delete defs[documentType];
  } else {
    defs[documentType] = printerId;
  }
  writeJson(KEY_DEFAULTS, defs);
  return defs;
}

/**
 * Look up the printer the user has tagged as default for `documentType`.
 * Returns `null` when no default is set OR when the configured default
 * points at a printer that has since been deleted.  Disabled printers
 * are still returned — the router decides whether to fall back, which
 * lets it surface the more specific `printer_disabled` reason instead
 * of the catch-all `no_printer_configured`.
 */
export function resolveDefaultPrinter(
  documentType: DocumentType,
): Printer | null {
  const defs = getDefaults();
  const id = defs[documentType];
  if (!id) return null;
  const p = getPrinter(id);
  if (!p) return null;
  return p;
}

// ─── Bridge config ────────────────────────────────────────────────

export function getBridgeConfig(): BridgeConfig {
  return readJson<BridgeConfig>(
    KEY_BRIDGE,
    { base_url: DEFAULT_BRIDGE_URL },
    isBridgeConfig,
  );
}

export function setBridgeConfig(cfg: BridgeConfig): void {
  writeJson(KEY_BRIDGE, cfg);
}

// ─── Test-only helpers (exported for the spec) ────────────────────

/** Wipe everything — used by tests, never by the UI. */
export function __resetPrinterStore_TEST_ONLY(): void {
  const ls = safeStorage();
  if (!ls) return;
  try {
    ls.removeItem(KEY_PRINTERS);
    ls.removeItem(KEY_DEFAULTS);
    ls.removeItem(KEY_BRIDGE);
  } catch {
    // ignore
  }
}

export const __KEYS_TEST_ONLY = {
  printers: KEY_PRINTERS,
  defaults: KEY_DEFAULTS,
  bridge: KEY_BRIDGE,
};
