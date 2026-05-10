/**
 * Print router — bridge-up vs bridge-down vs no-printer fallback.
 *
 * The router is mocked at the bridge boundary (`probeBridge` +
 * `submitJob`), so these tests run with no network and no DOM.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetPrinterStore_TEST_ONLY,
  setDefaultPrinter,
  upsertPrinter,
} from '../store';
import { routePrintJob } from '../router';
import * as bridgeModule from '../bridge';
import type { Printer, PrintPayload } from '../types';

function thermalPrinter(over: Partial<Printer> = {}): Printer {
  return {
    printer_id: 'p-thermal',
    name: 'كاشير حراري',
    type: 'thermal_escpos',
    paper: '80mm',
    connection: 'bluetooth',
    enabled: true,
    created_at: new Date().toISOString(),
    ...over,
  };
}

function browserPrinter(over: Partial<Printer> = {}): Printer {
  return {
    printer_id: 'p-browser',
    name: 'متصفح',
    type: 'browser',
    paper: '80mm',
    connection: 'browser',
    enabled: true,
    created_at: new Date().toISOString(),
    ...over,
  };
}

const dummyPayload: PrintPayload = {
  kind: 'escpos_html',
  html: '<div>x</div>',
  width_mm: 80,
};

beforeEach(() => {
  __resetPrinterStore_TEST_ONLY();
  vi.restoreAllMocks();
});

afterEach(() => {
  __resetPrinterStore_TEST_ONLY();
  vi.restoreAllMocks();
});

describe('router — no printer configured', () => {
  it('falls back to browser when no default is set for the document type', async () => {
    const fallback = vi.fn();
    const probe = vi.spyOn(bridgeModule, 'probeBridge');
    const submit = vi.spyOn(bridgeModule, 'submitJob');
    const r = await routePrintJob({
      document_type: 'invoice',
      document_id: 'INV-1',
      buildPayload: () => dummyPayload,
      onBrowserFallback: fallback,
    });
    expect(r).toEqual({
      route: 'browser_fallback',
      reason: 'no_printer_configured',
    });
    expect(fallback).toHaveBeenCalledOnce();
    expect(probe).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('falls back to browser when the printer profile is disabled', async () => {
    upsertPrinter(thermalPrinter({ printer_id: 'p1', enabled: false }));
    setDefaultPrinter('invoice', 'p1');
    const fallback = vi.fn();
    vi.spyOn(bridgeModule, 'probeBridge');
    const r = await routePrintJob({
      document_type: 'invoice',
      document_id: 'INV-1',
      buildPayload: () => dummyPayload,
      onBrowserFallback: fallback,
    });
    expect(r).toEqual({
      route: 'browser_fallback',
      reason: 'printer_disabled',
    });
    expect(fallback).toHaveBeenCalledOnce();
  });
});

describe('router — explicit browser printer', () => {
  it('always falls back regardless of bridge availability', async () => {
    upsertPrinter(browserPrinter({ printer_id: 'pb' }));
    setDefaultPrinter('invoice', 'pb');
    const fallback = vi.fn();
    const probe = vi
      .spyOn(bridgeModule, 'probeBridge')
      .mockResolvedValue({ ok: true, data: { ok: true } });
    const submit = vi.spyOn(bridgeModule, 'submitJob');
    const r = await routePrintJob({
      document_type: 'invoice',
      document_id: 'INV-1',
      buildPayload: () => dummyPayload,
      onBrowserFallback: fallback,
    });
    expect(r).toEqual({
      route: 'browser_fallback',
      reason: 'browser_printer_explicit',
    });
    expect(fallback).toHaveBeenCalledOnce();
    expect(probe).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
});

describe('router — bridge healthy + thermal printer', () => {
  it('posts the job to the bridge and returns route="bridge"', async () => {
    upsertPrinter(thermalPrinter({ printer_id: 'pt' }));
    setDefaultPrinter('invoice', 'pt');
    const fallback = vi.fn();
    vi.spyOn(bridgeModule, 'probeBridge').mockResolvedValue({
      ok: true,
      data: { ok: true },
    });
    const submit = vi
      .spyOn(bridgeModule, 'submitJob')
      .mockResolvedValue({ ok: true });
    const r = await routePrintJob({
      document_type: 'invoice',
      document_id: 'INV-1',
      buildPayload: () => dummyPayload,
      onBrowserFallback: fallback,
    });
    expect(r.route).toBe('bridge');
    if (r.route === 'bridge') {
      expect(r.printer_id).toBe('pt');
      expect(r.job_id).toMatch(/[0-9a-f-]{8,}/);
    }
    expect(fallback).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledOnce();
    const job = submit.mock.calls[0]![0];
    expect(job.document_type).toBe('invoice');
    expect(job.document_id).toBe('INV-1');
    expect(job.printer_id).toBe('pt');
    expect(job.copies).toBe(1);
  });

  it('clamps copies to >= 1', async () => {
    upsertPrinter(thermalPrinter({ printer_id: 'pt' }));
    setDefaultPrinter('invoice', 'pt');
    vi.spyOn(bridgeModule, 'probeBridge').mockResolvedValue({
      ok: true,
      data: { ok: true },
    });
    const submit = vi
      .spyOn(bridgeModule, 'submitJob')
      .mockResolvedValue({ ok: true });
    await routePrintJob({
      document_type: 'invoice',
      document_id: 'INV-1',
      copies: 0,
      buildPayload: () => dummyPayload,
      onBrowserFallback: () => {},
    });
    expect(submit.mock.calls[0]![0].copies).toBe(1);
  });
});

describe('router — bridge unreachable / timeout', () => {
  it('falls back when probeBridge reports unreachable', async () => {
    upsertPrinter(thermalPrinter({ printer_id: 'pt' }));
    setDefaultPrinter('invoice', 'pt');
    const fallback = vi.fn();
    vi.spyOn(bridgeModule, 'probeBridge').mockResolvedValue({
      ok: false,
      reason: 'unreachable',
    });
    const submit = vi.spyOn(bridgeModule, 'submitJob');
    const r = await routePrintJob({
      document_type: 'invoice',
      document_id: 'INV-1',
      buildPayload: () => dummyPayload,
      onBrowserFallback: fallback,
    });
    expect(r).toEqual({
      route: 'browser_fallback',
      reason: 'bridge_unreachable',
    });
    expect(fallback).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });

  it('falls back when probeBridge times out', async () => {
    upsertPrinter(thermalPrinter({ printer_id: 'pt' }));
    setDefaultPrinter('invoice', 'pt');
    const fallback = vi.fn();
    vi.spyOn(bridgeModule, 'probeBridge').mockResolvedValue({
      ok: false,
      reason: 'timeout',
    });
    const r = await routePrintJob({
      document_type: 'invoice',
      document_id: 'INV-1',
      buildPayload: () => dummyPayload,
      onBrowserFallback: fallback,
    });
    expect(r.route).toBe('browser_fallback');
    if (r.route === 'browser_fallback') {
      expect(r.reason).toBe('bridge_unreachable');
    }
    expect(fallback).toHaveBeenCalledOnce();
  });
});

describe('router — bridge healthy but submit fails', () => {
  it('falls back AND records the error on the printer profile', async () => {
    upsertPrinter(thermalPrinter({ printer_id: 'pt' }));
    setDefaultPrinter('invoice', 'pt');
    const fallback = vi.fn();
    vi.spyOn(bridgeModule, 'probeBridge').mockResolvedValue({
      ok: true,
      data: { ok: true },
    });
    vi.spyOn(bridgeModule, 'submitJob').mockResolvedValue({
      ok: false,
      reason: 'bad_status',
      status: 500,
      message: 'BT printer offline',
    });
    const r = await routePrintJob({
      document_type: 'invoice',
      document_id: 'INV-1',
      buildPayload: () => dummyPayload,
      onBrowserFallback: fallback,
    });
    expect(r).toEqual({
      route: 'browser_fallback',
      reason: 'bridge_error',
    });
    expect(fallback).toHaveBeenCalledOnce();
    // The error has been recorded on the printer for the UI to display.
    const { listPrinters } = await import('../store');
    const after = listPrinters().find((p) => p.printer_id === 'pt')!;
    expect(after.last_error).toBe('BT printer offline');
  });
});

describe('router — printerOverride', () => {
  it('uses the override printer regardless of defaults map', async () => {
    setDefaultPrinter('invoice', 'p-default');
    const override = thermalPrinter({ printer_id: 'p-override' });
    vi.spyOn(bridgeModule, 'probeBridge').mockResolvedValue({
      ok: true,
      data: { ok: true },
    });
    const submit = vi
      .spyOn(bridgeModule, 'submitJob')
      .mockResolvedValue({ ok: true });
    const r = await routePrintJob({
      document_type: 'invoice',
      document_id: 'INV-1',
      buildPayload: () => dummyPayload,
      onBrowserFallback: () => {},
      printerOverride: override,
    });
    expect(r.route).toBe('bridge');
    expect(submit.mock.calls[0]![0].printer_id).toBe('p-override');
  });

  it('printerOverride=null forces fallback (no_printer_configured)', async () => {
    upsertPrinter(thermalPrinter({ printer_id: 'pt' }));
    setDefaultPrinter('invoice', 'pt');
    const fallback = vi.fn();
    const probe = vi.spyOn(bridgeModule, 'probeBridge');
    const r = await routePrintJob({
      document_type: 'invoice',
      document_id: 'INV-1',
      buildPayload: () => dummyPayload,
      onBrowserFallback: fallback,
      printerOverride: null,
    });
    expect(r).toEqual({
      route: 'browser_fallback',
      reason: 'no_printer_configured',
    });
    expect(fallback).toHaveBeenCalledOnce();
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('router — buildPayload throws', () => {
  it('falls back gracefully when the payload builder throws', async () => {
    upsertPrinter(thermalPrinter({ printer_id: 'pt' }));
    setDefaultPrinter('invoice', 'pt');
    const fallback = vi.fn();
    vi.spyOn(bridgeModule, 'probeBridge').mockResolvedValue({
      ok: true,
      data: { ok: true },
    });
    const r = await routePrintJob({
      document_type: 'invoice',
      document_id: 'INV-1',
      buildPayload: () => {
        throw new Error('payload boom');
      },
      onBrowserFallback: fallback,
    });
    expect(r).toEqual({
      route: 'browser_fallback',
      reason: 'bridge_error',
    });
    expect(fallback).toHaveBeenCalledOnce();
  });
});

describe('router — fallback callback throwing must not crash', () => {
  it('absorbs the error and still resolves', async () => {
    const fallback = vi.fn(() => {
      throw new Error('iframe boom');
    });
    const r = await routePrintJob({
      document_type: 'invoice',
      document_id: 'INV-1',
      buildPayload: () => dummyPayload,
      onBrowserFallback: fallback,
    });
    expect(r.route).toBe('browser_fallback');
    expect(fallback).toHaveBeenCalledOnce();
  });
});
