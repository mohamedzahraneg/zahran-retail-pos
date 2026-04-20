import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { SyncService } from './sync.service';
import { PosService } from '../pos/pos.service';

describe('SyncService.push', () => {
  let service: SyncService;
  let ds: { query: jest.Mock };
  let pos: { createInvoice: jest.Mock };

  const baseOp = {
    offline_id: 'op-1',
    entity: 'invoice' as const,
    operation: 'I' as const,
    payload: { warehouse_id: 'w1', lines: [{ qty: 1, unit_price: 10 }] },
    client_created_at: new Date().toISOString(),
  };

  beforeEach(async () => {
    ds = { query: jest.fn() };
    pos = { createInvoice: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        SyncService,
        { provide: DataSource, useValue: ds },
        { provide: PosService, useValue: pos },
      ],
    }).compile();

    service = moduleRef.get(SyncService);
  });

  it('skips already-synced operations as duplicates', async () => {
    // existing check returns a 'synced' row
    ds.query.mockResolvedValueOnce([
      { id: 1, state: 'synced', server_id: 'inv-99' },
    ]);

    const res = await service.push(
      { client_id: 'dev-1', operations: [baseOp] },
      'user-1',
    );

    expect(res.synced).toBe(0);
    expect(res.duplicates).toBe(1);
    expect(pos.createInvoice).not.toHaveBeenCalled();
    expect(res.results[0]).toMatchObject({
      offline_id: 'op-1',
      state: 'duplicate',
      server_id: 'inv-99',
    });
  });

  it('processes a fresh invoice op end-to-end', async () => {
    ds.query
      .mockResolvedValueOnce([]) // existing check → none
      .mockResolvedValueOnce([]) // upsert pending row
      .mockResolvedValueOnce([]); // mark synced

    pos.createInvoice.mockResolvedValueOnce({
      invoice_id: 'inv-42',
      doc_no: 'INV-001',
      grand_total: 10,
      change_given: 0,
    });

    const res = await service.push(
      { client_id: 'dev-1', operations: [baseOp] },
      'user-1',
    );

    expect(pos.createInvoice).toHaveBeenCalledWith(
      baseOp.payload,
      'user-1',
    );
    expect(res.synced).toBe(1);
    expect(res.duplicates).toBe(0);
    expect(res.failed).toBe(0);
    expect(res.results[0]).toMatchObject({
      state: 'synced',
      server_id: 'inv-42',
    });
  });

  it('records a conflict when downstream throws a duplicate-key error', async () => {
    ds.query
      .mockResolvedValueOnce([]) // existing
      .mockResolvedValueOnce([]) // upsert
      .mockResolvedValueOnce([]); // mark conflict

    const err: any = new Error('duplicate key value violates unique constraint');
    err.code = '23505';
    pos.createInvoice.mockRejectedValueOnce(err);

    const res = await service.push(
      { client_id: 'dev-1', operations: [baseOp] },
      'user-1',
    );

    expect(res.conflicts).toBe(1);
    expect(res.failed).toBe(0);
    expect(res.results[0].state).toBe('conflict');
    expect(res.results[0].conflict_reason).toContain('duplicate');
  });

  it('records a generic failure when downstream throws an unknown error', async () => {
    ds.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    pos.createInvoice.mockRejectedValueOnce(new Error('boom'));

    const res = await service.push(
      { client_id: 'dev-1', operations: [baseOp] },
      'user-1',
    );

    expect(res.failed).toBe(1);
    expect(res.conflicts).toBe(0);
    expect(res.results[0].state).toBe('failed');
    expect(res.results[0].error).toBe('boom');
  });

  it('processes a batch of mixed outcomes correctly', async () => {
    const ops = [
      { ...baseOp, offline_id: 'op-1' },
      { ...baseOp, offline_id: 'op-2' },
      { ...baseOp, offline_id: 'op-3' },
    ];

    // op-1: duplicate
    ds.query.mockResolvedValueOnce([
      { id: 1, state: 'synced', server_id: 'inv-A' },
    ]);

    // op-2: success
    ds.query
      .mockResolvedValueOnce([]) // existing
      .mockResolvedValueOnce([]) // upsert
      .mockResolvedValueOnce([]); // mark synced
    pos.createInvoice.mockResolvedValueOnce({ invoice_id: 'inv-B' });

    // op-3: failure
    ds.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    pos.createInvoice.mockRejectedValueOnce(new Error('network'));

    const res = await service.push(
      { client_id: 'dev-x', operations: ops },
      'user-1',
    );

    expect(res.processed).toBe(3);
    expect(res.duplicates).toBe(1);
    expect(res.synced).toBe(1);
    expect(res.failed).toBe(1);
    expect(res.results.map((r) => r.state)).toEqual([
      'duplicate',
      'synced',
      'failed',
    ]);
  });
});
