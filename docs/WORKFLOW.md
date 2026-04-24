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

## Weekly drift guard

A systemd-scheduled, read-only audit runs on the VPS every **Sunday 03:00 UTC** and catches silent drift before it becomes corruption. The script and its units live in the repo:

- `scripts/weekly-drift-check.sh` — the audit itself (executable)
- `scripts/systemd/zahran-weekly-drift.service` — oneshot service unit
- `scripts/systemd/zahran-weekly-drift.timer` — Sunday 03:00 UTC trigger

### What it checks (12 invariants)

| # | Invariant | Failure looks like |
|---|---|---|
| 1 | `/root/zahran` is a clean git tree; only `.backups`, `.zahran-quarantine`, `.env` may be untracked | `untracked file: <path>` or `dirty tracked file: <mark> <path>` |
| 2 | HEAD not detached | `detached HEAD on /root/zahran` |
| 3 | branch is `main` | `branch='…' — production must be on main` |
| 4 | VPS HEAD == `origin/main` | `VPS HEAD <sha> != origin/main <sha> (ahead=… behind=…)` |
| 5 | `api`, `web`, `redis`, `minio` containers are Up (healthy) | `container <svc> not Up(healthy): <status>` |
| 6 | docker `db` container NOT running (dev-profile only) | `docker db container is running …` |
| 7 | `DATABASE_URL` points at `*.pooler.supabase.com/postgres` | `DATABASE_URL points at local docker/localhost …` |
| 8 | `public.schema_migrations` has rows, latest recorded | `schema_migrations returned 0 rows …` |
| 9 | Unresolved bypass events in last 7 days = 0 | `engine_bypass_alerts unresolved last 7 days = N …` |
| 10 | Trial balance (Σ DR − Σ CR) = 0.00 | `trial balance drift: DR-CR = <amount>` |
| 11 | Cashbox drift (stored vs computed) = 0.00 | `cashbox drift: max \|stored − computed\| = <amount>` |
| 12 | Forbidden dead-code paths never reappear | `forbidden dead-code path reappeared: <path>` |
| +  | `scripts/deploy.sh` still invokes `verify-worktree.sh` | `scripts/deploy.sh no longer calls verify-worktree.sh …` |

The bypass check (#9) specifically counts events **without** a resolved `financial_anomalies` twin — historical events that have been triaged don't produce weekly noise.

### Reading the log

All runs (PASS or FAIL) append a timestamped line to `/var/log/zahran-weekly-drift.log`:

```
[2026-04-24T09:36:27Z] PASS head=<sha> branch=main migrations=83 bypass_7d=0 trial=0.00 drift=0.00
[2026-04-30T03:03:54Z] FAIL 2 issue(s)
  - untracked file: database/ad-hoc-fix.sql
  - engine_bypass_alerts unresolved last 7 days = 3 …
```

Check recent runs:
```bash
ssh root@72.60.184.79 'tail -50 /var/log/zahran-weekly-drift.log'
```

Check timer + last service state:
```bash
ssh root@72.60.184.79 'systemctl status zahran-weekly-drift.timer
                      systemctl status zahran-weekly-drift.service
                      systemctl list-timers zahran-weekly-drift.timer'
```

### Fixing failures

| Symptom | Response |
|---|---|
| `untracked file: <path>` | Either commit the file through a PR (if production-critical) or move it to `/root/zahran/.zahran-quarantine/` and record why it was abandoned. Never just `rm` without preserving. |
| `VPS HEAD != origin/main` | Autodeploy timer is misbehaving. Check `systemctl status zahran-autodeploy.timer` and `/var/log/zahran-autodeploy.log`. Never fix by `git reset` on the VPS manually — let autodeploy pull normally. |
| `container X not Up(healthy)` | `docker compose -p zahran logs <svc>` and treat as a standard incident. If the api crash-loops because the startup DB sanity check fails, re-verify `/root/zahran/.env` `DATABASE_URL`. |
| `docker db container is running` | Someone started the dev profile on production. `docker compose -p zahran --profile dev down` to stop; investigate how it got started. |
| `DATABASE_URL points at local…` | Immediately stop API: `docker compose -p zahran stop api`. Fix `.env`. Restart. Then verify no writes happened since the bad URL was in effect. |
| `engine_bypass_alerts unresolved last 7 days = N` | Investigate each bypass (see `docs/DEPLOYMENT.md` §6 on-deploy verification SQL). Either triage via `financial_anomalies` resolution, or create a tracked fix PR (like migration 072 did). |
| `trial balance drift` or `cashbox drift ≠ 0` | This is the severe case. Stop all writes (`docker compose -p zahran stop api`). Do a forensic SQL audit (see `posting.service.reverseByReference` for the reversal model). Do NOT issue manual UPDATEs to patch the numbers. |
| `forbidden dead-code path reappeared` | Move to `.zahran-quarantine/`. Investigate how it got there — usually a manual scp / rsync outside the canonical flow. |

### Running it manually

```bash
ssh root@72.60.184.79 '/root/zahran/scripts/weekly-drift-check.sh'
# exit 0 = PASS, exit 1 = FAIL (reasons printed + logged)
```

This is safe to run at any time — every query is read-only.

### Installing / reinstalling the timer

From your workstation, once:
```bash
cd /Users/mohamedzahran/Documents/Claude/Projects/Zahran
scp scripts/systemd/zahran-weekly-drift.{service,timer} root@72.60.184.79:/etc/systemd/system/
ssh root@72.60.184.79 'systemctl daemon-reload && \
                       systemctl enable --now zahran-weekly-drift.timer'
```
