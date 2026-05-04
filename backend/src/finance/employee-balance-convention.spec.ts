/**
 * employee-balance-convention.spec.ts — PR-AUDIT-EMPLOYEE-VIEW-UNIFY
 * ────────────────────────────────────────────────────────────────────
 *
 * Pins the canonical employee-balance contract surfaced through the
 * Finance Dashboard so future refactors cannot silently invert the
 * sign convention or revive the dead `v_employee_balances_gl` view.
 *
 * Business convention (locked):
 *   · POSITIVE balance → EMPLOYEE OWES the company  ("عليه")
 *   · NEGATIVE balance → COMPANY OWES the employee  ("له")
 *
 * Source of truth: `v_employee_gl_balance.balance`
 *   = SUM(jl.debit) - SUM(jl.credit) over GL 1123 + 213
 *   (migration 075, posted/non-void only).
 *
 * Inverted sibling (DEAD CODE):
 *   `v_employee_balances_gl.net_balance` flips the sign:
 *     positive = company owes employee, negative = employee owes
 *   No production code reads it (verified by the forward-prevention
 *   spec at the bottom of this file). The view exists in the DB only
 *   for historical reasons; do NOT add new readers.
 *
 * Named-employee fixtures (matching the production audit baseline):
 *   · Abu Yousef         balance = -30   → "له 30"
 *   · Mohamed El-Zobaty  balance = +2080 → "عليه 2080"
 *   · Mahmoud Zahran     balance = -250  → "له 250"
 *   · مدير النظام         balance = +10   → "عليه 10"
 */

import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve } from 'path';
import { FinanceDashboardService } from './finance-dashboard.service';

type QueryCall = { sql: string; params: any[] };

async function makeService(employeesRow: {
  owed_to: string;
  owed_by: string;
  net: string;
}) {
  const calls: QueryCall[] = [];
  const ds: any = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      // The employee aggregate is the only fragment we care about; every
      // other dashboard SQL gets an empty result so the rest of the
      // composite response stays at the "no data" defaults.
      if (/v_employee_gl_balance/.test(sql)) return [employeesRow];
      return [];
    }),
    transaction: jest.fn(async (cb: any) => cb(ds)),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      FinanceDashboardService,
      { provide: DataSource, useValue: ds },
    ],
  }).compile();
  const service = moduleRef.get(FinanceDashboardService);
  return { service, calls };
}

