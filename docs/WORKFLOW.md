# Zahran — Canonical Workflow

> **Hard rule:** every change travels `GitHub → Production Server → Supabase`.
> No detached work. No hidden production SQL. No manual rsync from a stale checkout.

## The four fixed endpoints

| Role | Value |
|---|---|
| GitHub repo | `github.com/mohamedzahraneg/zahran-retail-pos.git` |
| Canonical LOCAL path | `/Users/mohamedzahran/Documents/Claude/Projects/Zahran` |
| Canonical branch | `main` |
| Production VPS | `root@72.60.184.79` |
| Production server path | `/root/zahran` (NOT `/opt/zahran`) |
| Production database | Supabase PostgreSQL · project `zahran-pos` · pooler `aws-1-eu-central-2.pooler.supabase.com` |
| Autodeploy mechanism | GitHub webhook → `zahran-autodeploy.sh` on VPS (runs every 30s via systemd timer) |

**None of these four change without a documented migration.** If you find yourself working in a different local path, deploying to a different server path, or writing to a different database, **stop immediately** — something is wrong.

## MANDATORY PRE-WORK CHECK

Run these four lines before touching any code:

```bash
cd /Users/mohamedzahran/Documents/Claude/Projects/Zahran
pwd
git remote -v
git branch --show-current
git status --short
git rev-parse HEAD
git fetch origin
git rev-parse origin/main
git rev-list --left-right --count HEAD...origin/main
```

**STOP if:**
- `pwd` is not `/Users/mohamedzahran/Documents/Claude/Projects/Zahran`
- `git remote -v` does not show `mohamedzahraneg/zahran-retail-pos`
- `git branch --show-current` is not `main` or a named feature branch (`fix-*`, `feat-*`, `claude/*`)
- `git status --short` has unexpected dirty files
- `HEAD` is not `origin/main` (0/0 ahead/behind) when you're about to start work

Or run the automated check:

```bash
scripts/verify-worktree.sh
```

Exits 0 if all checks pass, non-zero with the offending rule otherwise.

## Work cycle

1. `git checkout main && git pull --ff-only origin main` — start from canonical main.
2. `git checkout -b <short-topic-branch>` — all work on a feature branch.
3. Commit small, meaningful units.
4. `git push origin <branch>` + open a PR to main.
5. Merge to main after review → **autodeploy takes over from here**.
6. Verify on Supabase (engine_bypass_alerts, trial balance) per `docs/DEPLOYMENT.md` §6.

## What autodeploy does

`/root/zahran-autodeploy.sh` on the VPS:

1. `git fetch origin main`
2. If `HEAD == origin/main`, exit.
3. `git diff --name-only` to compute which docker services changed.
4. `git reset --hard origin/main` (tracked files only — untracked are preserved).
5. If `backend/*` or `database/migrations/*` changed → `docker compose -p zahran --profile full build api && up -d --force-recreate api`.
6. If `frontend/*` changed → same for `web`.
7. `MigrationsService` (NestJS onModuleInit) applies pending migrations to Supabase.

**This is the ONLY sanctioned deployment path.** `scripts/deploy.sh` is a break-glass alternative for when autodeploy is broken; it runs the same verify script and targets the same `/root/zahran` path.

## Common pitfalls (learnt the hard way)

| Pitfall | What breaks | Prevention |
|---|---|---|
| Running `scripts/deploy.sh` from a stale branch | Rsync overwrites `/opt/zahran` with old code; docker compose recreates containers with outdated binaries | `verify-worktree.sh` refuses to run unless HEAD == origin/main |
| Working in `.claude/worktrees/*` and then deploying | Code not on the branch being deployed; autodeploy and manual deploy disagree | Canonical rule: worktrees are ephemeral; commit + push before deploy |
| Untracked files on the VPS that don't exist in git | Production drifts from source-of-truth; a fresh clone would lose them | Any file in `/root/zahran` that's `??` in `git status` is a red flag |
| Manually applying SQL via `psql` outside `database/migrations/*.sql` | Supabase schema drifts from git history | All schema changes go through a numbered migration file in this repo |
| Two deployment mechanisms targeting the same container names | One rsync races the other; containers flip between versions | `scripts/deploy.sh` deploys to `/root/zahran` (same path as autodeploy); no `/opt/zahran` |

## Verifying the chain after a deploy

```bash
# 1. On the VPS — production SHA matches GitHub main
ssh root@72.60.184.79 'cd /root/zahran && git rev-parse HEAD'
# Expected: equal to  git rev-parse origin/main  on your workstation

# 2. Container is healthy and running the new image
ssh root@72.60.184.79 'docker compose -p zahran ps'
# Expected: zahran-api-1 Status=Up (healthy), Image=zahran-api:latest (recent timestamp)

# 3. DATABASE_URL points at Supabase (masked)
ssh root@72.60.184.79 \
  'docker compose -p zahran exec -T api printenv |
   grep -E "^(DATABASE_URL|NODE_ENV)=" |
   sed -E "s#(:)[^:@]+(@)#\\1***\\2#"'
# Expected:  DATABASE_URL=postgres(ql)?://postgres.<ref>:***@aws-*.pooler.supabase.com:(5432|6543)/postgres

# 4. Latest migration applied to Supabase
#    (run in Supabase SQL editor)
SELECT filename, applied_at FROM public.schema_migrations
 ORDER BY applied_at DESC LIMIT 5;

# 5. Hard gate — no new bypass alerts
SELECT count(*) FROM engine_bypass_alerts
 WHERE created_at > now() - interval '30 minutes';
```

Any of these failing = **stop and investigate**. Don't run another deploy on top of a broken chain.

## Drift detection

Once a week, run on the VPS:

```bash
cd /root/zahran
git fetch origin
LOCAL=$(git rev-parse HEAD); REMOTE=$(git rev-parse origin/main)
[ "$LOCAL" = "$REMOTE" ] && echo "OK" || echo "DRIFT: local=$LOCAL remote=$REMOTE"
git status --short
```

Untracked files (`??`) on the VPS that are not in `.gitignore` = untracked production code. Either commit them to main or delete them — **never leave them**. Every untracked line is a future silent loss.
