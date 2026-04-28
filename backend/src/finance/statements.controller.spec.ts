/**
 * statements.controller.spec.ts — PR-FIN-3
 *
 * Pins controller wiring:
 *   1. class-level @Permissions = 'finance.statements.view'
 *   2. each handler forwards filters verbatim to the service
 *   3. cashbox direction param only passes 'in'/'out' (other values dropped)
 *   4. include_voided is parsed from string 'true' to boolean true
 */

import { StatementsController } from './statements.controller';
import { PERMISSIONS_KEY } from '../common/decorators/roles.decorator';

describe('StatementsController — PR-FIN-3', () => {
  let svc: {
    glAccountStatement: jest.Mock;
    cashboxStatement: jest.Mock;
    employeeStatement: jest.Mock;
    customerStatement: jest.Mock;
    supplierStatement: jest.Mock;
  };
  let ctrl: StatementsController;

  beforeEach(() => {
    svc = {
      glAccountStatement: jest.fn().mockResolvedValue({}),
      cashboxStatement: jest.fn().mockResolvedValue({}),
      employeeStatement: jest.fn().mockResolvedValue({}),
      customerStatement: jest.fn().mockResolvedValue({}),
      supplierStatement: jest.fn().mockResolvedValue({}),
    };
    ctrl = new StatementsController(svc as any);
  });

  it('class-level @Permissions = finance.statements.view', () => {
    const meta = Reflect.getMetadata(PERMISSIONS_KEY, StatementsController);
    expect(meta).toEqual(['finance.statements.view']);
  });

  it('GL handler forwards id + range + include_voided=true when string=true', async () => {
    await ctrl.glAccount('acc-1', '2026-04-01', '2026-04-28', 'true');
    expect(svc.glAccountStatement).toHaveBeenCalledWith('acc-1', {
      from: '2026-04-01',
      to: '2026-04-28',
      include_voided: true,
    });
  });

  it('GL handler defaults include_voided=false when omitted', async () => {
    await ctrl.glAccount('acc-1');
    expect(svc.glAccountStatement).toHaveBeenCalledWith('acc-1', {
      from: undefined,
      to: undefined,
      include_voided: false,
    });
  });

  it('cashbox handler accepts direction in/out and drops anything else', async () => {
    await ctrl.cashbox('cb-1', undefined, undefined, 'in');
    expect(svc.cashboxStatement).toHaveBeenCalledWith('cb-1', {
      from: undefined,
      to: undefined,
      direction: 'in',
    });
    await ctrl.cashbox('cb-1', undefined, undefined, 'out');
    expect(svc.cashboxStatement).toHaveBeenCalledWith('cb-1', {
      from: undefined,
      to: undefined,
      direction: 'out',
    });
    await ctrl.cashbox('cb-1', undefined, undefined, 'malicious');
    expect(svc.cashboxStatement).toHaveBeenCalledWith('cb-1', {
      from: undefined,
      to: undefined,
      direction: undefined,
    });
  });

  it.each([
    ['employee', 'employeeStatement', 'employee'],
    ['customer', 'customerStatement', 'customer'],
    ['supplier', 'supplierStatement', 'supplier'],
  ])(
    '%s handler forwards id + range only',
    async (handler, svcMethod) => {
      await (ctrl as any)[handler]('id-1', '2026-04-01', '2026-04-28');
      expect((svc as any)[svcMethod]).toHaveBeenCalledWith('id-1', {
        from: '2026-04-01',
        to: '2026-04-28',
      });
    },
  );
});
