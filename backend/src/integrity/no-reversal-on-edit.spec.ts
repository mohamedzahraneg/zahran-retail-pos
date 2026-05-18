/**
 * no-reversal-on-edit.spec.ts — Phase 2F universal guardrail
 * (PR-POS-EXPENSE-EDIT-CORRECTION-1)
 * ────────────────────────────────────────────────────────────────────
 *
 * Static-source guardrail that fails CI when normal edit/update paths
 * regress to reverse-and-repost behavior. Three layers of defense:
 *
 *   1. Approval flows we have already migrated to additive corrections
 *      (Phase 2E — `approveEditRequest` and its three new helpers) must
 *      be free of `reverseByReference`, `'reversal_*'` category
 *      strings, `'عكس:'` note prefixes, and direct `is_void = TRUE`
 *      writes against `journal_entries` / `cashbox_transactions`.
 *
 *   2. Every call site of `posting.reverseByReference(...)` must match
 *      the curated whitelist — i.e. live inside an explicit
 *      cancel/void/refund/return route, or inside a clearly tagged
 *      pending-phase legacy bridge. A NEW call site outside the
 *      whitelist fails the test with file:line.
 *
 *   3. The reversal category prefix `reversal_` and the Arabic
 *      `'عكس:'` note prefix are reserved for the engine's reversal
 *      pipeline (financial-engine.service.ts) and for explicit cancel
 *      routes. The test pins their locations so accidental copy-pastes
 *      surface immediately.
 *
 * The guardrail intentionally does NOT run the code — it inspects the
 * source. New violations show up loudly with the offending file:line.
 */

import * as fs from 'fs';
import * as path from 'path';

// `__dirname` at runtime resolves to backend/src/integrity. The repo
// root for source lookups is backend/, two directories up.
const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const SRC_ROOT = path.join(BACKEND_ROOT, 'src');

