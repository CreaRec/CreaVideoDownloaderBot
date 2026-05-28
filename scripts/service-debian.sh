#!/usr/bin/env bash
set -euo pipefail

SERVER_HOST="${SERVER_HOST:-192.168.1.135}"
DEFAULT_SSH_USER="${SSH_USER:-crearec}"
SERVICE_NAME="${SERVICE_NAME:-telegram-video-downloader}"
ACTION="${1:-restart}"

usage() {
  cat <<USAGE
Usage: $0 [start|restart|status|logs|stop]

Environment variables:
  SERVER_HOST   Debian server hostname or IP. Default: ${SERVER_HOST}
  SSH_USER      SSH user. Default: ${DEFAULT_SSH_USER}
  SERVICE_NAME  systemd service name. Default: ${SERVICE_NAME}

Examples:
  $0 restart
  $0 start
  $0 status
  SERVER_HOST=192.168.1.135 SSH_USER=crearec $0 logs
USAGE
}

case "${ACTION}" in
  start|restart|status|logs|stop) ;;
  -h|--help|help)
    usage
    exit 0
    ;;
  *)
    echo "Unknown action: ${ACTION}" >&2
    usage >&2
    exit 1
    ;;
esac

if ! command -v ssh >/dev/null 2>&1; then
  echo "ssh is required." >&2
  exit 1
fi

if [[ -t 0 ]]; then
  read -r -p "SSH user for ${SERVER_HOST} [${DEFAULT_SSH_USER}]: " SSH_USER_INPUT
  SSH_USER="${SSH_USER_INPUT:-${DEFAULT_SSH_USER}}"
else
  SSH_USER="${DEFAULT_SSH_USER}"
fi

SSH_TARGET="${SSH_USER}@${SERVER_HOST}"

case "${ACTION}" in
  logs)
    echo "Following logs for ${SERVICE_NAME} on ${SSH_TARGET}..."
    ssh -t "${SSH_TARGET}" "sudo journalctl -u '${SERVICE_NAME}' -f"
    ;;
  status)
    echo "Checking ${SERVICE_NAME} on ${SSH_TARGET}..."
    ssh -t "${SSH_TARGET}" "sudo systemctl status '${SERVICE_NAME}'"
    ;;
  *)
    echo "Running '${ACTION}' for ${SERVICE_NAME} on ${SSH_TARGET}..."
    ssh -t "${SSH_TARGET}" "sudo systemctl '${ACTION}' '${SERVICE_NAME}' && sudo systemctl status '${SERVICE_NAME}' --no-pager"
    ;;
esac
