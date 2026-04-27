/**
 * employees.controller.requests-history.spec.ts — PR-ESS-2C-2
 * ────────────────────────────────────────────────────────────────────
 *
 * Verifies the wiring of the new request-history endpoints:
 *
 *   · GET /employees/me/requests           — JWT user, employee.dashboard.view
 *   · GET /employees/:id/requests          — admin path, employee.team.view
 *
 * We don't boot a Nest module — we read the @Permissions metadata
 * directly via Reflect.getMetadata + invoke each handler with a
 * stubbed service to confirm:
 *
 *   1. /me/requests filters the JWT user only (path/query cannot
 *      redirect the lookup to a different user)
 *   2. /:id/requests filters by the path UUID
 *   3. Both handlers parse limit/offset to numbers and forward the
 *      filter object verbatim to the service layer
 *   4. Permissions metadata is the documented gate for each route
 */

import { EmployeesController } from './employees.controller';
import { PERMISSIONS_KEY } from '../common/decorators/roles.decorator';

describe('EmployeesController — request-history endpoints (PR-ESS-2C-2)', () => {
  let svc: {
    myRequests: jest.Mock;
    listEmployeeRequests: jest.Mock;
  };
  let ctrl: EmployeesController;

  beforeEach(() => {
    svc = {
      myRequests: jest.fn().mockResolvedValue([]),
      listEmployeeRequests: jest.fn().mockResolvedValue([]),
    };
    ctrl = new EmployeesController(svc as any);
  });

  describe('@Permissions metadata', () => {
    it('GET /me/requests is gated by employee.dashboard.view', () => {
      const meta = Reflect.getMetadata(
        PERMISSIONS_KEY,
        EmployeesController.prototype.myRequests,
      );
      expect(meta).toEqual(['employee.dashboard.view']);
    });

    it('GET /:id/requests is gated by employee.team.view', () => {
      const meta = Reflect.getMetadata(
        PERMISSIONS_KEY,
        EmployeesController.prototype.listEmployeeRequests,
      );
      expect(meta).toEqual(['employee.team.view']);
    });
  });

  describe('myRequests handler', () => {
    it('always uses JWT.userId — never accepts a path/query override', async () => {
      const jwt = { userId: 'jwt-user-123' } as any;
      await ctrl.myRequests(jwt);
      expect(svc.myRequests).toHaveBeenCalledWith('jwt-user-123', {
        kind: undefined,
        status: undefined,
        from: undefined,
        to: undefined,
        limit: undefined,
        offset: undefined,
      });
    });

    it('forwards every filter and parses limit/offset to numbers', async () => {
      const jwt = { userId: 'jwt-user-123' } as any;
      await ctrl.myRequests(
        jwt,
        'advance_request',
        'approved',
        '2026-04-01',
        '2026-04-30',
        '25',
        '50',
      );
      expect(svc.myRequests).toHaveBeenCalledWith('jwt-user-123', {
        kind: 'advance_request',
        status: 'approved',
        from: '2026-04-01',
        to: '2026-04-30',
        limit: 25,
        offset: 50,
      });
    });
  });

  describe('listEmployeeRequests handler', () => {
    it('binds the path UUID as the user filter (no JWT involved)', async () => {
      await ctrl.listEmployeeRequests('emp-aaa');
      expect(svc.listEmployeeRequests).toHaveBeenCalledWith('emp-aaa', {
        kind: undefined,
        status: undefined,
        from: undefined,
        to: undefined,
        limit: undefined,
        offset: undefined,
      });
    });

    it('forwards every filter and parses limit/offset to numbers', async () => {
      await ctrl.listEmployeeRequests(
        'emp-bbb',
        'leave',
        'rejected',
        '2026-01-01',
        '2026-12-31',
        '10',
        '20',
      );
      expect(svc.listEmployeeRequests).toHaveBeenCalledWith('emp-bbb', {
        kind: 'leave',
        status: 'rejected',
        from: '2026-01-01',
        to: '2026-12-31',
        limit: 10,
        offset: 20,
      });
    });
  });
});
