#!/usr/bin/env bash
# Remote deploy steps (run on the server via scripts/deploy.sh).
# Expects: REMOTE_APP_DIR, SERVICE_NAME, DEPLOY_USER.

set -euo pipefail

: "${REMOTE_APP_DIR:?REMOTE_APP_DIR is required}"
: "${SERVICE_NAME:?SERVICE_NAME is required}"
: "${DEPLOY_USER:?DEPLOY_USER is required}"

cd "$REMOTE_APP_DIR"

SETTINGS_PATH="${REMOTE_APP_DIR}/config/settings.json"
SETTINGS_EXAMPLE="${REMOTE_APP_DIR}/config/settings.example.json"

# Reuse one sudo authentication for systemd steps (avoids repeated password prompts).
start_sudo_keepalive() {
  while true; do
    sudo -n true || exit
    sleep 50
    kill -0 "$$" || exit
  done 2>/dev/null &
  SUDO_KEEPALIVE_PID=$!
  trap 'kill "$SUDO_KEEPALIVE_PID" 2>/dev/null' EXIT
}

if ! sudo -n true 2>/dev/null; then
  if [ -n "${DEPLOY_PASSWORD:-}" ]; then
    printf '%s\n' "$DEPLOY_PASSWORD" | sudo -S -v
  else
    echo "[remote] sudo required for systemd setup (enter password once)..."
    sudo -v
  fi
  start_sudo_keepalive
fi

SETTINGS_SEEDED=false
if [ ! -f "$SETTINGS_PATH" ]; then
  echo "[remote] WARN: ${SETTINGS_PATH} is missing."
  if [ -f "$SETTINGS_EXAMPLE" ]; then
    mkdir -p "$(dirname "$SETTINGS_PATH")"
    cp "$SETTINGS_EXAMPLE" "$SETTINGS_PATH"
    SETTINGS_SEEDED=true
    echo "[remote] Created ${SETTINGS_PATH} from config/settings.example.json."
    echo "[remote] Edit it on the server before expecting the bot to work."
  else
    echo "[remote] ERROR: ${SETTINGS_EXAMPLE} is also missing."
    exit 1
  fi
fi

resolve_download_dir() {
  node - "$SETTINGS_PATH" "$REMOTE_APP_DIR" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const settingsPath = process.argv[2];
const appDir = process.argv[3];

try {
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const directory = settings?.download?.directory;
  if (typeof directory === "string" && directory.trim()) {
    const resolved = path.isAbsolute(directory)
      ? directory
      : path.resolve(appDir, directory);
    process.stdout.write(resolved);
  } else {
    process.stdout.write(path.join(appDir, "downloads"));
  }
} catch {
  process.stdout.write(path.join(appDir, "downloads"));
}
NODE
}

DOWNLOAD_DIR="$(resolve_download_dir)"
if [ "$SETTINGS_SEEDED" = true ]; then
  echo "[remote] WARN: using download directory ${DOWNLOAD_DIR} (seeded settings — update download.directory if needed)."
fi

echo "[remote] installing dependencies..."
npm ci || npm install

echo "[remote] building..."
npm run build

echo "[remote] installing systemd unit ${SERVICE_NAME}..."
TMP_UNIT="$(mktemp)"
sed -e "s#__USER__#${DEPLOY_USER}#g" \
    -e "s#__APP_DIR__#${REMOTE_APP_DIR}#g" \
    -e "s#__DOWNLOAD_DIR__#${DOWNLOAD_DIR}#g" \
    deploy/telegram-video-downloader.service > "$TMP_UNIT"
sudo cp "$TMP_UNIT" "/etc/systemd/system/${SERVICE_NAME}.service"
rm -f "$TMP_UNIT"

sudo systemctl daemon-reload
sudo systemctl enable "${SERVICE_NAME}"
sudo systemctl restart "${SERVICE_NAME}"

echo "[remote] service status:"
sudo systemctl --no-pager --full status "${SERVICE_NAME}" || true
echo "[remote] recent logs:"
sudo journalctl -u "${SERVICE_NAME}" -n 30 --no-pager || true
