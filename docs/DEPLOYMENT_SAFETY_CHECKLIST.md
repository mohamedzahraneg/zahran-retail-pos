# Deployment Safety Checklist

Run this checklist for **every** development task on the Zahran Retail
POS project. The order is mandatory: each step builds on the previous
one. Do not skip steps even when the task feels small.

This file is **documentation only** — it doesn't ship any code or
trigger any deployment. It exists so every future change follows the
same safe workflow regardless of who's at the keyboard.

> Sibling docs you should have read at least once:
> [`docs/WORKFLOW.md`](WORKFLOW.md) · [`docs/DEPLOYMENT.md`](DEPLOYMENT.md) · [`docs/OFFLINE_STRATEGY.md`](OFFLINE_STRATEGY.md)

---

## 1. Correct project path verification

Run:

```bash
pwd
```

The output **must** be the POS project root, e.g.:

```
/Users/<you>/Documents/Claude/Projects/Zahran
```

(or your local equivalent — but it must be the directory that contains
both `frontend/` and `backend/` and the root `docker-compose.yml`.)

**Hard rules:**
- ❌ Do not run `git` commands or edit files **outside** the POS
  project path. The host machine has unrelated repos in nearby
  directories — straying outside is the most common cause of
  cross-project mistakes.
- ✅ If you need to inspect another repo, do it in a separate shell
  / agent session, not from inside this one.

---

## 2. Git safety

Run all four:

```bash
git status
git branch --show-current
git remote -v
git log --oneline -5
```

**Verify:**
- **Branch:** `main` for trunk work, or a clearly-named feature branch
  (`pr-fe-*`, `pr-fix-*`, `pr-fe-idem-*`, etc.).
- **Working tree:** clean *except* for the change you intend to make.
  If `git status` shows pre-existing modified or staged files you
  did not author in this session, **stop** and identify them first.
- **Untracked files:** the project currently has one long-standing
  untracked path (`backend/src/provisioning/`). It is **not** to be
  added, modified, or committed unless explicitly authorized in a
  separate task. Treat all unfamiliar untracked content the same way:
  identify it, then leave it alone.
- **Remote URL:** must be exactly
  `https://github.com/mohamedzahraneg/zahran-retail-pos.git` for both
  `fetch` and `push`. If the URL is anything else (a fork, a personal
  mirror, the wrong org), **stop** and surface the discrepancy.
- **Recent commits:** sanity-check the last 5 commits look right —
  i.e., they're commits on this project, not from a different repo
  you accidentally `cd`'d into.

**Rule:** Never include unrelated or pre-existing untracked files in
any commit. Stage files **by name**, not via `git add -A` / `git add .`,
unless every untracked path has been explicitly cleared.

---

## 3. Change scope

Before touching any file, write down (in your head or in a comment):

| Class | Touches | Rebuild trigger |
|---|---|---|
| **FE** (Frontend) | `frontend/**` | `web` container |
| **BE** (Backend) | `backend/**` | `api` container |
| **DB** (Migrations / schema) | `database/migrations/**` | **STOP — request approval** |
| **Infra** | `docker-compose.yml`, `Dockerfile`, `.github/workflows/**`, `frontend/nginx.conf` | varies (web / api / both / CI only) |
| **Docs** | `docs/**`, `README.md`, `*.md` | nothing rebuilds |

**Rules:**
- A FE-only PR must touch nothing under `backend/`.
- A BE-only PR must touch nothing under `frontend/`.
- A DB migration is **never** routine — it must stop the workflow and
  request explicit approval before being authored, applied, or
  committed (see Section 8).
- An infra change has a wide blast radius — call it out explicitly in
  the PR description and verify which containers it forces to rebuild.

Predict which container(s) will rebuild on autodeploy **before** you
push. After deploy, the actual rebuild status (Section 7) must match
your prediction.

---

## 4. Pre-commit checks

Run, in order, only the commands that are genuinely available for the
files you changed:

```bash
git diff                                    # always
git diff --name-only                        # always
git diff --stat                             # for a quick size check
```

Then, scoped to what changed:

| If you touched | Run (when present) |
|---|---|
| `frontend/**` | `cd frontend && npx tsc --noEmit` |
| `frontend/**` (tests touched) | `cd frontend && npx vitest run <focused-spec>` |
| `frontend/**` (UI render path) | `cd frontend && npm run build` |
| `backend/**` | `cd backend && npx tsc --noEmit` |
| `backend/**` (tests touched) | `cd backend && npx jest <focused-spec>` |
| `backend/**` | `cd backend && npm run build` |
| Docs only | nothing — `git diff` is sufficient |

