#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
#  Zahran autodeploy — CANONICAL copy (deployed to /root/)
#  ---------------------------------------------------------------------
#  Polls GitHub; when the remote is ahead of the local working tree it
#  pulls and rebuilds only the services whose files changed.
#  Meant to run every 30 seconds via systemd.
#
#  IMPORTANT — THE CRITICAL FIX (migration 059 incident):
#    Before this version, a migration-only change (e.g. a new
#    database/migrations/NNN.sql file, no backend code change) set
#    NEED_DB=1 but NEED_API=0 → the backend container never restarted
#    → the MigrationsService inside the backend never ran on the new
#    file → Supabase never got the migration.
#
#    Meanwhile the autodeploy's own psql path only works if
#    $SUPABASE_DB_URL + $SUPABASE_DB_PASSWORD are in the environment,
#    which they weren't (confirmed by /root/.zahran-applied-migrations
#    stopping at 036 while Supabase had 058 applied via the backend).
#
#    So migration 059 sat in the repo for ~10 minutes without being
#    applied to the real DB, leaving the DB-level engine-context guard
#    in a silently-broken state. Only caught because a human ran the
#    acid test.
#
#    Fix: database/migrations/* changes now ALSO set NEED_API=1, so
#    the backend container is force-recreated and its MigrationsService
#    applies the new file on boot (authoritative path — same one that
#    works in dev).
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_DIR="/root/zahran"
PROJECT="zahran"
LOG="/var/log/zahran-autodeploy.log"

log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

cd "$REPO_DIR"

# Ensure we track origin/main.
git fetch --quiet origin main || { log "fetch failed"; exit 0; }

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
[[ "$LOCAL" == "$REMOTE" ]] && exit 0   # already up to date

log "new commit on origin/main: $LOCAL → $REMOTE"

# Compute which services are affected before we pull.
CHANGED=$(git diff --name-only "$LOCAL" "$REMOTE")
NEED_API=0
NEED_WEB=0
NEED_DB=0
while read -r f; do
  [[ -z "$f" ]] && continue
  case "$f" in
    backend/*)            NEED_API=1 ;;
    frontend/*)           NEED_WEB=1 ;;
    docker-compose.yml)   NEED_API=1; NEED_WEB=1 ;;
    # ── CRITICAL: migration changes MUST rebuild the API container.
    # The backend's MigrationsService (NestJS onModuleInit) is the
    # authoritative path that applies pending migrations to the
    # configured DATABASE_URL (Supabase in prod). Without the restart,
    # a new .sql file lives in the repo but never reaches the DB.
    database/migrations/*) NEED_DB=1; NEED_API=1 ;;
  esac
done <<< "$CHANGED"

log "api=$NEED_API web=$NEED_WEB db=$NEED_DB"

# Pull (hard-reset so any on-server edits are cleanly replaced).
git reset --hard origin/main >> "$LOG" 2>&1 || { log "pull failed"; exit 1; }

build_args=""
[[ $NEED_API -eq 1 ]] && build_args+=" api"
[[ $NEED_WEB -eq 1 ]] && build_args+=" web"

if [[ -n "$build_args" ]]; then
  log "docker build -$build_args"
  docker compose -p "$PROJECT" --profile full build $build_args >> "$LOG" 2>&1
  docker compose -p "$PROJECT" --profile full up -d --force-recreate $build_args >> "$LOG" 2>&1
  log "rebuilt:$build_args"
fi

# Legacy psql-direct migration application — kept for compatibility
# but no longer the primary path. The backend's MigrationsService
# (invoked during the container restart above) is authoritative.
# This loop will no-op for migrations the backend already tracked
# because of the grep against $APPLIED_FILE.
if [[ $NEED_DB -eq 1 ]]; then
  APPLIED_FILE="/root/.zahran-applied-migrations"
  touch "$APPLIED_FILE"
  if [[ -n "${SUPABASE_DB_URL:-}" ]]; then
    for m in database/migrations/*.sql; do
      base=$(basename "$m")
      if ! grep -qF "$base" "$APPLIED_FILE"; then
        log "applying migration $base via psql fallback"
        PGPASSWORD="${SUPABASE_DB_PASSWORD:-}" \
          psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f "$m" >> "$LOG" 2>&1 \
          && echo "$base" >> "$APPLIED_FILE" \
          || log "migration $base FAILED via psql — backend MigrationsService will retry on next boot"
      fi
    done
  else
    log "SUPABASE_DB_URL not set — skipping psql fallback (backend MigrationsService is authoritative anyway)"
  fi
fi

log "autodeploy tick complete"
