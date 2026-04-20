import { nanoid } from 'nanoid';
import toast from 'react-hot-toast';
import { db, PendingInvoice } from './db';
import { syncApi, SyncOperation } from '@/api/sync.api';
import type { CreateInvoicePayload } from '@/api/pos.api';

const MAX_RETRIES = Number(import.meta.env.VITE_OFFLINE_MAX_RETRY || 5);
const BATCH_SIZE = 50;
const CLIENT_ID_KEY = 'zahran-client-id';

/** Stable per-device client id, persisted in localStorage */
function getClientId(): string {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = `dev-${nanoid(12)}`;
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

export const offlineQueue = {
  clientId: getClientId,

  /** Enqueue an invoice to be retried when online */
  async enqueueInvoice(payload: CreateInvoicePayload): Promise<string> {
    const id = nanoid();
    await db.pendingInvoices.put({
      id,
      payload,
      createdAt: Date.now(),
      attempts: 0,
    });
    return id;
  },

  async pending(): Promise<PendingInvoice[]> {
    return db.pendingInvoices.orderBy('createdAt').toArray();
  },

  async count(): Promise<number> {
    return db.pendingInvoices.count();
  },

  async remove(id: string): Promise<void> {
    await db.pendingInvoices.delete(id);
  },

  /**
   * Attempt to send all pending invoices via the batched /sync/push endpoint.
   * Server uses (client_id, offline_id) for idempotency, so retries are safe.
   */
  async sync(): Promise<{ sent: number; failed: number; conflicts: number }> {
    if (!navigator.onLine) return { sent: 0, failed: 0, conflicts: 0 };

    const queue = await this.pending();
    if (queue.length === 0) return { sent: 0, failed: 0, conflicts: 0 };

    const clientId = getClientId();
    let sent = 0;
    let failed = 0;
    let conflicts = 0;

    // Send in batches so a flaky connection doesn't lose everything
    for (let i = 0; i < queue.length; i += BATCH_SIZE) {
      const batch = queue.slice(i, i + BATCH_SIZE);
      const operations: SyncOperation[] = batch.map((item) => ({
        offline_id: item.id,
        entity: 'invoice',
        operation: 'I',
        payload: item.payload,
        client_created_at: new Date(item.createdAt).toISOString(),
      }));

      try {
        const res = await syncApi.push(clientId, operations);
        for (const r of res.results) {
          const item = batch.find((b) => b.id === r.offline_id);
          if (!item) continue;

          if (r.state === 'synced' || r.state === 'duplicate') {
            await this.remove(item.id);
            sent += 1;
          } else if (r.state === 'conflict') {
            // Conflict — drop it but record the reason for the user
            await this.remove(item.id);
            conflicts += 1;
            // eslint-disable-next-line no-console
            console.warn('[sync] conflict for', item.id, r.conflict_reason);
          } else {
            // failed → bump attempts, drop after MAX_RETRIES
            const attempts = item.attempts + 1;
            if (attempts >= MAX_RETRIES) {
              await this.remove(item.id);
            } else {
              await db.pendingInvoices.update(item.id, {
                attempts,
                lastError: r.error || 'unknown error',
              });
            }
            failed += 1;
          }
        }
      } catch (err: any) {
        // Whole-batch network failure — bump attempts on all in this batch
        for (const item of batch) {
          const attempts = item.attempts + 1;
          if (attempts >= MAX_RETRIES) {
            await this.remove(item.id);
          } else {
            await db.pendingInvoices.update(item.id, {
              attempts,
              lastError: err?.message || String(err),
            });
          }
          failed += 1;
        }
        // Stop trying further batches if the network died
        break;
      }
    }

    if (sent > 0) {
      toast.success(`تمت مزامنة ${sent} فاتورة معلّقة`);
    }
    if (conflicts > 0) {
      toast.error(`${conflicts} فاتورة بها تعارض — راجع السجل`);
    }
    if (failed > 0 && sent === 0 && conflicts === 0) {
      toast.error(`فشلت مزامنة ${failed} فاتورة — سيُعاد المحاولة`);
    }
    return { sent, failed, conflicts };
  },
};

/** Auto-sync when the browser comes back online */
export function startAutoSync() {
  window.addEventListener('online', () => {
    offlineQueue.sync().catch(() => {});
  });

  // Periodic background sync every 60s while online
  setInterval(() => {
    if (navigator.onLine) {
      offlineQueue.sync().catch(() => {});
    }
  }, 60_000);
}
