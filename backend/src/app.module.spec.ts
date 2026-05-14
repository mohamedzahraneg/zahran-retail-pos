/**
 * PR-FE-C-POLISH-4 — AppModule DI compile guard.
 *
 * Whole-app companion to the per-module ExpenseAllocationsModule guard
 * shipped in PR-PHASE2-B4 v2 (see `expense-allocations/expense-
 * allocations.module.spec.ts`).
 *
 * Regression target — the B4 v1 production crash class:
 *   A controller was decorated with `@UseInterceptors(IdempotencyInterceptor)`,
 *   but `IdempotencyInterceptor`'s constructor dependency
 *   (`IdempotencyCacheService`) was not a provider of the feature module.
 *   TypeScript compiled, every service-level spec passed (those mock
 *   `DataSource` and never load the Nest DI graph), `npm run build`
 *   emitted the dist cleanly — and then `InstanceLoader` threw at app
 *   bootstrap.  The api container entered a restart loop in production.
 *
 *   The per-module guard catches this for ExpenseAllocationsModule.
 *   This file catches it for ANY feature module in the AppModule
 *   import tree.  If a new module is added (or an existing one
 *   modified) and its DI graph has a missing provider / circular
 *   dependency / wrong injection token / unresolved `@UseGuards` or
 *   `@UseInterceptors` reference, `Test.createTestingModule(...).
 *   compile()` throws the exact same error Nest would throw at boot,
 *   and this spec fails in CI — before merge, not in prod.
 *
 * Hard scope:
 *   * Test-only.  Zero runtime code paths touched.
 *   * No real DB / Redis / MinIO / network connection.  We override
 *     the two services with lifecycle hooks that touch external
 *     resources (`MigrationsService`, `IdempotencyCacheService`) so
 *     no IO fires even if Nest unexpectedly init's the module.
 *   * We never call `.init()` — only `.compile()`.  Nest's lifecycle
 *     hooks (`onModuleInit`, `onApplicationBootstrap`) deliberately
 *     do not fire.  Hooks are deploy-time concerns, caught by the
 *     existing smoke flow.
 *   * Env defaults are `??=` so a real CI env (if it ever exists)
 *     wins over our fakes.
 *
 * What this catches:
 *   * Missing provider for a `@UseInterceptors` / `@UseGuards` /
 *     `@Inject` reference (the B4 v1 crash class).
 *   * Circular module dependencies.
 *   * Multi-token mistakes (e.g. new `APP_GUARD` whose constructor
 *     args aren't resolvable).
 *   * Module-export omissions.
 *   * Wrong injection tokens.
 *   * "Forgot to add the new feature module to AppModule" type errors
 *     that surface as unresolved deps elsewhere.
 *
 * What this deliberately does NOT catch:
 *   * Runtime `onModuleInit` / `onApplicationBootstrap` failures (we
 *     stub the two known ones; we never `.init()`).
 *   * TypeORM schema mismatches.  DB layer is mocked.
 *   * Business-logic bugs (existing service specs cover that).
 *   * Authorization decisions (guards short-circuit to allow).
 *   * HTTP contract / response shapes (no requests made).
 *
 * In short: this is the *wiring* layer, not the *behavior* layer.
 */

// ─── Env defaults ──────────────────────────────────────────────────
//
// Set BEFORE any imports so ConfigModule + DatabaseModule's
// TypeOrmModule.forRootAsync factory see them.  `??=` keeps real CI
// env (if present) winning over these fakes.

process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??=
  'postgres://test:test@127.0.0.1:5432/test_ignored';
process.env.JWT_SECRET ??= 'test-secret-please-ignore';
process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
process.env.UPLOAD_DIR ??= '.uploads-test-ignored';

import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { DataSource } from 'typeorm';

import { AppModule } from './app.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { IdempotencyCacheService } from './common/cache/idempotency-cache.service';
import { MigrationsService } from './database/migrations.service';

import { ExpenseAllocationsController } from './expense-allocations/expense-allocations.controller';
import { PosController } from './pos/pos.controller';
import { AccountingController } from './accounting/accounting.controller';
import { ReturnsController } from './returns/returns.controller';