**Notes:**
- The full FE vitest suite has a known **parallelism flake** (observed
  across PRs #320–#329). Skip the full local run; rely on the CI
  Frontend (Node 20) job in the isolated environment as the
  authoritative check. Mention this trade-off explicitly in the PR
  body when it applies.
- Run the **focused** test for the area you changed first; only run
  full suites if the focused run passes.

**Rule:** Never invent commands. If `npm run lint` doesn't exist in
the relevant `package.json`, don't run it — and don't pretend to.

---

## 5. Commit / push rules

**Commit message format** (follow what the recent log shows):

```
<type>(<scope>): <one-line summary> (PR-<TAG>)

<longer description — root cause, exact files, trade-offs,
why this approach over alternatives, links to incident/PR
context, tests run, gates passed>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

**Stage by name:**
```bash
git add <file1> <file2> ...
```
Never `git add -A` or `git add .` while the
`backend/src/provisioning/` directory (or any other unintended
untracked content) is present.

**Push:**
```bash
git push -u origin <current-branch>
```

**Hard rules:**
- **Push only to the verified remote** (`origin` →
  `https://github.com/mohamedzahraneg/zahran-retail-pos.git`).
- **Never `--force` push without explicit approval.** Even on a feature
  branch, force-push can clobber a teammate's amend-and-push or break
  a PR's review history.
- **Never `--force` push to `main`** under any circumstance — request
  approval and document why.
- The `--no-verify` and `--no-gpg-sign` flags are **off-limits** unless
  the user has explicitly asked for them. Pre-commit hooks exist for a
  reason; if a hook fails, fix the underlying issue.

---

## 6. Deployment rules

**Deployment method (verified, not invented):**
**Docker Compose + git-pull autodeploy on the VPS at `72.60.184.79`.**

Mechanism:
1. You push to `origin/main`.
2. The VPS at `/root/zahran` pulls the commit.
3. `docker compose build` rebuilds whichever services have a code
   delta in their Dockerfile context.
4. `docker compose up -d` swaps the affected containers.

**Container ↔ scope mapping:**
- FE merge → `web` container rebuilds; `api` is untouched.
- BE merge → `api` container rebuilds; `web` is untouched.
- Compose / Dockerfile change → the affected services rebuild.
- DB migration → no automatic apply. The team applies migrations
  through a separate, deliberate step.

**Hard rules:**
- **Do not invent deployment commands.** The autodeploy is the only
  supported path. There is no `npm start` / `pm2 reload` / `systemctl`
  step on this project.
- **Manual server deployment only if the user explicitly requests it.**
  If the user says "rebuild api now" or "ssh in and pull", that is the
  authorization. Otherwise let autodeploy handle it.
- **Don't run production mutation endpoint tests.** Verification uses
  read-only routes (`/health`, page-200 checks) and read-only SQL.
- **Don't `docker compose down` or `restart` a container** that wasn't
  affected by your change. Autodeploy already restarts only what it
  rebuilt.

---

## 7. Post-deployment verification

After autodeploy fires, verify in this order:

### 7.1 — Confirm deployed commit hash

```bash
ssh root@72.60.184.79 'cd /root/zahran && git log --oneline -1'
```

The `HEAD` hash **must** equal the merge commit returned by
`gh pr view <N> --json mergeCommit`. If it doesn't match within 60s of
push, the autodeploy hook didn't fire — investigate before continuing.

### 7.2 — Container status

```bash
ssh root@72.60.184.79 'cd /root/zahran && docker compose ps'
```

The four expected services:

| Service | Image | Expected after FE-only deploy | Expected after BE-only deploy |
|---|---|---|---|
| `zahran-api` (api) | `zahran-api` | unchanged uptime | rebuilt (uptime resets) |
| `zahran-web` (web) | `zahran-web` | rebuilt (uptime resets) | unchanged uptime |
| `zahran-redis-1` (redis) | `redis:7-alpine` | unchanged | unchanged |
| `zahran-minio-1` (minio) | `minio/minio:latest` | unchanged | unchanged |

If a service that should be unchanged shows a fresh uptime, surface
that — it usually means a Dockerfile or compose change leaked into the
PR.

### 7.3 — Container logs (read-only)

```bash
ssh root@72.60.184.79 'cd /root/zahran && docker compose logs --tail 50 api'
ssh root@72.60.184.79 'cd /root/zahran && docker compose logs --tail 50 web'
```

Look for fresh exceptions, boot-time errors, or `engine_bypass_alerts`
warnings. **Don't** run `docker logs -f` (follow mode) unless the user
explicitly asks for it — it ties up the session.

### 7.4 — Frontend loads

```bash
ssh root@72.60.184.79 "for p in / /dashboard/finance /cashboxes /analytics /health; do
  code=\$(curl -sk -o /dev/null -w '%{http_code}' 'https://72.60.184.79'\$p)
  echo \"\$p → \$code\"
done"
```

Every path must return `200`. If you added a new route, include it in
the curl loop.

### 7.5 — Backend health / API responds

```bash
ssh root@72.60.184.79 "curl -sk -o /dev/null -w '%{http_code}\n' 'https://72.60.184.79/health'"
```

Must return `200`. For BE-only deploys, also confirm the protected-
route count is unchanged (it should remain `51` unless the PR
intentionally added routes):

```bash
ssh root@72.60.184.79 'cd /root/zahran && grep -rE "@UseInterceptors\(IdempotencyInterceptor\)" backend/src --include="*.controller.ts" | wc -l'
```

### 7.6 — DB invariants (read-only SQL)

For any deploy that touches financial logic, FE pages that render
balances, or accounting pages:

```bash
ssh root@72.60.184.79 << 'EOF'
cd /root/zahran && set -a && source .env && set +a
psql "$DATABASE_URL" -At -c "
  SELECT 'trial_balance' || '|' || COALESCE(SUM(debit) - SUM(credit), 0)::text FROM journal_lines
  UNION ALL SELECT 'max_abs_cashbox_drift|' || COALESCE(MAX(ABS(drift_amount)), 0)::text FROM v_cashbox_gl_drift;
"
EOF
```

Trial balance must be `0.00`. Max cashbox drift must be `0.00`.

For BE-only deploys, also confirm `engine_bypass_alerts` row count
hasn't moved unexpectedly — a sudden jump usually means an
`accounting_only=true` bypass was triggered, which deserves
investigation.

---

## 8. Stop conditions

You **must stop and ask the user** before doing any of the following:

- ❌ Running a DB migration (creating, applying, rolling back).
- ❌ Deleting files, branches, or commits (especially `git reset
  --hard`, `git checkout --`, `git clean`, `rm -rf`).
- ❌ Touching, modifying, or committing the
  `backend/src/provisioning/` untracked work (or any unfamiliar
  untracked path discovered during Section 2).
- ❌ Editing `docker-compose.yml`, any `Dockerfile`,
  `frontend/nginx.conf`, `.github/workflows/**`, or any secret /
  credential file.
- ❌ Force-pushing (`--force` / `+refs/...`) to **any** branch.
- ❌ Restarting services unrelated to the current change.
- ❌ Running destructive shell commands (`rm -rf`, `dd`, `mkfs`,
  database `DROP`/`TRUNCATE`/`DELETE` without `WHERE`, etc.).
- ❌ Changing accounting / financial-posting logic, the financial
  engine guards, the `IdempotencyInterceptor`, JE/CT formulas, or any
  cashbox alignment code without a clear root-cause report and an
  explicit approval to proceed (see PR-FIX-POS-EDIT-CASH-GL-ALIGNMENT
  for the format).

When in doubt: stop, summarize what you were about to do, ask. The
cost of a 30-second pause is far smaller than the cost of an unwanted
mutation in production.

---

## Quick reference — the 8-step ritual

```
Step 1  Environment      pwd · git status · git branch · git remote -v
Step 2  Project structure Identify FE / BE / DB / infra files in scope
Step 3  Change            Edit only required files; minimal scope
Step 4  Local checks      tsc + focused tests + (build if relevant)
Step 5  Review            git diff · summarize · risk assessment
Step 6  Commit + push     Stage by name · clear message · push only after passing
Step 7  Deploy            Autodeploy fires; do nothing manual unless asked
Step 8  Verify            Commit hash · containers · logs · pages 200 · health · DB invariants
```

If step N fails, do not proceed to step N+1 — stop and report.
