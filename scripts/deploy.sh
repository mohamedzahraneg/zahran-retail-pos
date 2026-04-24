#!/usr/bin/env bash
# =============================================================================
#  Zahran — Deploy script
#  رفع المشروع من الجهاز المحلي لسيرفر الإنتاج + إعادة بناء/تشغيل الحاويات
#
#  الاستخدام:
#    ./scripts/deploy.sh           # رفع + إعادة بناء كل شيء
#    ./scripts/deploy.sh web       # رفع + إعادة بناء الـ frontend فقط
#    ./scripts/deploy.sh api       # رفع + إعادة بناء الـ backend فقط
#    ./scripts/deploy.sh --sync    # رفع الملفات فقط (بدون إعادة بناء)
#    ./scripts/deploy.sh --dry     # يعرض الملفات اللي هتتغير بدون رفع
#
#  المتغيرات (عدّلها حسب الحاجة):
#    SSH_HOST=72.60.184.79
#    SSH_USER=root
#    SSH_PASS=<تُسأل تلقائياً لو مش متوفرة>
#    REMOTE_PATH=/root/zahran   ← canonical; must match autodeploy's REPO_DIR
#
#  NOTE: this is a break-glass path. The canonical deployment mechanism is
#  the webhook-driven `zahran-autodeploy.sh` on the VPS. Use this script
#  only when autodeploy is unreachable. It will refuse to run unless
#  scripts/verify-worktree.sh passes.
# =============================================================================
set -euo pipefail

# ---- إعدادات قابلة للتعديل ----
SSH_HOST="${SSH_HOST:-72.60.184.79}"
SSH_USER="${SSH_USER:-root}"
# Canonical production path — matches autodeploy's REPO_DIR in
# /root/zahran-autodeploy.sh. The old /opt/zahran default caused a
# split-brain where manual deploys and autodeploy targeted different
# directories. Override with REMOTE_PATH=... only if you know exactly
# what you are doing.
REMOTE_PATH="${REMOTE_PATH:-/root/zahran}"

# ---- Mandatory pre-flight: no deploy from a wrong path / dirty tree ----
SCRIPT_DIR_PRE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT_PRE="$(dirname "$SCRIPT_DIR_PRE")"
if [[ -x "$SCRIPT_DIR_PRE/verify-worktree.sh" ]]; then
  ( cd "$PROJECT_ROOT_PRE" && "$SCRIPT_DIR_PRE/verify-worktree.sh" ) \
    || { echo "deploy refused: verify-worktree failed" >&2; exit 1; }
else
  echo "deploy refused: scripts/verify-worktree.sh missing" >&2
  exit 1
fi

# ---- ألوان ----
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'
log()  { echo -e "${GREEN}==>${NC} $*"; }
warn() { echo -e "${YELLOW}!!${NC}  $*"; }
err()  { echo -e "${RED}ERR${NC} $*" >&2; exit 1; }

# ---- تحقق من الأدوات ----
command -v rsync >/dev/null || err "rsync غير مثبّت"
command -v ssh   >/dev/null || err "ssh غير مثبّت"

# ---- احصل على كلمة السر (مرة واحدة) ----
if [[ -z "${SSH_PASS:-}" ]]; then
  if command -v sshpass >/dev/null; then
    read -rsp "🔑 SSH password لـ ${SSH_USER}@${SSH_HOST}: " SSH_PASS
    echo
    export SSH_PASS
  else
    warn "sshpass مش مثبّت — هتحتاج تدخّل الـ password لكل خطوة"
    warn "للتثبيت على الماك:  brew install sshpass   (أو hudochenkov/sshpass)"
    SSH_PREFIX=""
    SSH_PASS=""
  fi
fi
SSH_PREFIX=""
[[ -n "$SSH_PASS" ]] && SSH_PREFIX="sshpass -e "

# ---- تحرك لمسار المشروع (السكربت جوه scripts/) ----
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"
log "مسار المشروع: $PROJECT_ROOT"

# ---- اقرأ العملية المطلوبة ----
MODE="${1:-all}"
DRY_RUN=""
case "$MODE" in
  --dry)    DRY_RUN="--dry-run"; MODE="all" ;;
  --sync)   MODE="sync" ;;
  all|web|api|sync) ;;
  -h|--help)
    sed -n '2,20p' "$0"; exit 0 ;;
  *) err "خيار غير معروف: $MODE" ;;
esac

# ---- خطوة 1: رفع الملفات ----
log "رفع الملفات إلى ${SSH_USER}@${SSH_HOST}:${REMOTE_PATH} ..."
SSHPASS="$SSH_PASS" $SSH_PREFIX rsync -az --itemize-changes $DRY_RUN \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='build' \
  --exclude='.env' \
  --exclude='.env.local' \
  --exclude='*.log' \
  --exclude='.DS_Store' \
  --exclude='.claude' \
  --exclude='.vscode' \
  --exclude='.idea' \
  --exclude='coverage' \
  --exclude='e2e/test-results' \
  --exclude='e2e/playwright-report' \
  -e "ssh -o StrictHostKeyChecking=accept-new" \
  ./ "${SSH_USER}@${SSH_HOST}:${REMOTE_PATH}/"

[[ -n "$DRY_RUN" ]] && { log "dry-run خلص (لم يتم رفع أي حاجة)"; exit 0; }
log "الرفع تم ✓"

# ---- خطوة 2: إعادة البناء/التشغيل ----
if [[ "$MODE" == "sync" ]]; then
  log "تم الاكتفاء بالرفع فقط (--sync)"
  exit 0
fi

build_restart() {
  local target="$1"
  local cmd
  if [[ "$target" == "all" ]]; then
    cmd="cd ${REMOTE_PATH} && docker compose --profile full build && docker compose --profile full up -d"
  else
    cmd="cd ${REMOTE_PATH} && docker compose build ${target} && docker compose up -d ${target}"
  fi
  log "تنفيذ على السيرفر: $cmd"
  SSHPASS="$SSH_PASS" $SSH_PREFIX ssh -o StrictHostKeyChecking=accept-new \
    "${SSH_USER}@${SSH_HOST}" "$cmd"
}

case "$MODE" in
  all)  build_restart "all" ;;
  web)  build_restart "web" ;;
  api)  build_restart "api" ;;
esac

# ---- خطوة 3: تأكد من الصحة ----
log "فحص الصحة ..."
SSHPASS="$SSH_PASS" $SSH_PREFIX ssh -o StrictHostKeyChecking=accept-new \
  "${SSH_USER}@${SSH_HOST}" "cd ${REMOTE_PATH} && docker compose ps"

echo
log "انتهى النشر ✓   —   https://pos.turathmasr.com"
