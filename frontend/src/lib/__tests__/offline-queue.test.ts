import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the offline queue sync loop.
 *
 * We mock out the Dexie-backed `db`, the HTTP `syncApi`, and the
 * `react-hot-toast` global so we can drive the sync() function
 * with whatever state we need and observe its side-effects.
 */

// Mock toast so we don't need a DOM container
vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock the IndexedDB layer
const mockDb = {
  pendingInvoices: {
    put: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
    orderBy: vi.fn(() => ({ toArray: vi.fn() })),
  },
};

vi.mock('../db', () => ({
  db: mockDb,
}));

// Mock the HTTP sync client
const pushMock = vi.fn();
vi.mock('@/api/sync.api', () => ({
  syncApi: {
    push: (...args: any[]) => pushMock(...args),
    pull: vi.fn(),
    status: vi.fn(),
  },
}));

// Pretend we're always online
Object.defineProperty(globalThis.navigator, 'onLine', {
  configurable: true,
  get: () => true,
});

// Local storage shim for getClientId
const lsStore: Record<string, string> = {};
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => lsStore[k] ?? null,
    setItem: (k: string, v: string) => {
      lsStore[k] = v;
    },
    removeItem: (k: string) => {
      delete lsStore[k];
    },
    clear: () => {
      for (const k of Object.keys(lsStore)) delete lsStore[k];
    },
  },
  configurable: true,
});

// Import AFTER the mocks are registered
import { offlineQueue } from '../offline-queue';

const setQueue = (items: any[]) => {
  mockDb.pendingInvoices.orderBy.mockReturnValue({
    toArray: vi.fn().mockResolvedValue(items),
  });
};

describe('offlineQueue.sync', () => {
  beforeEach(() => {
    pushMock.mockReset();
    mockDb.pendingInvoices.delete.mockReset();
    mockDb.pendingInvoices.update.mockReset();
    mockDb.pendingInvoices.count.mockReset();
    mockDb.pendingInvoices.put.mockReset();
    mockDb.pendingInvoices.orderBy.mockReset();
  });

  it('returns zeros when the queue is empty', async () => {
    setQueue([]);
    const res = await offlineQueue.sync();
    expect(res).toEqual({ sent: 0, failed: 0, conflicts: 0 });
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('removes successfully-synced items and counts them', async () => {
    setQueue([
      { id: 'op-1', payload: { x: 1 }, createdAt: 1, attempts: 0 },
      { id: 'op-2', payload: { x: 2 }, createdAt: 2, attempts: 0 },
    ]);
    pushMock.mockResolvedValue({
      results: [
        { offline_id: 'op-1', state: 'synced' },
        { offline_id: 'op-2', state: 'duplicate' },
      ],
    });

    const res = await offlineQueue.sync();

    expect(res.sent).toBe(2);
    expect(res.failed).toBe(0);
    expect(res.conflicts).toBe(0);
    expect(mockDb.pendingInvoices.delete).toHaveBeenCalledWith('op-1');
    expect(mockDb.pendingInvoices.delete).toHaveBeenCalledWith('op-2');
  });

  it('drops conflicts and counts them separately', async () => {
    setQueue([
      { id: 'op-c', payload: { x: 1 }, createdAt: 1, attempts: 0 },
    ]);
    pushMock.mockResolvedValue({
      results: [
        {
          offline_id: 'op-c',
          state: 'conflict',
          conflict_reason: 'duplicate offline_id',
        },
      ],
    });

    const res = await offlineQueue.sync();

    expect(res.conflicts).toBe(1);
    expect(res.sent).toBe(0);
    expect(mockDb.pendingInvoices.delete).toHaveBeenCalledWith('op-c');
  });

  it('bumps attempts on failure, keeps the row until MAX_RETRIES', async () => {
    setQueue([
      { id: 'op-f', payload: { x: 1 }, createdAt: 1, attempts: 1 },
    ]);
    pushMock.mockResolvedValue({
      results: [
        { offline_id: 'op-f', state: 'failed', error: 'boom' },
      ],
    });

    const res = await offlineQueue.sync();

    expect(res.failed).toBe(1);
    expect(mockDb.pendingInvoices.update).toHaveBeenCalledWith('op-f', {
      attempts: 2,
      lastError: 'boom',
    });
    expect(mockDb.pendingInvoices.delete).not.toHaveBeenCalled();
  });

  it('drops a row that has reached MAX_RETRIES', async () => {
    setQueue([
      { id: 'op-dead', payload: { x: 1 }, createdAt: 1, attempts: 4 },
    ]);
    pushMock.mockResolvedValue({
      results: [
        { offline_id: 'op-dead', state: 'failed', error: 'still broken' },
      ],
    });

    const res = await offlineQueue.sync();

    expect(res.failed).toBe(1);
    // With MAX_RETRIES=5, attempts bumps to 5 → dropped, not updated
    expect(mockDb.pendingInvoices.delete).toHaveBeenCalledWith('op-dead');
  });

  it('on a whole-batch network error, bumps attempts and stops', async () => {
    setQueue([
      { id: 'op-net-1', payload: { x: 1 }, createdAt: 1, attempts: 0 },
      { id: 'op-net-2', payload: { x: 2 }, createdAt: 2, attempts: 0 },
    ]);
    pushMock.mockRejectedValue(new Error('network down'));

    const res = await offlineQueue.sync();

    expect(res.failed).toBe(2);
    expect(res.sent).toBe(0);
    expect(mockDb.pendingInvoices.update).toHaveBeenCalledTimes(2);
    expect(mockDb.pendingInvoices.update).toHaveBeenCalledWith('op-net-1', {
      attempts: 1,
      lastError: 'network down',
    });
  });

  it('persists the same client_id across syncs', async () => {
    setQueue([
      { id: 'op-1', payload: {}, createdAt: 1, attempts: 0 },
    ]);
    pushMock.mockResolvedValue({
      results: [{ offline_id: 'op-1', state: 'synced' }],
    });
    await offlineQueue.sync();

    const firstCallClientId = pushMock.mock.calls[0][0];

    // Second run – should reuse the same client id
    setQueue([
      { id: 'op-2', payload: {}, createdAt: 2, attempts: 0 },
    ]);
    pushMock.mockResolvedValueOnce({
      results: [{ offline_id: 'op-2', state: 'synced' }],
    });
    await offlineQueue.sync();
    const secondCallClientId = pushMock.mock.calls[1][0];

    expect(firstCallClientId).toBe(secondCallClientId);
    expect(firstCallClientId).toMatch(/^dev-/);
  });
});