interface CallSite {
  file: string;
  line: number;
  enclosingFn: string | null;
}

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(SRC_ROOT, rel), 'utf8');
}

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    // PROVISIONING IS OUT OF SCOPE per ownership boundary — never
    // scan inside it.
    if (entry.name === 'provisioning') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTsFiles(full, out);
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.endsWith('.spec.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Best-effort enclosing-method finder: walk backwards from the call
 * site to the nearest line that looks like a class-method declaration.
 *
 * Heuristics combined to reject false positives (`if (…) {`,
 * `String(…)`, `new Foo(…)`):
 *   1. The line must START with optional access modifier, optional
 *      static, optional async, then an identifier followed by '('.
 *   2. The identifier must not be a control-flow keyword or a known
 *      built-in constructor / global.
 *   3. The line (after the param list) must end with '{' OR be
 *      followed within a small lookahead by a line that ends with
 *      '{' — distinguishing method headers from expression calls.
 */
function findEnclosingFn(lines: string[], idx: number): string | null {
  const methodHead =
    /^\s*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?([A-Za-z_]\w*)\s*\(/;
  const SKIP_IDENTS = new Set<string>([
    // Control-flow keywords
    'if',
    'for',
    'while',
    'switch',
    'catch',
    'return',
    'function',
    'do',
    'throw',
    'async',
    'await',
    'else',
    'new',
    'typeof',
    'in',
    // Common built-ins used as plain function calls
    'String',
    'Number',
    'Boolean',
    'Array',
    'Object',
    'Math',
    'Date',
    'JSON',
    'Set',
    'Map',
    'Promise',
    'Symbol',
    'BigInt',
    'Error',
    'RegExp',
    'parseInt',
    'parseFloat',
    'isNaN',
    'isFinite',
    'console',
    'super',
  ]);

  function looksLikeMethodHeader(start: number): boolean {
    // Scan a few lines forward to find an opening brace. Method
    // headers have `) ... {` somewhere within ~6 lines; expression
    // calls don't open a new block.
    for (let k = start; k < Math.min(start + 8, lines.length); k++) {
      const ln = lines[k];
      if (/\{\s*(?:\/\/.*)?$/.test(ln)) return true;
      // A semicolon ends the statement before any brace — definitely
      // a call expression, not a method header.
      if (/;\s*(?:\/\/.*)?$/.test(ln)) return false;
    }
    return false;
  }

  for (let i = idx; i >= 0; i--) {
    const m = methodHead.exec(lines[i]);
    if (!m) continue;
    if (SKIP_IDENTS.has(m[1])) continue;
    if (!looksLikeMethodHeader(i)) continue;
    return m[1];
  }
  return null;
}

function findCallSites(needle: RegExp): CallSite[] {
  const out: CallSite[] = [];
  for (const abs of walkTsFiles(SRC_ROOT)) {
    const text = fs.readFileSync(abs, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (!needle.test(ln)) continue;
      // Ignore lines that are pure comments (// …) or doc lines that
      // mention the symbol without invoking it.
      const trimmed = ln.replace(/^\s+/, '');
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
      out.push({
        file: path.relative(BACKEND_ROOT, abs),
        line: i + 1,
        enclosingFn: findEnclosingFn(lines, i),
      });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Layer 1 — Phase 2E migrated paths are clean.
// ─────────────────────────────────────────────────────────────────────
describe('Phase 2F · Layer 1 — Phase 2E migrated paths are clean', () => {
  const ACCOUNTING_SVC = readSrc('accounting/accounting.service.ts');
  const POSTING_SVC = readSrc('chart-of-accounts/posting.service.ts');

  // Extract the body of `approveEditRequest` by walking matching
  // braces from the opening `{`.
  function extractBody(source: string, header: RegExp): string {
    const headerMatch = header.exec(source);
    if (!headerMatch) throw new Error(`header not found: ${header}`);
    const start = source.indexOf('{', headerMatch.index);
    if (start < 0) throw new Error('opening brace not found');
    let depth = 0;
    for (let i = start; i < source.length; i++) {
      const c = source[i];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return source.slice(start, i + 1);
      }
    }
    throw new Error('balanced closing brace not found');
  }

  const APPROVE_BODY = extractBody(
    ACCOUNTING_SVC,
    /async\s+approveEditRequest\s*\(/,
  );
  const ORCH_BODY = extractBody(
    ACCOUNTING_SVC,
    /private\s+async\s+applyExpenseEditCorrections\s*\(/,
  );
  const HELPER_BODIES = [
    extractBody(POSTING_SVC, /async\s+postExpenseAmountDelta\s*\(/),
    extractBody(POSTING_SVC, /async\s+postExpenseReclassification\s*\(/),
    extractBody(POSTING_SVC, /async\s+postExpenseCashboxCorrection\s*\(/),
  ];

  function checkBody(body: string, label: string): void {
    test(`${label} does not call reverseByReference`, () => {
      expect(body).not.toMatch(/\breverseByReference\s*\(/);
    });
    test(`${label} does not emit category strings starting with reversal_`, () => {
      expect(body).not.toMatch(/['"]reversal_/);
    });
    test(`${label} does not emit notes/strings starting with 'عكس:'`, () => {
      expect(body).not.toMatch(/عكس:/);
    });
    test(`${label} does not flip journal_entries.is_void = TRUE`, () => {
      expect(body).not.toMatch(
        /UPDATE\s+journal_entries[\s\S]{0,300}is_void\s*=\s*TRUE/i,
      );
    });
    test(`${label} does not flip cashbox_transactions.is_void = TRUE`, () => {
      expect(body).not.toMatch(
        /UPDATE\s+cashbox_transactions[\s\S]{0,300}is_void\s*=\s*TRUE/i,
      );
    });
    test(`${label} does not rebase cashboxes.current_balance via void cleanup`, () => {
      expect(body).not.toMatch(
        /UPDATE\s+cashboxes[\s\S]{0,200}current_balance/i,
      );
    });
  }

  checkBody(APPROVE_BODY, 'approveEditRequest');
  checkBody(ORCH_BODY, 'applyExpenseEditCorrections');
  checkBody(HELPER_BODIES[0], 'postExpenseAmountDelta');
  checkBody(HELPER_BODIES[1], 'postExpenseReclassification');
  checkBody(HELPER_BODIES[2], 'postExpenseCashboxCorrection');
});

// ─────────────────────────────────────────────────────────────────────
// Layer 2 — Whitelist of `reverseByReference` call sites.
//
// Every entry below is an EXPLICIT cancel / void / refund / return /
// reverse route, OR a clearly-tagged pending-phase legacy bridge. A
// NEW call site that does not match the whitelist fails the test.
//
// Maintenance: when a new legitimate explicit-cancel route is added,
// extend the whitelist with the new enclosing method name and a brief
// note pointing to its permission gate or admin route. When a Phase
// 2A/2B/2C/2D PR removes a legacy bridge, delete the matching entry
// here.
// ─────────────────────────────────────────────────────────────────────
describe('Phase 2F · Layer 2 — reverseByReference call sites are whitelisted', () => {
  type WhitelistEntry = {
    file: string;
    enclosingFn: string;
    role:
      | 'explicit_cancel_void_refund_return'
      | 'engine_primitive_definition'
      | 'legacy_pending_phase_2a2b';
    note: string;
  };

  const WHITELIST: WhitelistEntry[] = [
    {
      file: 'src/chart-of-accounts/posting.service.ts',
      enclosingFn: 'reverseByReference',
      role: 'engine_primitive_definition',
      note: 'method definition — not a call',
    },
    {
      file: 'src/chart-of-accounts/posting.service.ts',
      enclosingFn: 'postInvoiceEdit',
      role: 'legacy_pending_phase_2a2b',
      note:
        'POS legacy edit fallback for line/qty/customer/negative-delta. ' +
        'Pending removal in Phase 2A/2B sales-edit migration.',
    },
    {
      file: 'src/chart-of-accounts/journal.service.ts',
      enclosingFn: 'void',
      role: 'explicit_cancel_void_refund_return',
      note: 'POST /accounting/entries/:id/void — admin-only manual void (method literally named `void`)',
    },
    {
      file: 'src/cash-desk/cash-desk.service.ts',
      enclosingFn: 'voidCustomerPayment',
      role: 'explicit_cancel_void_refund_return',
      note: 'POST /cash-desk/customer-payments/:id/void',
    },
    {
      file: 'src/cash-desk/cash-desk.service.ts',
      enclosingFn: 'voidSupplierPayment',
      role: 'explicit_cancel_void_refund_return',
      note: 'POST /cash-desk/supplier-payments/:id/void',
    },
    {
      file: 'src/pos/pos.service.ts',
      enclosingFn: 'voidInvoice',
      role: 'explicit_cancel_void_refund_return',
      note: 'POST /pos/invoices/:id/void',
    },
    {
      file: 'src/purchases/purchases.service.ts',
      enclosingFn: 'cancel',
      role: 'explicit_cancel_void_refund_return',
      note: 'PATCH /purchases/:id/cancel — perm purchases.cancel',
    },
    {
      file: 'src/purchases/purchases.service.ts',
      enclosingFn: 'edit',
      role: 'explicit_cancel_void_refund_return',
      note:
        'P2.3B safe replacement: received + unpaid purchase edit voids ' +
        'the old purchase and reverses its purchase JE before creating/' +
        'receiving the replacement.',
    },
    {
      file: 'src/purchases/purchases.service.ts',
      enclosingFn: 'cancelReturn',
      role: 'explicit_cancel_void_refund_return',
      note:
        'PATCH /purchases/returns/:id/cancel — perm purchases.return. ' +
        'P2.4A atomic cancel reverses stock + (supplier_ledger | cashbox) ' +
        'and calls reverseByReference on the purchase_return JE.',
    },
    {
      file: 'src/returns/returns.service.ts',
      enclosingFn: 'cancel',
      role: 'explicit_cancel_void_refund_return',
      note: 'POST /returns/:id/cancel — perm returns.cancel + confirmation token',
    },
    {
      file: 'src/returns/return-edit-requests.service.ts',
      enclosingFn: 'applyApprovedReturn',
      role: 'legacy_pending_phase_2a2b',
      note:
        'Return edit-request approval still uses reverse+repost when ' +
        'the underlying return was already refunded. Pending parallel ' +
        'migration to delta posting in a follow-up phase.',
    },
  ];

  it('every call site is on the whitelist', () => {
    const sites = findCallSites(/\breverseByReference\s*\(/);
    const unexpected: string[] = [];
    for (const s of sites) {
      const match = WHITELIST.find(
        (w) => w.file === s.file && w.enclosingFn === s.enclosingFn,
      );
      if (!match) {
        unexpected.push(
          `  - ${s.file}:${s.line} (in ${s.enclosingFn ?? '<top-level>'})`,
        );
      }
    }
    if (unexpected.length > 0) {
      throw new Error(
        'New reverseByReference call site(s) outside the explicit-cancel whitelist:\n' +
          unexpected.join('\n') +
          '\n' +
          'If the new call site IS an explicit cancel/void/refund route, extend ' +
          'the whitelist in this spec. Otherwise refactor the path to use ' +
          'additive corrections (see Phase 2E posting helpers).',
      );
    }
  });

  it('every whitelist entry resolves to a real source location', () => {
    const sites = findCallSites(/\breverseByReference\s*\(/);
    const siteKey = (s: CallSite) => `${s.file}::${s.enclosingFn}`;
    const liveKeys = new Set(sites.map(siteKey));
    const stale: string[] = [];
    for (const w of WHITELIST) {
      const key = `${w.file}::${w.enclosingFn}`;
      if (!liveKeys.has(key)) {
        stale.push(`  - ${key} (${w.role})`);
      }
    }
    if (stale.length > 0) {
      throw new Error(
        'Whitelist entries that no longer resolve to a real call site:\n' +
          stale.join('\n') +
          '\nRemove them from the whitelist to keep this guardrail honest.',
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Layer 3 — Arabic 'عكس:' note prefix appears only inside the engine
// reversal pipeline OR in the legacy POS post-invoice-edit bridge.
// New occurrences outside those contexts surface as a violation.
// ─────────────────────────────────────────────────────────────────────
describe("Phase 2F · Layer 3 — 'عكس:' prefix scope is limited", () => {
  it("'عكس:' / 'عكس قيد' literals appear only in known reversal-emitting files", () => {
    const sites: { file: string; line: number; ln: string }[] = [];
    for (const abs of walkTsFiles(SRC_ROOT)) {
      const text = fs.readFileSync(abs, 'utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        // Match the literal Arabic note prefix or the JE description
        // prefix used by reverseByReference.
        if (!/['"`](عكس\s*:|عكس قيد)/.test(ln)) continue;
        // Skip pure comment lines.
        const trimmed = ln.replace(/^\s+/, '');
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        sites.push({ file: path.relative(BACKEND_ROOT, abs), line: i + 1, ln });
      }
    }

    const ALLOWED_FILES = new Set<string>([
      // Engine reversal pipeline owns the prefix.
      'src/chart-of-accounts/posting.service.ts',
      'src/chart-of-accounts/financial-engine.service.ts',
      // Returns admin-cancel route description uses the prefix in a
      // user-facing reason string.
      'src/returns/returns.service.ts',
      // Cash-desk's GL drift cleanup helper logs the prefix in
      // historical-repair notes (admin-only audit endpoint).
      'src/cash-desk/cash-desk.service.ts',
      'src/cash-desk/cashbox-gl-drift.helper.ts',
    ]);

    const unexpected = sites.filter((s) => !ALLOWED_FILES.has(s.file));
    if (unexpected.length > 0) {
      const detail = unexpected
        .map((s) => `  - ${s.file}:${s.line}  ${s.ln.trim().slice(0, 120)}`)
        .join('\n');
      throw new Error(
        "New 'عكس:' literal(s) appeared outside the allowed reversal-emitting files:\n" +
          detail +
          '\nNormal edits must not emit this prefix.',
      );
    }
  });
});
