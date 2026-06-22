#!/usr/bin/env bash
# Shared helpers for the Telegram Video Downloader scripts.

set -euo pipefail

# --- logging ---------------------------------------------------------------
if [ -t 1 ]; then
  C_RESET="\033[0m"; C_BLUE="\033[34m"; C_GREEN="\033[32m"; C_YELLOW="\033[33m"; C_RED="\033[31m"
else
  C_RESET=""; C_BLUE=""; C_GREEN=""; C_YELLOW=""; C_RED=""
fi

log()  { printf "${C_BLUE}[video]${C_RESET} %s\n" "$*"; }
ok()   { printf "${C_GREEN}[ok]${C_RESET} %s\n" "$*"; }
warn() { printf "${C_YELLOW}[warn]${C_RESET} %s\n" "$*"; }
err()  { printf "${C_RED}[err]${C_RESET} %s\n" "$*" >&2; }

# Read a single KEY=value from a dotenv file (last match wins). Does not export or eval.
read_env_var() {
  local key="${1:?}" file="${2:-.env}"
  if [ ! -f "$file" ]; then
    return 0
  fi
  grep -E "^${key}=" "$file" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r' || true
}
