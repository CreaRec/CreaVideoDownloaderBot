#!/usr/bin/env bash
set -euo pipefail

SERVER_HOST="${SERVER_HOST:-192.168.1.135}"
DEFAULT_SSH_USER="${SSH_USER:-crearec}"
REMOTE_APP_DIR="${REMOTE_APP_DIR:-/home/crearec/crea-video-downloader-bot}"
SERVICE_NAME="${SERVICE_NAME:-telegram-video-downloader}"
NODE_MAJOR_VERSION="${NODE_MAJOR_VERSION:-22}"
NODE_MIN_VERSION="${NODE_MIN_VERSION:-22.9.0}"
NPM_VERSION="${NPM_VERSION:-11.16.0}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

read -r -p "SSH user for ${SERVER_HOST} [${DEFAULT_SSH_USER}]: " SSH_USER_INPUT
SSH_USER="${SSH_USER_INPUT:-${DEFAULT_SSH_USER}}"
SSH_TARGET="${SSH_USER}@${SERVER_HOST}"

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

if ! command_exists npm; then
  echo "npm is required locally before deploying." >&2
  exit 1
fi

if ! command_exists ssh || ! command_exists scp; then
  echo "ssh and scp are required locally before deploying." >&2
  exit 1
fi

cd "${PROJECT_ROOT}"

echo "Installing local dependencies..."
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi

echo "Running tests locally..."
npm test

echo "Building locally..."
npm run build

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

ARCHIVE_BASENAME="telegram-video-downloader-$(date +%Y%m%d%H%M%S).tar.gz"
ARCHIVE_PATH="${TMP_DIR}/${ARCHIVE_BASENAME}"
INSTALLER_BASENAME="telegram-video-downloader-install-$(date +%Y%m%d%H%M%S).sh"
INSTALLER_PATH="${TMP_DIR}/${INSTALLER_BASENAME}"
REMOTE_ARCHIVE="/tmp/${ARCHIVE_BASENAME}"
REMOTE_INSTALLER="/tmp/${INSTALLER_BASENAME}"

echo "Creating release archive..."
tar \
  --exclude=".git" \
  --exclude="./.git" \
  --exclude="node_modules" \
  --exclude="./node_modules" \
  --exclude="config/settings.json" \
  --exclude="./config/settings.json" \
  --exclude="*.log" \
  --exclude=".DS_Store" \
  -czf "${ARCHIVE_PATH}" \
  .

cat >"${INSTALLER_PATH}" <<'REMOTE_INSTALLER_SCRIPT'
#!/usr/bin/env bash
set -euo pipefail

ARCHIVE_PATH="$1"
REMOTE_APP_DIR="$2"
SERVICE_NAME="$3"
NODE_MAJOR_VERSION="$4"
NPM_VERSION="$5"
NODE_MIN_VERSION="$6"
SERVICE_USER="$(id -un)"
SERVICE_GROUP="$(id -gn)"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

run_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

