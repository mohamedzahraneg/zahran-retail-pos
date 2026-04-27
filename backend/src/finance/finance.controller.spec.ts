/**
 * finance.controller.spec.ts — PR-FIN-2
 *
 * Verifies the controller wiring without booting Nest:
 *   1. @Permissions metadata is `finance.dashboard.view`
 *   2. Filters from query params are forwarded verbatim to the service
 */

import { FinanceController } from './finance.controller';
import { PERMISSIONS_KEY } from '../common/decorators/roles.decorator';

describe('FinanceController — PR-FIN-2', () => {
  let svc: { dashboard: jest.Mock };
  let ctrl: FinanceController;

  beforeEach(() => {
    svc = { dashboard: jest.fn().mockResolvedValue({}) };
    ctrl = new FinanceController(svc as any);
  });

  it('class-level @Permissions = finance.dashboard.view', () => {
    const meta = Reflect.getMetadata(PERMISSIONS_KEY, FinanceController);
    expect(meta).toEqual(['finance.dashboard.view']);
  });

  it('forwards every query param into the filters object', async () => {
    await ctrl.dashboard(
      '2026-04-01',
      '2026-04-30',
      'cb-123',
      'pa-456',
      'user-789',
      'shift-abc',
    );
    expect(svc.dashboard).toHaveBeenCalledWith({
      from: '2026-04-01',
      to: '2026-04-30',
      cashbox_id: 'cb-123',
      payment_account_id: 'pa-456',
      user_id: 'user-789',
      shift_id: 'shift-abc',
    });
  });

  it('passes undefined when filters are omitted', async () => {
    await ctrl.dashboard();
    expect(svc.dashboard).toHaveBeenCalledWith({
      from: undefined,
      to: undefined,
      cashbox_id: undefined,
      payment_account_id: undefined,
      user_id: undefined,
      shift_id: undefined,
    });
  });
});
