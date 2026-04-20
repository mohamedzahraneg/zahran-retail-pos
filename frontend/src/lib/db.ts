import Dexie, { type Table } from 'dexie';

/** IndexedDB wrapper for offline support */

export interface PendingInvoice {
  id: string;
  payload: any;
  createdAt: number;
  attempts: number;
  lastError?: string;
}

export interface CachedProduct {
  id: string;
  data: any;
  updatedAt: number;
}

class ZahranDatabase extends Dexie {
  pendingInvoices!: Table<PendingInvoice, string>;
  products!: Table<CachedProduct, string>;

  constructor() {
    super('zahran-offline');
    this.version(1).stores({
      pendingInvoices: 'id, createdAt, attempts',
      products: 'id, updatedAt',
    });
  }
}

export const db = new ZahranDatabase();
