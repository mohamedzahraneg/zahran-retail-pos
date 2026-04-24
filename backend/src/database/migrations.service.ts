import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

/**
 * Lightweight startup migration runner.
 *
 * On boot we scan `database/migrations/*.sql`, compare against a bookkeeping
 * table (`schema_migrations`), and apply anything missing. Each file runs
 * inside its own transaction, so a broken migration leaves the DB exactly
 * where it was before. Idempotent statements (`CREATE OR REPLACE VIEW`,
 * `DROP IF EXISTS`, etc.) can be safely re-executed even if they were
 * already applied by the CI baseline.
 *
 * We also detect pre-existing installations: if the first known tables are
 * already present we mark every numbered migration ≤ 045 as "applied"
 * without running them — the legacy server was bootstrapped from
 * schema_combined.sql and shouldn't try to re-install them. Anything after
 * 045 is new and must run.
 */
/** Marker used to distinguish a wrong-database error from a migration error. */
const FATAL_DB_ERROR = 'FatalDatabaseSanityError';

/** Sentinel migration that MUST already be applied on a production DB. */
const PRODUCTION_SENTINEL_MIGRATION = '071_employee_gl_dimension.sql';

@Injectable()
export class MigrationsService implements OnModuleInit {
  private readonly logger = new Logger('Migrations');

  constructor(private readonly ds: DataSource) {}

  async onModuleInit() {
    // Sanity check runs FIRST and is deliberately NOT inside the try/catch
    // below — a wrong-database error must crash the boot, not be swallowed.
    await this.verifyProductionDatabase();

    try {
      await this.ensureBookkeeping();
      await this.seedLegacyBaseline();
      await this.applyPending();
    } catch (err: any) {
      this.logger.error(
        `startup migration runner failed: ${err?.message ?? err}`,
      );
      // Never block the app from starting on a per-migration error — prefer
      // a degraded API to a hard crash loop. Operators see the error in
      // logs and can fix it.
    }
  }

  /**
   * Confirm we are connected to the expected production Postgres BEFORE we
   * run any migrations. In production (NODE_ENV=production) we refuse to
   * boot if any of these are false:
   *   1. current_database() = 'postgres'            (Supabase default)
   *   2. server_version_num >= 170000               (Supabase runs PG 17+)
   *   3. schema_migrations table exists             (bookkeeping seeded)
   *   4. sentinel migration row is present         (we are on the right DB)
   *
   * Outside production this is a no-op — local docker Postgres has a
   * different database name and lower PG version, and we do not want to
   * block dev startup.
   */
  private async verifyProductionDatabase(): Promise<void> {
    const env = (process.env.NODE_ENV || 'development').toLowerCase();
    if (env !== 'production') {
      this.logger.log(`DB sanity check skipped (NODE_ENV=${env})`);
      return;
    }

    let meta: { db_name: string; pg_version: number; has_bookkeeping: boolean };
    try {
      const rows = await this.ds.query(`
        SELECT current_database()                      AS db_name,
               current_setting('server_version_num')::int AS pg_version,
               EXISTS (
                 SELECT 1 FROM information_schema.tables
                  WHERE table_schema = 'public'
                    AND table_name = 'schema_migrations'
               )                                       AS has_bookkeeping
      `);
      meta = rows[0];
    } catch (err: any) {
      this.fatalDb(
        `could not query sanity metadata from the database: ${err?.message ?? err}`,
      );
    }

    if (meta.db_name !== 'postgres') {
      this.fatalDb(
        `connected to database "${meta.db_name}" but production expects "postgres" (the Supabase default). ` +
          `This usually means DATABASE_URL points at a docker Postgres by mistake. ` +
          `Set DATABASE_URL to the Supabase pooler DSN (see .env.production.example).`,
      );
    }

    if (meta.pg_version < 170000) {
      this.fatalDb(
        `connected to PostgreSQL server_version_num=${meta.pg_version} but production requires 17+ (Supabase). ` +
          `Refusing to boot against what looks like a local Postgres 15 container.`,
      );
    }

    if (!meta.has_bookkeeping) {
      this.fatalDb(
        `schema_migrations table does not exist on this database. ` +
          `A production Supabase DB is bootstrapped with this table; its absence means we are on an empty/wrong DB.`,
      );
    }

    const sentinel: Array<{ filename: string }> = await this.ds.query(
      `SELECT filename FROM public.schema_migrations WHERE filename = $1`,
      [PRODUCTION_SENTINEL_MIGRATION],
    );
    if (sentinel.length === 0) {
      this.fatalDb(
        `sentinel migration "${PRODUCTION_SENTINEL_MIGRATION}" is not recorded in schema_migrations. ` +
          `This means the DB has not been brought to the production baseline — probably a wrong DATABASE_URL.`,
      );
    }

    this.logger.log(
      `✓ production DB sanity verified (db=${meta.db_name}, pg=${meta.pg_version}, sentinel present)`,
    );
  }

