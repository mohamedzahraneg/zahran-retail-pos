/**
 * payments.controller.spec.ts — PR-FIN-PAYACCT-4D-UX-FIX-9-HOTFIX-1
 *
 * Production threw `invalid input syntax for type uuid: "unattached-summary"`
 * when /cashboxes opened. Root cause: the static
 * `GET /payment-accounts/unattached-summary` route was declared
 * AFTER the dynamic `GET /payment-accounts/:id` route in the
 * controller, so Express/NestJS matched the dynamic placeholder
 * first and called `getById('unattached-summary')` → the service
 * fired `WHERE id = 'unattached-summary'` → Postgres uuid coercion
 * failed → 500.
 *
 * This spec uses NestJS's reflect-metadata to introspect the
 * controller's route registrations and pin two invariants:
 *
 *   1. Every static route under `payment-accounts/...` MUST be
 *      declared BEFORE its dynamic-`:id` sibling on the same HTTP
 *      verb. Anyone reordering methods (or adding a new static
 *      route below `:id`) hits an immediate test failure.
 *
 *   2. Every dynamic `:id` parameter is bound through
 *      `ParseUUIDPipe` (defense-in-depth — even if route ordering
 *      regresses, a non-uuid slug returns clean 400 not SQL 500).
 *
 * Pure unit test — no app boot, no supertest. Reflects on the
 * controller class metadata via `Reflect.getMetadata`.
 */
