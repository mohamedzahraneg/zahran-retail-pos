/**
 * Print Bridge client — Phase 1 talks to a future Android Print
 * Bridge over `http://127.0.0.1:8911` (or whatever the user configured
 * via `setBridgeConfig`).  No Android app exists yet; every method
 * here returns a structured-error result, never throws, so the FE
 * can fall back gracefully when the bridge is missing.
 *
 * Two endpoints:
 *
 *   GET  /health            → { ok, version?, printers? }
 *   POST /print/jobs        ← PrintJob                   → { ok, error? }
 *
 * Timeouts:
 *   · health probe     → 250 ms   (must not block the print button)
 *   · job submission   → 8000 ms  (BT printers can take a few seconds
 *                                  to wake up; longer than that, we
 *                                  surface an error to the caller and
 *                                  the router falls back)
 */

import { getBridgeConfig } from './store';
import type { BridgeHealth, PrintJob } from './types';

export type ProbeResult =
  | { ok: true; data: BridgeHealth }
  | { ok: false; reason: 'timeout' | 'unreachable' | 'bad_status' | 'parse'; status?: number };

export type SubmitResult =
  | { ok: true }
  | { ok: false; reason: 'timeout' | 'unreachable' | 'bad_status' | 'parse'; status?: number; message?: string };

const HEALTH_TIMEOUT_MS = 250;
const SUBMIT_TIMEOUT_MS = 8000;

function joinUrl(base: string, path: string): string {
  if (!base.endsWith('/')) base = base + '/';
  if (path.startsWith('/')) path = path.slice(1);
  return base + path;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Probe the bridge.  Returns within `HEALTH_TIMEOUT_MS` even when the
 * bridge is missing (the abort fires first).  Never throws.
 *
 * The router calls this before every job; the PrintersTab status
 * indicator polls it every few seconds.
 */
export async function probeBridge(): Promise<ProbeResult> {
  const url = joinUrl(getBridgeConfig().base_url, '/health');
  let res: Response;
  try {
    res = await fetchWithTimeout(url, { method: 'GET' }, HEALTH_TIMEOUT_MS);
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      return { ok: false, reason: 'timeout' };
    }
    return { ok: false, reason: 'unreachable' };
  }
  if (!res.ok) {
    return { ok: false, reason: 'bad_status', status: res.status };
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { ok: false, reason: 'parse' };
  }
  if (
    !data ||
    typeof data !== 'object' ||
    (data as Record<string, unknown>).ok !== true
  ) {
    return { ok: false, reason: 'parse' };
  }
  return { ok: true, data: data as BridgeHealth };
}

/**
 * POST a print job to the bridge.  Bridge is expected to respond
 * 200 with `{ ok: true }` on success, or 4xx/5xx + `{ ok: false,
 * error: '…' }` on failure.  Timeouts and network errors map to
 * structured failure reasons so the caller can decide whether to
 * fall back or surface to the user.
 */
export async function submitJob(job: PrintJob): Promise<SubmitResult> {
  const url = joinUrl(getBridgeConfig().base_url, '/print/jobs');
  let res: Response;
  try {
    res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(job),
      },
      SUBMIT_TIMEOUT_MS,
    );
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      return { ok: false, reason: 'timeout' };
    }
    return { ok: false, reason: 'unreachable' };
  }
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    if (!res.ok) {
      return { ok: false, reason: 'bad_status', status: res.status };
    }
    return { ok: false, reason: 'parse' };
  }
  if (!res.ok) {
    return {
      ok: false,
      reason: 'bad_status',
      status: res.status,
      message: typeof body?.error === 'string' ? body.error : undefined,
    };
  }
  if (body?.ok === true) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: 'bad_status',
    status: res.status,
    message: typeof body?.error === 'string' ? body.error : undefined,
  };
}

// ─── Test-only helpers ────────────────────────────────────────────

export const __TIMEOUTS_TEST_ONLY = {
  health: HEALTH_TIMEOUT_MS,
  submit: SUBMIT_TIMEOUT_MS,
};
