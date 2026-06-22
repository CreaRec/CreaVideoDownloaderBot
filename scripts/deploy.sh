#!/usr/bin/env bash
# Deploy Telegram Video Downloader to the Debian server.
#
# Syncs the project, builds it on the server, and installs/restarts the
# systemd service that runs the Telegram bot natively.
#
# Runs the full test suite locally before syncing; deploy aborts if tests fail.
#
# Usage: ./scripts/deploy.sh [--remote]
#
#   --remote   Connect via crearec.app instead of the local network IP (192.168.1.135).
#
# Override any of these via environment variables:
#   SERVER_HOST, SSH_USER, REMOTE_APP_DIR, SERVICE_NAME, DEPLOY_PASSWORD
#
# Optional DEPLOY_PASSWORD in local .env (or env) supplies SSH/sudo passwords via sshpass.
# When unset, SSH and sudo prompt interactively as before.

set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=scripts/lib.sh
. scripts/lib.sh

USE_REMOTE=false
while [ $# -gt 0 ]; do
  case "$1" in
    --remote)
      USE_REMOTE=true
      shift
      ;;
    *)
      err "Unknown argument: $1"
      err "Usage: $0 [--remote]"
      exit 1
      ;;
  esac
done

if [ "${SERVER_HOST+set}" = set ]; then
  : # keep explicit SERVER_HOST from environment
elif [ "$USE_REMOTE" = true ]; then
  SERVER_HOST="crearec.app"
else
  SERVER_HOST="192.168.1.135"
fi
DEFAULT_SSH_USER="${SSH_USER:-crearec}"
SSH_USER="${SSH_USER:-$DEFAULT_SSH_USER}"
REMOTE_APP_DIR="${REMOTE_APP_DIR:-/home/crearec/crea-video-downloader-bot}"
SERVICE_NAME="${SERVICE_NAME:-telegram-video-downloader}"

SSH_TARGET="${SSH_USER}@${SERVER_HOST}"
SSH_CONTROL_PATH="${SSH_CONTROL_PATH:-${TMPDIR:-/tmp}/video-deploy-${SSH_USER}-${SERVER_HOST}}"

if [ -z "${DEPLOY_PASSWORD:-}" ]; then
  DEPLOY_PASSWORD="$(read_env_var DEPLOY_PASSWORD)"
fi

USE_SSHPASS=false
if [ -n "${DEPLOY_PASSWORD:-}" ]; then
  if ! command -v sshpass >/dev/null 2>&1; then
    err "DEPLOY_PASSWORD is set but sshpass is not installed (e.g. brew install hudochenkov/sshpass/sshpass)."
    exit 1
  fi
  export SSHPASS="$DEPLOY_PASSWORD"
  USE_SSHPASS=true
fi

ssh_wrap() {
  if [ "$USE_SSHPASS" = true ]; then
    sshpass -e ssh "$@"
  else
    ssh "$@"
  fi
}

log "Deploying to ${SSH_TARGET}:${REMOTE_APP_DIR} (service: ${SERVICE_NAME})"

# 1. Sanity: required local tooling.
for cmd in rsync ssh npm; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    err "$cmd is required locally."
    exit 1
  fi
done

# 2. Run tests locally before syncing (set -e stops deploy on failure).
log "Running tests..."
npm test
ok "All tests passed."

# 3. One SSH login for the whole deploy (rsync + remote commands reuse this socket).
close_ssh_master() {
  ssh_wrap -S "$SSH_CONTROL_PATH" -O exit "$SSH_TARGET" 2>/dev/null || true
}

open_ssh_master() {
  if ssh_wrap -S "$SSH_CONTROL_PATH" -O check "$SSH_TARGET" 2>/dev/null; then
    return 0
  fi
  if [ "$USE_SSHPASS" = true ]; then
    log "Opening SSH connection..."
  else
    log "Opening SSH connection (enter server password once)..."
  fi
  ssh_wrap -M -S "$SSH_CONTROL_PATH" -fnNT "$SSH_TARGET"
}

open_ssh_master
trap close_ssh_master EXIT

ssh_cmd() { ssh_wrap -S "$SSH_CONTROL_PATH" "$@"; }
RSYNC_RSH="ssh -S ${SSH_CONTROL_PATH}"
if [ "$USE_SSHPASS" = true ]; then
  RSYNC_RSH="sshpass -e ssh -S ${SSH_CONTROL_PATH}"
fi

# 4. Ensure the remote app directory exists.
ssh_cmd "$SSH_TARGET" "mkdir -p '${REMOTE_APP_DIR}'"

# 5. Sync the source (exclude build artefacts, deps, and secrets).
log "Syncing files..."
rsync -az --delete -e "$RSYNC_RSH" \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude 'config/settings.json' \
  --exclude '.env' \
  --exclude '.env.local' \
  --exclude '*.log' \
  --exclude '.DS_Store' \
  ./ "${SSH_TARGET}:${REMOTE_APP_DIR}/"
ok "Files synced."

# 6. Warn if the remote settings file is missing (never overwrite secrets).
if ! ssh_cmd "$SSH_TARGET" "test -f '${REMOTE_APP_DIR}/config/settings.json'"; then
  warn "Remote ${REMOTE_APP_DIR}/config/settings.json is MISSING."
  warn "The remote deploy script will seed it from config/settings.example.json if needed."
fi

# 7. Remote bootstrap: build and systemd. Needs a tty for sudo.
#    Do not pipe the remote script on stdin — that prevents ssh -t from allocating a TTY.
log "Running remote build & service setup..."
REMOTE_SCRIPT="${REMOTE_APP_DIR}/scripts/deploy-remote.sh"
REMOTE_ENV=(
  "REMOTE_APP_DIR=$(printf '%q' "$REMOTE_APP_DIR")"
  "SERVICE_NAME=$(printf '%q' "$SERVICE_NAME")"
  "DEPLOY_USER=$(printf '%q' "$SSH_USER")"
)
if [ -n "${DEPLOY_PASSWORD:-}" ]; then
  REMOTE_ENV+=("DEPLOY_PASSWORD=$(printf '%q' "$DEPLOY_PASSWORD")")
fi
ssh_cmd -tt "$SSH_TARGET" \
  "${REMOTE_ENV[*]} bash $(printf '%q' "$REMOTE_SCRIPT")"

ok "Deploy complete."
