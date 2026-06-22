#!/usr/bin/env bash
# Manage the remote telegram-video-downloader systemd service over SSH.
#
# Usage: ./scripts/service-debian.sh [--remote] [start|restart|status|logs|stop]
#
# Override via environment: SERVER_HOST, SSH_USER, SERVICE_NAME, DEPLOY_PASSWORD

set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=scripts/lib.sh
. scripts/lib.sh

USE_REMOTE=false
ACTION=""

while [ $# -gt 0 ]; do
  case "$1" in
    --remote)
      USE_REMOTE=true
      shift
      ;;
    start|restart|status|logs|stop)
      if [ -n "$ACTION" ]; then
        err "Unexpected extra argument: $1"
        exit 1
      fi
      ACTION="$1"
      shift
      ;;
    -h|--help|help)
      cat <<USAGE
Usage: $0 [--remote] [start|restart|status|logs|stop]

Environment variables:
  SERVER_HOST      Debian server hostname or IP
  SSH_USER         SSH user (default: crearec)
  SERVICE_NAME     systemd service name (default: telegram-video-downloader)
  DEPLOY_PASSWORD  Optional SSH/sudo password (uses sshpass when set)

Examples:
  $0 restart
  $0 --remote status
  SERVER_HOST=192.168.1.135 SSH_USER=crearec $0 logs
USAGE
      exit 0
      ;;
    *)
      err "Unknown argument: $1"
      exit 1
      ;;
  esac
done

ACTION="${ACTION:-restart}"

if [ "${SERVER_HOST+set}" = set ]; then
  :
elif [ "$USE_REMOTE" = true ]; then
  SERVER_HOST="crearec.app"
else
  SERVER_HOST="192.168.1.135"
fi

SSH_USER="${SSH_USER:-crearec}"
SERVICE_NAME="${SERVICE_NAME:-telegram-video-downloader}"
SSH_TARGET="${SSH_USER}@${SERVER_HOST}"

if [ -z "${DEPLOY_PASSWORD:-}" ]; then
  DEPLOY_PASSWORD="$(read_env_var DEPLOY_PASSWORD)"
fi

ssh_wrap() {
  if [ -n "${DEPLOY_PASSWORD:-}" ]; then
    if ! command -v sshpass >/dev/null 2>&1; then
      err "DEPLOY_PASSWORD is set but sshpass is not installed."
      exit 1
    fi
    SSHPASS="$DEPLOY_PASSWORD" sshpass -e ssh "$@"
  else
    ssh "$@"
  fi
}

if ! command -v ssh >/dev/null 2>&1; then
  err "ssh is required."
  exit 1
fi

case "${ACTION}" in
  logs)
    log "Following logs for ${SERVICE_NAME} on ${SSH_TARGET}..."
    ssh_wrap -t "${SSH_TARGET}" "sudo journalctl -u '${SERVICE_NAME}' -f"
    ;;
  status)
    log "Checking ${SERVICE_NAME} on ${SSH_TARGET}..."
    ssh_wrap -t "${SSH_TARGET}" "sudo systemctl status '${SERVICE_NAME}'"
    ;;
  *)
    log "Running '${ACTION}' for ${SERVICE_NAME} on ${SSH_TARGET}..."
    ssh_wrap -t "${SSH_TARGET}" "sudo systemctl '${ACTION}' '${SERVICE_NAME}' && sudo systemctl status '${SERVICE_NAME}' --no-pager"
    ;;
esac
