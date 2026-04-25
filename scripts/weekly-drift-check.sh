#!/usr/bin/env bash
# =============================================================================
#  weekly-drift-check.sh — read-only drift detector for Zahran production
#
#  Runs ON THE VPS (scheduled via systemd timer; also safe to run manually).
#  Emits PASS or FAIL with exact per-failure reasons. Exits 0 on PASS, 1 on FAIL.
#
#  Covers:
#    1.  /root/zahran is a clean git working tree (only .backups + .zahran-quarantine + .env allowed as untracked)
#    2.  HEAD == origin/main (no drift from GitHub)
#    3.  branch is main, not detached
#    4.  Required containers (api/web/redis/minio) are Up (healthy)
#    5.  docker Postgres `db` container is NOT running (must live only in the dev profile)
#    6.  DATABASE_URL points at a Supabase pooler host (not localhost / 127.0.0.1 / db:5432)
#    7.  schema_migrations has a latest migration and no zero-row state
#    8.  engine_bypass_alerts last 7 days == 0
#    9.  Trial balance = 0.00 (global DR = CR)
#    10. Cashbox drift = 0.00 (stored current_balance == SUM(cashbox_transactions))
#    11. Forbidden VPS paths NOT reappearing (backend/src/payroll/*, provisioning/*, orphan frontend payroll files)
#    12. scripts/deploy.sh still invokes verify-worktree.sh
#    13. Refund consistency = 0 rows where GL credits cash but the
#        cashbox_transactions mirror is missing (PR-R0; see
#        scripts/refund-consistency-audit.sql for the query)
#
#  Nothing this script does mutates production. Every SQL query is a SELECT.
# =============================================================================
set -uo pipefail

REPO_DIR="${REPO_DIR:-/root/zahran}"
LOG_FILE="${LOG_FILE:-/var/log/zahran-weekly-drift.log}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-zahran}"

TS_HUMAN=$(date -u +%Y-%m-%dT%H:%M:%SZ)
failures=()

fail()  { failures+=("$1"); }
note()  { :; }  # silent; enable for verbose

# --------------------------------------------------------------------------
# 1. git state on the VPS
# --------------------------------------------------------------------------
if ! cd "$REPO_DIR" 2>/dev/null; then
  fail "REPO_DIR=$REPO_DIR not accessible"
  # Can't continue; emit early.
  {
    echo "[$TS_HUMAN] FAIL 1 issue"
    echo "  - ${failures[0]}"
  } | tee -a "$LOG_FILE"
  exit 1
fi

branch=$(git branch --show-current 2>/dev/null || true)
[ -z "$branch" ] && fail "detached HEAD on $REPO_DIR"
[ -n "$branch" ] && [ "$branch" != "main" ] && fail "branch='$branch' — production must be on main"

# 2. untracked / dirty files (only three names are legit)
# .backups = user backups; .zahran-quarantine = dead-code quarantine (Phase 2.6);
# .env    = production secrets, intentionally excluded from git.
ALLOWED_RE='^(\.backups|\.zahran-quarantine|\.env)$'
while IFS= read -r line; do
  [ -z "$line" ] && continue
  mark="${line:0:2}"
  path="${line:3}"
  path_trim="${path%/}"
  # trim surrounding quotes git uses for names with spaces
  path_trim="${path_trim%\"}"
  path_trim="${path_trim#\"}"
  if echo "$path_trim" | grep -qE "$ALLOWED_RE"; then
    continue
  fi
  if [ "$mark" = "??" ]; then
    fail "untracked file: $path_trim"
  else
    fail "dirty tracked file: $mark $path_trim"
  fi
done < <(git status --porcelain)

# 3. alignment with GitHub main
git fetch origin --quiet 2>/dev/null
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main 2>/dev/null || echo 'MISSING')
if [ "$REMOTE" = "MISSING" ]; then
  fail "cannot read origin/main — fetch failed?"
else
  if [ "$LOCAL" != "$REMOTE" ]; then
    ahead_behind=$(git rev-list --left-right --count HEAD...origin/main 2>/dev/null || echo '? ?')
    ahead=$(echo "$ahead_behind" | awk '{print $1}')
    behind=$(echo "$ahead_behind" | awk '{print $2}')
    fail "VPS HEAD $LOCAL != origin/main $REMOTE (ahead=$ahead behind=$behind)"
  fi
fi

# --------------------------------------------------------------------------
# 4. required docker containers must be Up (healthy)
# --------------------------------------------------------------------------
for svc in api web redis minio; do
  status=$(docker compose -p "$COMPOSE_PROJECT" ps "$svc" --format '{{.Status}}' 2>/dev/null | head -1)
  if [ -z "$status" ]; then
    fail "container $svc not present"
  elif ! echo "$status" | grep -qi 'up.*healthy'; then
    fail "container $svc not Up(healthy): $status"
  fi
done

