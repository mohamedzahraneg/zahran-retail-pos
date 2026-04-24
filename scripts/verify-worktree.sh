#!/usr/bin/env bash
# =============================================================================
#  verify-worktree.sh — canonical-path guard
#  Invariants enforced (every rule has a matching entry in docs/WORKFLOW.md):
#    1. we are at CANONICAL_PROJECT_PATH on this machine
#    2. git remote matches the canonical GitHub repo
#    3. origin is reachable (fetch works)
#    4. branch is `main` or an approved prefix (main, fix-*, feat-*, claude/*, hotfix-*)
#    5. HEAD is not detached
#    6. working tree has no unexpected uncommitted changes
#    7. docker-compose.yml carries the `${DATABASE_URL:?...}` guard (no silent docker-db fallback)
#    8. scripts/deploy.sh exists
#  Exits 0 on PASS, non-zero with a clear message on any failure.
# =============================================================================
set -euo pipefail

CANONICAL_PROJECT_PATH="/Users/mohamedzahran/Documents/Claude/Projects/Zahran"
CANONICAL_REMOTE_URL="https://github.com/mohamedzahraneg/zahran-retail-pos.git"
ALLOWED_BRANCH_REGEX='^(main|fix-.+|feat-.+|hotfix-.+|chore-.+|claude/.+)$'

# Accept `--allow-dirty` for explicit dirty-tree work (e.g. mid-development).
ALLOW_DIRTY=0
if [[ "${1:-}" == "--allow-dirty" ]]; then
  ALLOW_DIRTY=1
  shift || true
fi

fail() { echo "❌ verify-worktree: $*" >&2; exit 1; }
ok()   { echo "✅ $*"; }

# ── Rule 1 — canonical path ────────────────────────────────────────────────
cwd_real=$(cd "$(pwd)" && pwd -P)
canonical_real=$(cd "$CANONICAL_PROJECT_PATH" && pwd -P 2>/dev/null || echo "$CANONICAL_PROJECT_PATH")
if [[ "$cwd_real" != "$canonical_real" ]]; then
  fail "wrong path — expected $canonical_real, got $cwd_real
       (worktrees in .claude/worktrees/* are for temporary editing only; run deploys
        and verifications from the canonical path)"
fi
ok "path = $cwd_real"

# ── Rule 2 — remote URL ────────────────────────────────────────────────────
actual_remote=$(git config --get remote.origin.url || echo '')
if [[ "$actual_remote" != "$CANONICAL_REMOTE_URL" ]]; then
  fail "wrong remote — expected $CANONICAL_REMOTE_URL, got '$actual_remote'"
fi
ok "remote = $actual_remote"

# ── Rule 3 — origin reachable ──────────────────────────────────────────────
if ! git fetch origin --quiet 2>/dev/null; then
  fail "cannot fetch origin — check network / GitHub auth"
fi
ok "origin reachable"

# ── Rule 4/5 — branch sanity + not detached ────────────────────────────────
branch=$(git branch --show-current || echo '')
if [[ -z "$branch" ]]; then
  fail "detached HEAD — checkout a real branch before working"
fi
if ! [[ "$branch" =~ $ALLOWED_BRANCH_REGEX ]]; then
  fail "branch '$branch' is not in the allowed set
       (main | fix-* | feat-* | hotfix-* | chore-* | claude/*)"
fi
ok "branch = $branch"

# ── Rule 6 — dirty tree ────────────────────────────────────────────────────
dirty=$(git status --short)
if [[ -n "$dirty" && "$ALLOW_DIRTY" -eq 0 ]]; then
  echo "$dirty" >&2
  fail "working tree is dirty — commit, stash, or re-run with --allow-dirty"
fi
[[ "$ALLOW_DIRTY" -eq 1 && -n "$dirty" ]] && echo "⚠️  dirty tree (explicitly allowed)"
[[ -z "$dirty" ]] && ok "working tree clean"

# ── Rule 7 — docker-compose DATABASE_URL guard ─────────────────────────────
if ! grep -qE '^\s*DATABASE_URL:\s*\$\{DATABASE_URL:\?' docker-compose.yml 2>/dev/null; then
  fail "docker-compose.yml missing the \${DATABASE_URL:?...} guard
       (a silent docker-db fallback is not allowed in production)"
fi
if grep -qE 'postgres://.*@db:5432' docker-compose.yml 2>/dev/null; then
  fail "docker-compose.yml still contains a 'db:5432' fallback DSN — must be removed"
fi
ok "docker-compose DATABASE_URL guard present"

# ── Rule 8 — deploy script exists ──────────────────────────────────────────
if [[ ! -x scripts/deploy.sh ]]; then
  fail "scripts/deploy.sh is missing or not executable"
fi
ok "scripts/deploy.sh present"

echo "── all checks passed ──"