  /** Throw a fatal, non-retriable error that propagates out of onModuleInit. */
  private fatalDb(detail: string): never {
    const banner =
      '[FATAL] Wrong database. Refusing to start the API in production. ' +
      detail;
    this.logger.error(banner);
    const err: any = new Error(banner);
    err.name = FATAL_DB_ERROR;
    throw err;
  }

  /** Create the schema_migrations table if it doesn't exist yet. */
  private async ensureBookkeeping() {
    await this.ds.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    text PRIMARY KEY,
        checksum    text        NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  /**
   * Legacy servers (created from schema_combined.sql before the runner
   * existed) already have every table up to migration 045. Mark them
   * "applied" so the runner doesn't try to re-run them.
   */
  private async seedLegacyBaseline() {
    const [{ count }] = await this.ds.query(
      `SELECT COUNT(*)::int AS count FROM schema_migrations`,
    );
    if (count > 0) return; // already tracked
    const [{ products_exists }] = await this.ds.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'products'
      ) AS products_exists
    `);
    if (!products_exists) return; // fresh DB — runner will apply from 001
    // Mark every historic migration ≤ 045 as already applied.
    const files = this.listMigrationFiles();
    for (const f of files) {
      const num = this.numberOf(f);
      if (num != null && num <= 45) {
        await this.ds.query(
          `INSERT INTO schema_migrations (filename, checksum, applied_at)
           VALUES ($1, 'legacy-baseline', now())
           ON CONFLICT (filename) DO NOTHING`,
          [f],
        );
      }
    }
    this.logger.log(`seeded legacy baseline (≤ 045) for existing database`);
  }

  /** Run anything in database/migrations/ that hasn't been applied. */
  private async applyPending() {
    return this.runPending();
  }

  /**
   * Public wrapper — lets a manual admin endpoint trigger the
   * migration runner at any time. Returns a per-file status so the
   * UI can show exactly what happened.
   *
   * Unlike the startup run, this keeps going after an individual
   * failure so one bad file doesn't block the rest.
   */
  async runPending(): Promise<{
    dir: string;
    applied: string[];
    failed: Array<{ file: string; error: string }>;
    already: string[];
  }> {
    const dir = this.migrationsDir();
    const out = {
      dir,
      applied: [] as string[],
      failed: [] as Array<{ file: string; error: string }>,
      already: [] as string[],
    };
    if (!fs.existsSync(dir)) {
      this.logger.warn(`migrations dir not found: ${dir} — skipping`);
      return out;
    }
    await this.ensureBookkeeping();
    const appliedSet = new Set<string>(
      (
        await this.ds.query(`SELECT filename FROM schema_migrations`)
      ).map((r: any) => r.filename),
    );
    const files = this.listMigrationFiles();
    for (const f of files) {
      if (appliedSet.has(f)) {
        out.already.push(f);
        continue;
      }
      const full = path.join(dir, f);
      const sql = fs.readFileSync(full, 'utf8');
      const checksum = crypto.createHash('sha1').update(sql).digest('hex');
      try {
        await this.ds.transaction(async (em) => {
          await em.query(sql);
          await em.query(
            `INSERT INTO schema_migrations (filename, checksum)
             VALUES ($1, $2)
             ON CONFLICT (filename) DO NOTHING`,
            [f, checksum],
          );
        });
        out.applied.push(f);
        this.logger.log(`  ✓ ${f}`);
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        out.failed.push({ file: f, error: msg });
        this.logger.error(`  ✗ ${f} — ${msg}`);
        // Keep going — one bad file shouldn't block later ones on a
        // manual run.
      }
    }
    this.logger.log(
      `migrations: ${out.applied.length} applied · ${out.failed.length} failed · ${out.already.length} already done`,
    );
    return out;
  }

  /** Status report — what the runner sees without running anything. */
  async status() {
    await this.ensureBookkeeping();
    const appliedRows = await this.ds.query(
      `SELECT filename, applied_at FROM schema_migrations ORDER BY filename`,
    );
    const files = this.listMigrationFiles();
    const applied = new Set(appliedRows.map((r: any) => r.filename));
    const pending = files.filter((f) => !applied.has(f));
    return {
      dir: this.migrationsDir(),
      total_files: files.length,
      applied: appliedRows,
      pending,
    };
  }

  private migrationsDir() {
    // Walk up from dist/ or src/ to the project root and look under
    // database/migrations. Covers both `npm run start` and Docker.
    const cwd = process.cwd();
    const candidates = [
      path.resolve(cwd, 'database/migrations'),
      path.resolve(cwd, '../database/migrations'),
      path.resolve(cwd, '../../database/migrations'),
      path.resolve(__dirname, '../../../database/migrations'),
      path.resolve(__dirname, '../../../../database/migrations'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return candidates[0];
  }

  private listMigrationFiles(): string[] {
    const dir = this.migrationsDir();
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort(); // numeric prefix → lexicographic sort is correct
  }

  private numberOf(filename: string): number | null {
    const m = filename.match(/^(\d+)/);
    return m ? Number(m[1]) : null;
  }
}