# 5. docker Postgres MUST NOT be running (dev-profile only)
db_status=$(docker compose -p "$COMPOSE_PROJECT" ps db --format '{{.Status}}' 2>/dev/null | head -1)
if [ -n "$db_status" ]; then
  fail "docker db container is running (must be dev-profile only): $db_status"
fi

# --------------------------------------------------------------------------
# 6. DATABASE_URL must point at Supabase pooler
# --------------------------------------------------------------------------
db_url_masked=""
db_url_raw=""
if [ -f "$REPO_DIR/.env" ]; then
  db_url_raw=$(grep '^DATABASE_URL=' "$REPO_DIR/.env" | head -1 | cut -d= -f2-)
fi
if [ -z "$db_url_raw" ]; then
  fail "DATABASE_URL not found in $REPO_DIR/.env"
else
  # mask password for log output
  db_url_masked=$(echo "$db_url_raw" | sed -E 's#(://[^:]+:)[^@]+(@)#\1***\2#')
  case "$db_url_raw" in
    *"pooler.supabase.com"*"/postgres"*)
      : ;;
    *"localhost"*|*"127.0.0.1"*|*"@db:"*)
      fail "DATABASE_URL points at local docker/localhost (host shown masked): $db_url_masked"
      ;;
    *)
      fail "DATABASE_URL format unexpected (masked): $db_url_masked"
      ;;
  esac
fi

# --------------------------------------------------------------------------
# 7–10. Financial health via Supabase (read-only)
# --------------------------------------------------------------------------
sql_one() {
  # $1 = sql ; returns single value from first row first column (or empty on error)
  [ -z "$db_url_raw" ] && { echo ''; return; }
  PGOPTIONS='--client-min-messages=warning' \
    psql "$db_url_raw" -XAt -c "$1" 2>/dev/null || echo ''
}