import 'reflect-metadata';
import {
  PATH_METADATA,
  METHOD_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { PaymentsController } from './payments.controller';

interface RouteMeta {
  name: string;
  declarationOrder: number;
  path: string;
  method: number; // RequestMethod enum
}

function getRoutes(): RouteMeta[] {
  const proto = PaymentsController.prototype;
  const names = Object.getOwnPropertyNames(proto).filter(
    (n) => n !== 'constructor' && typeof (proto as any)[n] === 'function',
  );
  return names.map((name, i) => ({
    name,
    declarationOrder: i,
    path: Reflect.getMetadata(PATH_METADATA, (proto as any)[name]),
    method: Reflect.getMetadata(METHOD_METADATA, (proto as any)[name]),
  }));
}

const routes = getRoutes();
const get = (path: string) =>
  routes.find((r) => r.path === path && r.method === RequestMethod.GET);
const post = (path: string) =>
  routes.find((r) => r.path === path && r.method === RequestMethod.POST);
const patch = (path: string) =>
  routes.find((r) => r.path === path && r.method === RequestMethod.PATCH);
const del = (path: string) =>
  routes.find((r) => r.path === path && r.method === RequestMethod.DELETE);

describe('PaymentsController route ordering — PR-FIN-PAYACCT-4D-UX-FIX-9-HOTFIX-1', () => {
  it('every payment-accounts route the production tree calls is registered', () => {
    expect(get('payment-accounts')).toBeDefined();
    expect(get('payment-accounts/balances')).toBeDefined();
    expect(get('payment-accounts/unattached-summary')).toBeDefined();
    expect(get('payment-accounts/:id')).toBeDefined();
    expect(get('payment-accounts/:id/movements')).toBeDefined();
    expect(post('payment-accounts')).toBeDefined();
    expect(post('payment-accounts/backfill-unattached')).toBeDefined();
    expect(post('payment-accounts/:id/set-default')).toBeDefined();
    expect(post('payment-accounts/:id/toggle-active')).toBeDefined();
    expect(patch('payment-accounts/:id')).toBeDefined();
    expect(patch('payment-accounts/:id/deactivate')).toBeDefined();
    expect(patch('payment-accounts/:id/set-default')).toBeDefined();
    expect(del('payment-accounts/:id')).toBeDefined();
  });

  it('GET /payment-accounts/unattached-summary registers BEFORE GET /payment-accounts/:id', () => {
    const summary = get('payment-accounts/unattached-summary')!;
    const byId = get('payment-accounts/:id')!;
    // The exact bug from production: static slug captured by `:id`
    // because it was declared after. The fix is hard-pinned here.
    expect(summary.declarationOrder).toBeLessThan(byId.declarationOrder);
    expect(summary.name).toBe('unattachedSummary');
    expect(byId.name).toBe('getById');
  });

  it('GET /payment-accounts/balances also registers BEFORE :id (regression guard)', () => {
    expect(
      get('payment-accounts/balances')!.declarationOrder,
    ).toBeLessThan(get('payment-accounts/:id')!.declarationOrder);
  });

  it('POST /payment-accounts/backfill-unattached registers BEFORE any POST :id route', () => {
    const bf = post('payment-accounts/backfill-unattached')!;
    // POST /:id sub-segment routes (set-default, toggle-active) don't
    // structurally collide (different segment counts), but keeping
    // static-first is a belt-and-suspenders invariant.
    const setDefault = post('payment-accounts/:id/set-default')!;
    const toggleActive = post('payment-accounts/:id/toggle-active')!;
    expect(bf.declarationOrder).toBeLessThan(setDefault.declarationOrder);
    expect(bf.declarationOrder).toBeLessThan(toggleActive.declarationOrder);
  });

  /**
   * General invariant: for any GET path of the form
   * `payment-accounts/<static-slug>`, that static slug MUST be
   * declared before any GET path of the form `payment-accounts/:id`.
   * This catches future drift even if the specific slug isn't
   * enumerated above.
   */
  it('every static GET payment-accounts/<slug> registers before the dynamic :id sibling', () => {
    const dynById = get('payment-accounts/:id')!;
    expect(dynById).toBeDefined();
    const staticSlugs = routes.filter(
      (r) =>
        r.method === RequestMethod.GET &&
        typeof r.path === 'string' &&
        r.path.startsWith('payment-accounts/') &&
        !r.path.includes(':') && // skip dynamic placeholders
        r.path !== 'payment-accounts',
    );
    expect(staticSlugs.length).toBeGreaterThan(0);
    for (const s of staticSlugs) {
      expect({ slug: s.path, dynPath: dynById.path }).toEqual({
        slug: s.path,
        dynPath: 'payment-accounts/:id',
      });
      expect(s.declarationOrder).toBeLessThan(dynById.declarationOrder);
    }
  });
});

describe('PaymentsController ParseUUIDPipe — PR-FIN-PAYACCT-4D-UX-FIX-9-HOTFIX-1', () => {
  /**
   * NestJS stores @Param() pipe metadata under ROUTE_ARGS_METADATA.
   * Each entry's value carries `pipes: Type[]`. We assert that every
   * route which captures `:id` binds it through `ParseUUIDPipe` so a
   * non-uuid slug returns 400 BadRequest cleanly (not a Postgres uuid
   * coercion 500). Defense in depth — even if the static-before-
   * dynamic invariant breaks, the pipe still prevents the 500.
   */
  function paramPipesFor(methodName: string): Function[] {
    const args = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      PaymentsController,
      methodName,
    );
    if (!args) return [];
    // args is keyed by `<type>:<index>`; we only care about @Param entries.
    const pipes: Function[] = [];
    for (const key of Object.keys(args)) {
      const entry = args[key];
      if (entry?.pipes) pipes.push(...entry.pipes);
    }
    return pipes;
  }

  it('GET /payment-accounts/:id binds id through ParseUUIDPipe', () => {
    const pipes = paramPipesFor('getById');
    expect(pipes.map((p: any) => p.name)).toContain('ParseUUIDPipe');
  });

  it('GET /payment-accounts/:id/movements binds id through ParseUUIDPipe', () => {
    const pipes = paramPipesFor('listMovements');
    expect(pipes.map((p: any) => p.name)).toContain('ParseUUIDPipe');
  });

  it('every dynamic :id route binds id through ParseUUIDPipe', () => {
    const dynamicMethods = [
      'getById',
      'listMovements',
      'update',
      'deactivate',
      'setDefault',
      'setDefaultPost',
      'toggleActive',
      'deletePaymentAccount',
    ];
    for (const name of dynamicMethods) {
      const pipes = paramPipesFor(name);
      expect({
        method: name,
        pipes: pipes.map((p: any) => p.name),
      }).toMatchObject({
        method: name,
        pipes: expect.arrayContaining(['ParseUUIDPipe']),
      });
    }
  });
});
