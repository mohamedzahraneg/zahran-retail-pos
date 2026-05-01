/**
 * cash-desk.controller.spec.ts — PR-FIN-PAYACCT-4D-REPORTS-1A
 *
 * Pure unit test that introspects the `CashDeskController` route
 * metadata to pin two invariants for the new drift-detail endpoint:
 *
 *   1. `GET /cash-desk/cashboxes/:id/drift-detail` is registered
 *      and binds `:id` through `ParseUUIDPipe` so a non-uuid slug
 *      returns a clean 400 BadRequest instead of a Postgres uuid
 *      coercion 500. (Same defense as the payments controller's
 *      PR-FIN-PAYACCT-4D-UX-FIX-9-HOTFIX-1 spec.)
 *
 *   2. The static `cashboxes/:id/drift-detail` path doesn't collide
 *      with any other `cashboxes/:id/<...>` path the controller
 *      already exposes — i.e. NestJS won't end up calling the wrong
 *      handler at runtime. (We assert sibling-path uniqueness rather
 *      than declaration order because all current sibling routes
 *      have a longer second segment than `:id`.)
 *
 * Pure unit test — no app boot, no supertest.
 */
import 'reflect-metadata';
import {
  PATH_METADATA,
  METHOD_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { CashDeskController } from './cash-desk.controller';

interface RouteMeta {
  name: string;
  path: string;
  method: number;
}

function getRoutes(): RouteMeta[] {
  const proto = CashDeskController.prototype;
  const names = Object.getOwnPropertyNames(proto).filter(
    (n) => n !== 'constructor' && typeof (proto as any)[n] === 'function',
  );
  return names.map((name) => ({
    name,
    path: Reflect.getMetadata(PATH_METADATA, (proto as any)[name]),
    method: Reflect.getMetadata(METHOD_METADATA, (proto as any)[name]),
  }));
}

function paramPipesFor(methodName: string): Function[] {
  const args = Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    CashDeskController,
    methodName,
  );
  if (!args) return [];
  const pipes: Function[] = [];
  for (const key of Object.keys(args)) {
    const entry = args[key];
    if (entry?.pipes) pipes.push(...entry.pipes);
  }
  return pipes;
}

const routes = getRoutes();
const get = (path: string) =>
  routes.find((r) => r.path === path && r.method === RequestMethod.GET);

describe('CashDeskController — PR-FIN-PAYACCT-4D-REPORTS-1A drift-detail', () => {
  it('registers GET /cashboxes/:id/drift-detail', () => {
    const r = get('cashboxes/:id/drift-detail');
    expect(r).toBeDefined();
    expect(r!.name).toBe('cashboxDriftDetail');
  });

  it('binds :id through ParseUUIDPipe (defense-in-depth: bad slug → 400, never PG 500)', () => {
    const pipes = paramPipesFor('cashboxDriftDetail');
    expect(pipes.map((p: any) => p.name)).toContain('ParseUUIDPipe');
  });

  it('does not collide with the sibling `cashboxes/:id/movements-unified` route', () => {
    const drift   = get('cashboxes/:id/drift-detail');
    const unified = get('cashboxes/:id/movements-unified');
    expect(drift).toBeDefined();
    expect(unified).toBeDefined();
    expect(drift!.name).not.toBe(unified!.name);
    // Both end in a distinct static slug after `:id`, so route resolution
    // is unambiguous regardless of declaration order.
    expect(drift!.path).not.toBe(unified!.path);
  });
});