// Fake DataSource shape that satisfies any service constructed during
// compile.  The two methods most consumers reach for are `query` and
// `transaction`.  The other fields exist for two reasons:
//
//   * `entityMetadatas` + `options.type` + `getRepository` — needed by
//     `TypeOrmModule.forFeature([Entity])`, whose repository providers
//     call `dataSource.entityMetadatas.find(...)` and
//     `dataSource.options.type` during instantiation (see
//     `node_modules/@nestjs/typeorm/dist/typeorm.providers.js`).
//     Empty `entityMetadatas` + `'postgres'` type + a fake repo
//     factory keeps those provider factories happy without ever
//     opening a connection.
//   * `manager.transaction`, `isInitialized`, `initialize`, `destroy`
//     — defensive: services that probe these at construction time
//     don't crash.
const makeFakeDataSource = () => ({
  query: jest.fn().mockResolvedValue([]),
  transaction: jest
    .fn()
    .mockImplementation(async (cb: (em: { query: jest.Mock }) => unknown) =>
      cb({ query: jest.fn().mockResolvedValue([]) }),
    ),
  manager: {
    transaction: jest.fn().mockResolvedValue(undefined),
  },
  initialize: jest.fn().mockResolvedValue(undefined),
  destroy: jest.fn().mockResolvedValue(undefined),
  isInitialized: true,
  // Empty metadata + postgres type — the `getRepository` path inside
  // TypeOrm's per-entity provider factory takes us straight to the
  // stub below without trying to dereference real entity metadata.
  entityMetadatas: [] as unknown[],
  options: { type: 'postgres' as const },
  getRepository: jest.fn().mockReturnValue({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
    createQueryBuilder: jest.fn(),
  }),
  getTreeRepository: jest.fn().mockReturnValue({}),
  getMongoRepository: jest.fn().mockReturnValue({}),
});

const makeFakeIdempotencyCache = () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  invalidate: jest.fn().mockResolvedValue(undefined),
  isAvailable: jest.fn().mockReturnValue(false),
  onModuleInit: jest.fn().mockResolvedValue(undefined),
  onModuleDestroy: jest.fn().mockResolvedValue(undefined),
});

describe('AppModule — DI compile guard (PR-FE-C-POLISH-4)', () => {
  let mod: TestingModule;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [AppModule],
    })
      // DataSource: replace the TypeOrmModule-registered one with a
      // fully fake instance.  `.compile()` will still run TypeOrmModule's
      // forRootAsync factory, but the resulting DataSource is thrown
      // away in favour of this override — and crucially we never call
      // `.init()`, so the real DataSource's `initialize()` (which would
      // open a real Postgres connection) is never triggered.
      .overrideProvider(DataSource)
      .useValue(makeFakeDataSource())
      // MigrationsService: real one issues SELECT queries against the
      // live database in `onModuleInit`.  We don't call `.init()`, so
      // the hook never fires anyway — but overriding the provider
      // means even a stray construction-time `query` doesn't try to
      // hit a real DB.
      .overrideProvider(MigrationsService)
      .useValue({ onModuleInit: jest.fn().mockResolvedValue(undefined) })
      // IdempotencyCacheService: real one opens an `ioredis` client in
      // `onModuleInit`.  Same reasoning as MigrationsService.  We
      // expose `isAvailable: () => false` to match the production
      // contract so any consumer that reads it sees a "no-cache" state.
      .overrideProvider(IdempotencyCacheService)
      .useValue(makeFakeIdempotencyCache())
      // Global APP_GUARD chain — short-circuit each to auto-allow so
      // request-time auth wiring doesn't matter (we make no requests
      // in this spec).  Mirrors the B4 v2 module guard pattern.
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionsGuard)
      .useValue({ canActivate: () => true })
      .compile();
  }, 30_000);

  afterAll(async () => {
    if (mod) await mod.close();
  });

  it('compiles the full DI graph without throwing', () => {
    // Reaching this assertion means `Test.createTestingModule(...)
    // .compile()` in `beforeAll` resolved every provider, controller,
    // guard, and interceptor reachable from AppModule's import tree.
    // The B4 v1 class of bug would have thrown in `beforeAll` with
    // "Nest can't resolve dependencies of <X>".
    expect(mod).toBeDefined();
  });

  // Spot-checks — turn an opaque "compile failed" into "the module
  // that broke is X".  These four controllers are representative of
  // the riskiest interceptor/guard surfaces and the original B4 v1
  // regression target.

  it('resolves ExpenseAllocationsController (B4 v1 regression target)', () => {
    expect(mod.get(ExpenseAllocationsController, { strict: false })).toBeDefined();
  });

  it('resolves PosController', () => {
    expect(mod.get(PosController, { strict: false })).toBeDefined();
  });

  it('resolves AccountingController', () => {
    expect(mod.get(AccountingController, { strict: false })).toBeDefined();
  });

  it('resolves ReturnsController', () => {
    expect(mod.get(ReturnsController, { strict: false })).toBeDefined();
  });
});
