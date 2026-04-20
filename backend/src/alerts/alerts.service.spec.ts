import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AlertsService } from './alerts.service';
import { AlertSeverity, AlertType } from './dto/alert.dto';

/**
 * Unit tests for AlertsService — the DataSource is mocked so we assert only
 * the SQL shape and the service's orchestration logic, not the database.
 */
describe('AlertsService', () => {
  let service: AlertsService;
  let ds: { query: jest.Mock };

  beforeEach(async () => {
    ds = { query: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AlertsService,
        { provide: DataSource, useValue: ds },
      ],
    }).compile();

    service = moduleRef.get(AlertsService);
  });

  describe('create', () => {
    it('inserts an alert with defaults and returns the row', async () => {
      const row = { id: 42, title: 'hello' };
      ds.query.mockResolvedValueOnce([row]);

      const res = await service.create({
        alert_type: AlertType.low_stock,
        title: 'hello',
      });

      expect(res).toBe(row);
      const [, params] = ds.query.mock.calls[0];
      expect(params[0]).toBe('low_stock');
      expect(params[1]).toBe(AlertSeverity.info); // default severity
      expect(params[2]).toBe('hello');
      expect(params[8]).toBe('{}'); // empty metadata JSON
    });

    it('serializes metadata as JSON', async () => {
      ds.query.mockResolvedValueOnce([{ id: 1 }]);
      await service.create({
        alert_type: AlertType.low_stock,
        title: 'x',
        metadata: { sku: 'ABC', qty: 3 },
      });
      const [, params] = ds.query.mock.calls[0];
      expect(JSON.parse(params[8])).toEqual({ sku: 'ABC', qty: 3 });
    });
  });

  describe('counts', () => {
    it('returns zeroed counts when no user filter', async () => {
      ds.query.mockResolvedValueOnce([
        { total: 0, unread: 0, unresolved: 0, critical: 0, warning: 0 },
      ]);
      const res = await service.counts();
      expect(res.total).toBe(0);
      const [sql, params] = ds.query.mock.calls[0];
      expect(sql).not.toContain('WHERE target_user_id');
      expect(params).toEqual([]);
    });

    it('applies user filter when userId is provided', async () => {
      ds.query.mockResolvedValueOnce([{}]);
      await service.counts('user-123');
      const [sql, params] = ds.query.mock.calls[0];
      expect(sql).toContain('WHERE target_user_id = $1');
      expect(params).toEqual(['user-123']);
    });
  });

  describe('resolve', () => {
    it('throws NotFoundException when alert does not exist', async () => {
      ds.query.mockResolvedValueOnce([]);
      await expect(service.resolve(999, 'u1')).rejects.toThrow(
        'التنبيه غير موجود',
      );
    });

    it('marks alert resolved with user + timestamp', async () => {
      const row = { id: 7, is_resolved: true };
      ds.query.mockResolvedValueOnce([row]);
      const res = await service.resolve(7, 'user-1');
      expect(res).toBe(row);
      const [, params] = ds.query.mock.calls[0];
      expect(params).toEqual(['user-1', 7]);
    });
  });

  describe('runScan', () => {
    it('creates a low_stock alert only when none exists for the variant', async () => {
      const lowStockRow = {
        variant_id: 'v1',
        product_name: 'شنطة',
        quantity: 2,
        reorder_point: 5,
      };

      ds.query
        .mockResolvedValueOnce([lowStockRow]) // v_dashboard_low_stock
        .mockResolvedValueOnce([]) // existing alert check → none
        .mockResolvedValueOnce([{ id: 101 }]) // INSERT alert
        .mockResolvedValueOnce([]) // expiring reservations
        .mockResolvedValueOnce([]); // cash mismatches

      const res = await service.runScan();
      expect(res.created).toBe(1);
      expect(res.alerts[0].id).toBe(101);
    });

    it('skips variant that already has an unresolved alert', async () => {
      const lowStockRow = {
        variant_id: 'v1',
        product_name: 'شنطة',
        quantity: 0,
        reorder_point: 5,
      };

      ds.query
        .mockResolvedValueOnce([lowStockRow])
        .mockResolvedValueOnce([{ id: 55 }]) // existing alert → skip
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const res = await service.runScan();
      expect(res.created).toBe(0);
    });

    it('flags critical severity when quantity <= 0', async () => {
      const lowStockRow = {
        variant_id: 'v2',
        product_name: 'حذاء',
        quantity: 0,
        reorder_point: 5,
      };

      ds.query
        .mockResolvedValueOnce([lowStockRow])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 1 }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await service.runScan();
      // the insert call (3rd) should carry severity='critical' as 2nd param
      const insertCall = ds.query.mock.calls[2];
      expect(insertCall[1][1]).toBe('critical');
    });
  });
});
