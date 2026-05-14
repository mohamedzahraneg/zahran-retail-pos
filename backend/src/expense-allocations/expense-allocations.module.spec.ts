import { Global, Module } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { ExpenseAllocationsModule } from './expense-allocations.module';
import { ExpenseAllocationsController } from './expense-allocations.controller';
import { ExpenseAllocationsReportsController } from './expense-allocations-reports.controller';
import { ExpenseAllocationsService } from './expense-allocations.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';

/**
 * Local @Global stub that mirrors how production's DatabaseModule
 * exposes the DataSource provider — so ExpenseAllocationsModule (which
 * never imports DatabaseModule directly) can resolve DataSource the
 * same way it does in production.
 */
@Global()
@Module({
  providers: [
    {
      provide: DataSource,
      useValue: {
        query: jest.fn().mockResolvedValue([]),
        transaction: jest.fn(),
      },
    },
  ],
  exports: [DataSource],
})
class StubDatabaseModule {}

/**
 * PR-PHASE2-B4 v2 — module DI compile guard.
 *
 * This is the regression test for the v1 bootstrap crash: a controller
 * was decorated with @UseInterceptors(IdempotencyInterceptor), but
 * IdempotencyInterceptor's constructor dependency (IdempotencyCacheService)
 * was not a provider of ExpenseAllocationsModule.  TypeScript compiled
 * cleanly, all service-spec tests passed (they mock DataSource and never
 * load the Nest DI graph), and `npm run build` happily emitted the dist
 * — but Nest's InstanceLoader threw at startup and the api container
 * entered a restart loop.
 *
 * This spec compiles the actual module via @nestjs/testing.  If a
 * controller references a class via @UseInterceptors / @UseGuards / etc.
 * whose constructor dependencies aren't reachable from this module's
 * injection scope, Test.createTestingModule(...).compile() throws the
 * exact same error Nest would throw at app boot.  Pre-push gate.
 */
describe('ExpenseAllocationsModule — DI graph compile (PR-PHASE2-B4 v2 regression guard)', () => {
  let mod: TestingModule;

  beforeAll(async () => {
    // Pair the StubDatabaseModule with ExpenseAllocationsModule.  The
    // stub is @Global, so it satisfies the DataSource dependency in
    // ExpenseAllocationsService the same way production's DatabaseModule
    // does — without needing TypeOrmModule.forRoot config.
    mod = await Test.createTestingModule({
      imports: [StubDatabaseModule, ExpenseAllocationsModule],
    })
      // Class-level @UseGuards on the controllers brings in three guards
      // whose constructors depend on Reflector + the global JWT config.
      // For a DI-only compile we override each to auto-allow.
      .overrideGuard(JwtAuthGuard).useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard).useValue({ canActivate: () => true })
      .overrideGuard(PermissionsGuard).useValue({ canActivate: () => true })
      .compile();
  });

  afterAll(async () => {
    if (mod) await mod.close();
  });

  it('compiles the module and resolves every controller', () => {
    expect(mod.get(ExpenseAllocationsController)).toBeDefined();
    expect(mod.get(ExpenseAllocationsReportsController)).toBeDefined();
  });

  it('resolves the service provider', () => {
    expect(mod.get(ExpenseAllocationsService)).toBeDefined();
  });

  it('does NOT have IdempotencyInterceptor wired into this module (v1 crash regression guard)', () => {
    // If a route still references @UseInterceptors(IdempotencyInterceptor),
    // Test.createTestingModule(...).compile() would have thrown during
    // beforeAll with "Nest can't resolve dependencies of the
    // IdempotencyInterceptor".  We landed past beforeAll => safe.  This
    // assertion is documentation; the real guard is beforeAll succeeding.
    expect(mod).toBeDefined();
  });
});