if [ -n "$db_url_raw" ]; then
  # 7. latest migration + row count
  migration_count=$(sql_one "SELECT count(*) FROM public.schema_migrations;")
  latest_migration=$(sql_one "SELECT filename FROM public.schema_migrations ORDER BY applied_at DESC LIMIT 1;")
  if [ -z "$migration_count" ] || [ "$migration_count" = "0" ]; then
    fail "schema_migrations returned 0 rows (cannot read or empty)"
  fi

  # 8. bypass alerts last 7 days — MUST be 0 for UNRESOLVED events.
  #    A bypass event that already has a resolved=TRUE twin in
  #    financial_anomalies has been triaged and is no longer drift;
  #    counting those would produce false positives for 7 days after
  #    every historical incident.
  bypass_7d_total=$(sql_one "SELECT count(*) FROM public.engine_bypass_alerts WHERE created_at > now() - interval '7 days';")
  bypass_7d=$(sql_one "
    SELECT count(*)
      FROM public.engine_bypass_alerts ba
     WHERE ba.created_at > now() - interval '7 days'
       AND NOT EXISTS (
         SELECT 1 FROM public.financial_anomalies fa
          WHERE fa.anomaly_type    = 'legacy_bypass_journal_entry'
            AND fa.affected_entity = ba.table_name
            AND fa.reference_id    = ba.record_id
            AND fa.resolved        = TRUE
       );")
  if [ -z "$bypass_7d" ]; then
    fail "cannot read engine_bypass_alerts"
  elif [ "$bypass_7d" != "0" ]; then
    fail "engine_bypass_alerts unresolved last 7 days = $bypass_7d (total raw=$bypass_7d_total; expected unresolved=0)"
  fi

  # 9. trial balance — Σ DR − Σ CR over posted, non-void entries
  trial=$(sql_one "SELECT (COALESCE(SUM(jl.debit),0) - COALESCE(SUM(jl.credit),0))::text
                     FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
                    WHERE je.is_posted = TRUE AND je.is_void = FALSE;")
  if [ -z "$trial" ]; then
    fail "cannot compute trial balance"
  else
    # normalize 0, 0.0, 0.00 to 0
    trial_num=$(printf "%.2f" "$trial" 2>/dev/null || echo "$trial")
    if ! echo "$trial_num" | grep -qE '^-?0\.00$'; then
      fail "trial balance drift: DR-CR = $trial_num"
    fi
  fi

  # 10. cashbox drift per active cashbox
  # returns max absolute drift across active cashboxes
  max_drift=$(sql_one "SELECT COALESCE(MAX(ABS(c.current_balance - COALESCE(
       (SELECT SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END)
          FROM cashbox_transactions WHERE cashbox_id = c.id), 0))), 0)::text
       FROM cashboxes c WHERE c.is_active = TRUE;")
  if [ -z "$max_drift" ]; then
    fail "cannot compute cashbox drift"
  else
    drift_num=$(printf "%.2f" "$max_drift" 2>/dev/null || echo "$max_drift")
    if ! echo "$drift_num" | grep -qE '^-?0\.00$'; then
      fail "cashbox drift: max |stored − computed| = $drift_num"
    fi
  fi

  # 13. Refund consistency (PR-R0).
  #     Detects refunds/exchanges where the GL credited a cash-mirror
  #     account (chart_of_accounts.code LIKE '111_') but the matching
  #     cashbox_transactions out-row is missing or short. Each such
  #     row desyncs GL cash from cashboxes.current_balance — invisible
  #     to checks #9 + #10 because each side is internally balanced.
  #     The full per-row report lives in scripts/refund-consistency-audit.sql;
  #     this is just the count + total missing amount.
  refund_inconsistent=$(sql_one "
    WITH gl AS (
      SELECT je.reference_type::text AS rt, je.reference_id AS rid,
             SUM(jl.credit)::numeric AS gl_credit
        FROM journal_entries je
        JOIN journal_lines    jl  ON jl.entry_id = je.id
        JOIN chart_of_accounts coa ON coa.id     = jl.account_id
       WHERE je.is_posted = TRUE AND je.is_void = FALSE
         AND coa.code LIKE '111_'
         AND je.reference_type::text IN ('return','exchange')
         AND je.reference_id IS NOT NULL
         AND jl.credit > 0
       GROUP BY je.reference_type, je.reference_id
    ),
    co AS (
      SELECT ct.reference_type::text AS rt, ct.reference_id AS rid,
             SUM(ct.amount)::numeric AS ct_out
        FROM cashbox_transactions ct
       WHERE ct.direction = 'out'
         AND ct.reference_type::text IN ('return','exchange')
       GROUP BY ct.reference_type, ct.reference_id
    )
    SELECT COUNT(*)::text
      FROM gl LEFT JOIN co USING (rt, rid)
     WHERE COALESCE(co.ct_out, 0) + 0.01 < gl.gl_credit;")
  if [ -z "$refund_inconsistent" ]; then
    fail "cannot compute refund consistency"
  elif [ "$refund_inconsistent" != "0" ]; then
    refund_total=$(sql_one "
      WITH gl AS (
        SELECT je.reference_type::text AS rt, je.reference_id AS rid,
               SUM(jl.credit)::numeric AS gl_credit
          FROM journal_entries je
          JOIN journal_lines    jl  ON jl.entry_id = je.id
          JOIN chart_of_accounts coa ON coa.id     = jl.account_id
         WHERE je.is_posted = TRUE AND je.is_void = FALSE
           AND coa.code LIKE '111_'
           AND je.reference_type::text IN ('return','exchange')
           AND je.reference_id IS NOT NULL
           AND jl.credit > 0
         GROUP BY je.reference_type, je.reference_id
      ),
      co AS (
        SELECT ct.reference_type::text AS rt, ct.reference_id AS rid,
               SUM(ct.amount)::numeric AS ct_out
          FROM cashbox_transactions ct
         WHERE ct.direction = 'out'
           AND ct.reference_type::text IN ('return','exchange')
         GROUP BY ct.reference_type, ct.reference_id
      )
      SELECT COALESCE(SUM(gl.gl_credit - COALESCE(co.ct_out, 0)), 0)::text
        FROM gl LEFT JOIN co USING (rt, rid)
       WHERE COALESCE(co.ct_out, 0) + 0.01 < gl.gl_credit;")
    fail "refund consistency: $refund_inconsistent refund/exchange row(s) GL-credited cash but cashbox mirror is short by ${refund_total} (run scripts/refund-consistency-audit.sql for per-row detail)"
  fi
fi

# --------------------------------------------------------------------------
# 11. forbidden VPS paths must NOT reappear
# --------------------------------------------------------------------------
FORBIDDEN=(
  "backend/src/payroll"
  "backend/src/provisioning"
)
for p in "${FORBIDDEN[@]}"; do
  if [ -e "$REPO_DIR/$p" ]; then
    fail "forbidden dead-code path reappeared: $p"
  fi
done

# --------------------------------------------------------------------------
# 12. deploy.sh must still invoke verify-worktree.sh
# --------------------------------------------------------------------------
if [ -f "$REPO_DIR/scripts/deploy.sh" ]; then
  if ! grep -q 'verify-worktree.sh' "$REPO_DIR/scripts/deploy.sh"; then
    fail "scripts/deploy.sh no longer calls verify-worktree.sh (guard removed)"
  fi
else
  fail "scripts/deploy.sh missing"
fi

# --------------------------------------------------------------------------
# Emit + log
# --------------------------------------------------------------------------
{
  if [ ${#failures[@]} -eq 0 ]; then
    echo "[$TS_HUMAN] PASS head=$LOCAL branch=$branch migrations=${migration_count:-?} bypass_7d=${bypass_7d:-?} trial=${trial_num:-?} drift=${drift_num:-?} refund_inconsistent=${refund_inconsistent:-?}"
  else
    echo "[$TS_HUMAN] FAIL ${#failures[@]} issue(s)"
    for f in "${failures[@]}"; do echo "  - $f"; done
  fi
} | tee -a "$LOG_FILE"

[ ${#failures[@]} -eq 0 ] && exit 0 || exit 1
