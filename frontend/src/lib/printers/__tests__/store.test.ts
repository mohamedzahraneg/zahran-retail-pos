/**
 * Printer store — localStorage CRUD + defaults map + corrupt-safe.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __KEYS_TEST_ONLY,
  __resetPrinterStore_TEST_ONLY,
  DEFAULT_BRIDGE_URL,
  deletePrinter,
  getBridgeConfig,
  getDefaults,
  getPrinter,
  listPrinters,
  markPrintResult,
  resolveDefaultPrinter,
  setBridgeConfig,
  setDefaultPrinter,
  upsertPrinter,
} from '../store';
import type { Printer } from '../types';

function newPrinter(over: Partial<Printer> = {}): Printer {
  return {
    printer_id: 'p-' + Math.random().toString(16).slice(2, 8),
    name: 'كاشير 1',
    type: 'thermal_escpos',
    paper: '80mm',
    connection: 'bluetooth',
    enabled: true,
    created_at: new Date().toISOString(),
    bluetooth_name: '3dea',
    ...over,
  };
}

beforeEach(() => {
  __resetPrinterStore_TEST_ONLY();
});

afterEach(() => {
  __resetPrinterStore_TEST_ONLY();
});

describe('store — printers CRUD', () => {
  it('listPrinters returns [] on a fresh store', () => {
    expect(listPrinters()).toEqual([]);
  });

  it('upsertPrinter inserts then updates by printer_id', () => {
    const p = newPrinter({ printer_id: 'p1', name: 'A' });
    const after1 = upsertPrinter(p);
    expect(after1).toHaveLength(1);
    expect(after1[0]!.name).toBe('A');

    const after2 = upsertPrinter({ ...p, name: 'A2' });
    expect(after2).toHaveLength(1);
    expect(after2[0]!.name).toBe('A2');
  });

  it('deletePrinter removes the row + clears any defaults pointing at it', () => {
    const p = newPrinter({ printer_id: 'p1' });
    upsertPrinter(p);
    setDefaultPrinter('invoice', 'p1');
    setDefaultPrinter('return', 'p1');
    expect(getDefaults()).toEqual({ invoice: 'p1', return: 'p1' });

    deletePrinter('p1');
    expect(listPrinters()).toEqual([]);
    expect(getDefaults()).toEqual({});
  });

  it('getPrinter returns undefined for missing id', () => {
    expect(getPrinter('nope')).toBeUndefined();
  });
});

describe('store — defaults round-trip', () => {
  it('setDefaultPrinter + getDefaults round-trips', () => {
    upsertPrinter(newPrinter({ printer_id: 'p1' }));
    setDefaultPrinter('invoice', 'p1');
    setDefaultPrinter('shift_close', 'p1');
    expect(getDefaults()).toEqual({ invoice: 'p1', shift_close: 'p1' });
  });

  it('setDefaultPrinter(null) removes the mapping', () => {
    upsertPrinter(newPrinter({ printer_id: 'p1' }));
    setDefaultPrinter('invoice', 'p1');
    setDefaultPrinter('invoice', null);
    expect(getDefaults().invoice).toBeUndefined();
  });

  it('resolveDefaultPrinter returns null when no default is set', () => {
    expect(resolveDefaultPrinter('invoice')).toBeNull();
  });

  it('resolveDefaultPrinter returns null when the default points at a deleted printer', () => {
    upsertPrinter(newPrinter({ printer_id: 'p1' }));
    setDefaultPrinter('invoice', 'p1');
    deletePrinter('p1');
    // delete cleans the map — so still null.
    expect(resolveDefaultPrinter('invoice')).toBeNull();
  });

  it('resolveDefaultPrinter returns the disabled printer (router decides whether to fall back)', () => {
    upsertPrinter(newPrinter({ printer_id: 'p1', enabled: false }));
    setDefaultPrinter('invoice', 'p1');
    const r = resolveDefaultPrinter('invoice');
    expect(r?.printer_id).toBe('p1');
    expect(r?.enabled).toBe(false);
  });

  it('resolveDefaultPrinter returns the enabled printer', () => {
    upsertPrinter(newPrinter({ printer_id: 'p1' }));
    setDefaultPrinter('invoice', 'p1');
    const r = resolveDefaultPrinter('invoice');
    expect(r?.printer_id).toBe('p1');
  });
});

describe('store — corrupt localStorage safe fallback', () => {
  it('listPrinters returns [] when stored value is not JSON', () => {
    localStorage.setItem(__KEYS_TEST_ONLY.printers, '{not json');
    expect(listPrinters()).toEqual([]);
  });

  it('listPrinters returns [] when stored value has wrong shape', () => {
    localStorage.setItem(
      __KEYS_TEST_ONLY.printers,
      JSON.stringify({ definitely: 'not an array' }),
    );
    expect(listPrinters()).toEqual([]);
  });

  it('listPrinters drops the entire array if any element is malformed', () => {
    localStorage.setItem(
      __KEYS_TEST_ONLY.printers,
      JSON.stringify([{ printer_id: 'ok', no_other_fields: true }]),
    );
    expect(listPrinters()).toEqual([]);
  });

  it('getDefaults returns {} when stored value is not JSON', () => {
    localStorage.setItem(__KEYS_TEST_ONLY.defaults, 'broken{');
    expect(getDefaults()).toEqual({});
  });

  it('getDefaults returns {} when stored value has non-string values', () => {
    localStorage.setItem(
      __KEYS_TEST_ONLY.defaults,
      JSON.stringify({ invoice: 12345 }),
    );
    expect(getDefaults()).toEqual({});
  });

  it('getBridgeConfig returns the default URL when localStorage is corrupt', () => {
    localStorage.setItem(__KEYS_TEST_ONLY.bridge, 'broken{');
    expect(getBridgeConfig().base_url).toBe(DEFAULT_BRIDGE_URL);
  });
});

describe('store — markPrintResult', () => {
  it('records ok timestamp + clears last_error on success', () => {
    const p = newPrinter({ printer_id: 'p1', last_error: 'old failure' });
    upsertPrinter(p);
    markPrintResult('p1', { ok: true, at: '2026-05-10T10:00:00Z' });
    const after = getPrinter('p1')!;
    expect(after.last_print_ok_at).toBe('2026-05-10T10:00:00Z');
    expect(after.last_error).toBeNull();
  });

  it('records last_error on failure without clearing last_print_ok_at', () => {
    const p = newPrinter({
      printer_id: 'p1',
      last_print_ok_at: '2026-05-10T08:00:00Z',
    });
    upsertPrinter(p);
    markPrintResult('p1', { ok: false, error: 'BT timeout' });
    const after = getPrinter('p1')!;
    expect(after.last_print_ok_at).toBe('2026-05-10T08:00:00Z');
    expect(after.last_error).toBe('BT timeout');
  });

  it('silently no-ops when the printer is missing', () => {
    expect(() =>
      markPrintResult('does-not-exist', { ok: true, at: 'x' }),
    ).not.toThrow();
  });
});

describe('store — bridge config', () => {
  it('defaults to http://127.0.0.1:8911', () => {
    expect(getBridgeConfig().base_url).toBe(DEFAULT_BRIDGE_URL);
    expect(DEFAULT_BRIDGE_URL).toBe('http://127.0.0.1:8911');
  });

  it('setBridgeConfig persists the URL', () => {
    setBridgeConfig({ base_url: 'http://localhost:9999' });
    expect(getBridgeConfig().base_url).toBe('http://localhost:9999');
  });
});