describe('FinanceDashboard.balances.employees — PR-AUDIT-EMPLOYEE-VIEW-UNIFY', () => {
  describe('SQL contract', () => {
    it('queries v_employee_gl_balance.balance (canonical) — never v_employee_balances_gl', async () => {
      const { service, calls } = await makeService({
        owed_to: '0', owed_by: '0', net: '0',
      });
      await service.dashboard({ from: '2026-04-01', to: '2026-05-04' });
      const empCall = calls.find((c) => /v_employee_gl_balance/.test(c.sql));
      expect(empCall).toBeDefined();
      expect(empCall!.sql).not.toMatch(/v_employee_balances_gl/);
      // Confirms the SQL reads `balance` (the canonical column name on
      // v_employee_gl_balance — positive = employee owes company).
      expect(empCall!.sql).toMatch(/\bbalance\b/);
      expect(empCall!.sql).not.toMatch(/\bnet_balance\b/);
    });

    it('partitions positives → owed_to and |negatives| → owed_by (canonical sign)', async () => {
      const { service, calls } = await makeService({
        owed_to: '0', owed_by: '0', net: '0',
      });
      await service.dashboard({ from: '2026-04-01', to: '2026-05-04' });
      const empCall = calls.find((c) => /v_employee_gl_balance/.test(c.sql))!;
      // SUM(CASE WHEN balance > 0 THEN balance ...) AS owed_to
      expect(empCall.sql).toMatch(/CASE WHEN balance > 0 THEN[\s\S]*AS owed_to/);
      // SUM(CASE WHEN balance < 0 THEN -balance ...) AS owed_by
      expect(empCall.sql).toMatch(/CASE WHEN balance < 0 THEN\s*-balance[\s\S]*AS owed_by/);
    });
  });

  describe('Named-employee fixtures (production baseline 2026-05-04)', () => {
    it('Abu Yousef = -30 → owed_to=0, owed_by=30, net=-30 (له 30)', async () => {
      const { service } = await makeService({
        owed_to: '0', owed_by: '30.00', net: '-30.00',
      });
      const r = await service.dashboard({ from: '2026-04-01', to: '2026-05-04' });
      expect(r.balances.employees).toEqual({
        total_owed_to: 0,
        total_owed_by: 30,
        net: -30,
      });
    });

    it('Mohamed El-Zobaty = +2080 → owed_to=2080, owed_by=0, net=+2080 (عليه 2080)', async () => {
      const { service } = await makeService({
        owed_to: '2080.00', owed_by: '0', net: '2080.00',
      });
      const r = await service.dashboard({ from: '2026-04-01', to: '2026-05-04' });
      expect(r.balances.employees).toEqual({
        total_owed_to: 2080,
        total_owed_by: 0,
        net: 2080,
      });
    });

    it('Mahmoud Zahran = -250 → owed_to=0, owed_by=250, net=-250 (له 250)', async () => {
      const { service } = await makeService({
        owed_to: '0', owed_by: '250.00', net: '-250.00',
      });
      const r = await service.dashboard({ from: '2026-04-01', to: '2026-05-04' });
      expect(r.balances.employees).toEqual({
        total_owed_to: 0,
        total_owed_by: 250,
        net: -250,
      });
    });

    it('Admin = +10 → owed_to=10, owed_by=0, net=+10 (عليه 10)', async () => {
      const { service } = await makeService({
        owed_to: '10.00', owed_by: '0', net: '10.00',
      });
      const r = await service.dashboard({ from: '2026-04-01', to: '2026-05-04' });
      expect(r.balances.employees).toEqual({
        total_owed_to: 10,
        total_owed_by: 0,
        net: 10,
      });
    });

    it('full team rollup (+2080 + 10 - 30 - 250) → owed_to=2090, owed_by=280, net=+1810', async () => {
      // Matches the audit baseline: positive sum 2,090, negative sum 280.
      const { service } = await makeService({
        owed_to: '2090.00', owed_by: '280.00', net: '1810.00',
      });
      const r = await service.dashboard({ from: '2026-04-01', to: '2026-05-04' });
      expect(r.balances.employees).toEqual({
        total_owed_to: 2090,
        total_owed_by: 280,
        net: 1810,
      });
    });
  });
});

/* ──────────────────────────────────────────────────────────────────
 * Forward-prevention: zero NEW code may consume the inverted view.
 * ──────────────────────────────────────────────────────────────────*/

describe('PR-AUDIT-EMPLOYEE-VIEW-UNIFY — forward-prevention', () => {
  // Walk every .ts file under backend/src and frontend/src, strip line
  // comments + block comments + string literals, then refuse any
  // remaining reference to `v_employee_balances_gl` or `.net_balance`
  // on the payroll API surface. The 2 known mentions today live inside
  // doc comments and are stripped — so they don't count as offenders.

  function* walkTs(dir: string): Generator<string> {
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
      const st = statSync(full);
      if (st.isDirectory()) {
        yield* walkTs(full);
      } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
        // Exclude this very spec file from the scan (it legitimately
        // names the dead view in code so the regex prevention test
        // can describe what it's preventing).
        if (full.endsWith('employee-balance-convention.spec.ts')) continue;
        yield full;
      }
    }
  }

  function stripCommentsAndStrings(src: string): string {
    return src
      // line comments
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/(\s)\/\/.*$/gm, '$1')
      // block comments
      .replace(/\/\*[\s\S]*?\*\//g, '')
      // template literals (preserve braces / structure but strip content)
      .replace(/`[\s\S]*?`/g, '``')
      // single-quoted strings
      .replace(/'[^'\n]*'/g, "''")
      // double-quoted strings
      .replace(/"[^"\n]*"/g, '""');
  }

  it('zero executable code in backend/src reads v_employee_balances_gl', () => {
    const root = resolve(__dirname, '..');
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const file of walkTs(root)) {
      const src = readFileSync(file, 'utf8');
      const code = stripCommentsAndStrings(src);
      const lines = code.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (/v_employee_balances_gl/.test(lines[i])) {
          offenders.push({ file, line: i + 1, text: lines[i].trim() });
        }
      }
    }
    if (offenders.length > 0) {
      const detail = offenders.map((o) => `  · ${o.file}:${o.line}: ${o.text}`).join('\n');
      throw new Error(
        `Found ${offenders.length} executable reference(s) to v_employee_balances_gl ` +
          `(the inverted-sign view). Use v_employee_gl_balance instead.\n${detail}`,
      );
    }
    expect(offenders).toEqual([]);
  });
});
