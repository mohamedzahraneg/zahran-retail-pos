/**
 * Bridge client — health probe + submit.  Uses a mocked global fetch
 * so the tests run with no network.  Covers timeout, unreachable,
 * bad-status, parse-error, and happy-path branches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { probeBridge, submitJob } from '../bridge';
import { __resetPrinterStore_TEST_ONLY } from '../store';
import type { PrintJob } from '../types';

const job: PrintJob = {
  job_id: 'j-1',
  document_type: 'invoice',
  document_id: 'INV-1',
  copies: 1,
  payload: { kind: 'escpos_html', html: '<x/>', width_mm: 80 },
  emitted_at: new Date().toISOString(),
};

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  // @ts-expect-error vitest assigns global
  globalThis.fetch = vi.fn(impl);
}

beforeEach(() => {
  __resetPrinterStore_TEST_ONLY();
});

afterEach(() => {
  __resetPrinterStore_TEST_ONLY();
  vi.restoreAllMocks();
});

describe('probeBridge', () => {
  it('returns ok when /health returns 200 + {ok:true}', async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ ok: true, version: '0.1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const r = await probeBridge();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.version).toBe('0.1');
    }
  });

  it('returns reason=bad_status on non-2xx', async () => {
    mockFetch(async () => new Response('', { status: 500 }));
    const r = await probeBridge();
    expect(r).toEqual({ ok: false, reason: 'bad_status', status: 500 });
  });

  it('returns reason=parse on malformed JSON', async () => {
    mockFetch(
      async () =>
        new Response('not json {{{', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const r = await probeBridge();
    expect(r).toEqual({ ok: false, reason: 'parse' });
  });

  it('returns reason=parse when body lacks ok=true', async () => {
    mockFetch(
      async () =>
        new Response(JSON.stringify({ ok: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const r = await probeBridge();
    expect(r).toEqual({ ok: false, reason: 'parse' });
  });

  it('returns reason=unreachable when fetch rejects (network error)', async () => {
    mockFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    const r = await probeBridge();
    expect(r).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('returns reason=timeout when AbortController fires', async () => {
    mockFetch(async () => {
      const e: any = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    });
    const r = await probeBridge();
    expect(r).toEqual({ ok: false, reason: 'timeout' });
  });
});

describe('submitJob', () => {
  it('returns ok when bridge responds 200 + {ok:true}', async () => {
    mockFetch(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const r = await submitJob(job);
    expect(r).toEqual({ ok: true });
  });

  it('returns bad_status with bridge-supplied error message', async () => {
    mockFetch(
      async () =>
        new Response(
          JSON.stringify({ ok: false, error: 'BT not paired' }),
          { status: 502, headers: { 'content-type': 'application/json' } },
        ),
    );
    const r = await submitJob(job);
    expect(r).toEqual({
      ok: false,
      reason: 'bad_status',
      status: 502,
      message: 'BT not paired',
    });
  });

  it('returns timeout on AbortError', async () => {
    mockFetch(async () => {
      const e: any = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    });
    const r = await submitJob(job);
    expect(r).toEqual({ ok: false, reason: 'timeout' });
  });

  it('returns unreachable on generic network error', async () => {
    mockFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    const r = await submitJob(job);
    expect(r).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('does not throw on parse error (returns reason=parse)', async () => {
    mockFetch(
      async () =>
        new Response('definitely not json', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const r = await submitJob(job);
    expect(r).toEqual({ ok: false, reason: 'parse' });
  });

  it('hits the configured bridge URL + /print/jobs', async () => {
    let captured: string = '';
    mockFetch(async (url) => {
      captured = url;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    await submitJob(job);
    expect(captured).toBe('http://127.0.0.1:8911/print/jobs');
  });
});