require_safe_app_dir() {
  case "${REMOTE_APP_DIR}" in
    /home/*/*) ;;
    *)
      echo "Refusing to deploy to unsafe REMOTE_APP_DIR: ${REMOTE_APP_DIR}" >&2
      exit 1
      ;;
  esac
}

version_is_older_than() {
  local current_version="$1"
  local target_version="$2"

  node -e '
    const current = process.argv[1].split(".").map(Number);
    const target = process.argv[2].split(".").map(Number);

    for (let i = 0; i < target.length; i += 1) {
      const currentPart = current[i] || 0;
      const targetPart = target[i] || 0;

      if (currentPart < targetPart) process.exit(0);
      if (currentPart > targetPart) process.exit(1);
    }

    process.exit(1);
  ' "${current_version}" "${target_version}"
}

npm_is_healthy() {
  local npm_cli
  local npm_dir

  command -v npm >/dev/null 2>&1 || return 1
  npm --version >/dev/null 2>&1 || return 1

  npm_cli="$(readlink -f "$(command -v npm)")"
  npm_dir="$(cd "$(dirname "${npm_cli}")/.." && pwd)"

  node - "${npm_dir}" <<'NODE'
const { createRequire } = require("module");
const path = require("path");
const npmDir = process.argv[2];

try {
  const requireFromNpm = createRequire(path.join(npmDir, "package.json"));
  requireFromNpm(path.join(npmDir, "node_modules/@npmcli/arborist/lib/arborist/rebuild.js"));
} catch {
  process.exit(1);
}
NODE
}

install_npm_version() {
  local npm_archive="/tmp/npm-${NPM_VERSION}.tgz"
  local npm_extract_dir="/tmp/npm-${NPM_VERSION}"

  echo "Installing npm ${NPM_VERSION}..."
  run_root apt-get update
  run_root apt-get install -y ca-certificates curl tar
  rm -rf "${npm_extract_dir}"
  mkdir -p "${npm_extract_dir}"
  curl -fsSL "https://registry.npmjs.org/npm/-/npm-${NPM_VERSION}.tgz" -o "${npm_archive}"
  tar -xzf "${npm_archive}" --strip-components=1 -C "${npm_extract_dir}"

  run_root rm -rf /usr/lib/node_modules/npm
  run_root mkdir -p /usr/lib/node_modules/npm
  run_root cp -R "${npm_extract_dir}/." /usr/lib/node_modules/npm/
  run_root ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/bin/npm
  run_root ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/bin/npx
  rm -rf "${npm_extract_dir}" "${npm_archive}"

  if ! npm_is_healthy || [[ "$(npm --version)" != "${NPM_VERSION}" ]]; then
    echo "npm ${NPM_VERSION} installation failed." >&2
    exit 1
  fi
}

install_node_and_npm_if_needed() {
  local node_version=""
  local npm_version=""

  if command -v node >/dev/null 2>&1; then
    node_version="$(node --version | sed 's/^v//')"
  fi

  if [[ -z "${node_version}" ]] || version_is_older_than "${node_version}" "${NODE_MIN_VERSION}"; then
    echo "Installing Node.js ${NODE_MAJOR_VERSION}..."
    run_root apt-get update
    run_root apt-get install -y ca-certificates curl
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR_VERSION}.x" -o "/tmp/nodesource_setup_${NODE_MAJOR_VERSION}.sh"
    run_root bash "/tmp/nodesource_setup_${NODE_MAJOR_VERSION}.sh"
    run_root apt-get install -y nodejs
  fi

  if npm_is_healthy; then
    npm_version="$(npm --version)"
  fi

  if [[ -z "${npm_version}" ]] || version_is_older_than "${npm_version}" "${NPM_VERSION}"; then
    install_npm_version
  fi
}

install_app_files() {
  local parent_dir
  local staging_dir
  local settings_backup=""

  parent_dir="$(dirname "${REMOTE_APP_DIR}")"
  staging_dir="$(mktemp -d)"

  if [[ -f "${REMOTE_APP_DIR}/config/settings.json" ]]; then
    settings_backup="$(mktemp)"
    cp "${REMOTE_APP_DIR}/config/settings.json" "${settings_backup}"
  fi

  tar -xzf "${ARCHIVE_PATH}" -C "${staging_dir}"

  mkdir -p "${staging_dir}/config"
  if [[ -n "${settings_backup}" ]]; then
    cp "${settings_backup}" "${staging_dir}/config/settings.json"
  elif [[ -f "${staging_dir}/config/settings.example.json" ]]; then
    cp "${staging_dir}/config/settings.example.json" "${staging_dir}/config/settings.json"
    echo "Created config/settings.json from the example. Edit it before first start if needed."
  fi

  mkdir -p "${parent_dir}"
  rm -rf "${REMOTE_APP_DIR}"
  mv "${staging_dir}" "${REMOTE_APP_DIR}"

  if [[ -n "${settings_backup}" ]]; then
    rm -f "${settings_backup}"
  fi
}

install_production_dependencies() {
  cd "${REMOTE_APP_DIR}"

  if [[ -f package-lock.json ]]; then
    npm ci --omit=dev
  else
    npm install --omit=dev
  fi
}

install_systemd_service() {
  local service_tmp
  service_tmp="$(mktemp)"

  cat >"${service_tmp}" <<SERVICE_UNIT
[Unit]
Description=Telegram Video Downloader
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_GROUP}
WorkingDirectory=${REMOTE_APP_DIR}
Environment=NODE_ENV=production
Environment=SETTINGS_PATH=${REMOTE_APP_DIR}/config/settings.json
ExecStart=/usr/bin/node ${REMOTE_APP_DIR}/dist/index.js
Restart=on-failure
RestartSec=10
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
SERVICE_UNIT

  run_root install -m 0644 "${service_tmp}" "${SERVICE_FILE}"
  rm -f "${service_tmp}"

  run_root systemctl daemon-reload
  run_root systemctl enable "${SERVICE_NAME}"
  run_root systemctl restart "${SERVICE_NAME}"
}

require_safe_app_dir
install_node_and_npm_if_needed
install_app_files
install_production_dependencies
install_systemd_service
rm -f "${ARCHIVE_PATH}" "$0"

echo
echo "Deployment complete."
echo "Status: sudo systemctl status ${SERVICE_NAME}"
echo "Logs:   sudo journalctl -u ${SERVICE_NAME} -f"
REMOTE_INSTALLER_SCRIPT

chmod +x "${INSTALLER_PATH}"

echo "Uploading release to ${SSH_TARGET}..."
scp "${ARCHIVE_PATH}" "${INSTALLER_PATH}" "${SSH_TARGET}:/tmp/"

echo "Installing on ${SERVER_HOST}..."
ssh -t "${SSH_TARGET}" "bash '${REMOTE_INSTALLER}' '${REMOTE_ARCHIVE}' '${REMOTE_APP_DIR}' '${SERVICE_NAME}' '${NODE_MAJOR_VERSION}' '${NPM_VERSION}' '${NODE_MIN_VERSION}'"
