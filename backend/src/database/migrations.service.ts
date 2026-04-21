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
@Injectable()
export class MigrationsService implements OnModuleInit {
  private readonly logger = new Logger('Migrations');

  constructor(private readonly ds: DataSource) {}

  async onModuleInit() {
    try {
      await this.ensureBookkeeping();
      await this.seedLegacyBaseline();
      await this.applyPending();
    } catch (err: any) {
      this.logger.error(
        `startup migration runner failed: ${err?.message ?? err}`,
      );
      // Never block the app from starting — prefer a degraded API to a
      // hard crash loop. Operators see the error in logs and can fix it.
    }
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
    const dir = this.migrationsDir();
    if (!fs.existsSync(dir)) {
      this.logger.warn(`migrations dir not found: ${dir} — skipping`);
      return;
    }
    const applied = new Set<string>(
      (
        await this.ds.query(`SELECT filename FROM schema_migrations`)
      ).map((r: any) => r.filename),
    );
    const files = this.listMigrationFiles();
    const pending = files.filter((f) => !applied.has(f));
    if (!pending.length) {
      this.logger.log(`schema up to date (${files.length} files tracked)`);
      return;
    }
    this.logger.log(`applying ${pending.length} pending migration(s)...`);
    for (const f of pending) {
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
        this.logger.log(`  ✓ ${f}`);
      } catch (err: any) {
        this.logger.error(`  ✗ ${f} — ${err?.message ?? err}`);
        throw err;
      }
    }
    this.logger.log(`migrations complete ✓`);
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
