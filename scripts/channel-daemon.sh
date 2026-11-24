#!/usr/bin/env bash
# Supervisor entry for the inbound channel runner.
#
# Why a wrapper instead of putting node in the supervisor config: the app secret
# must not live in a config file that any tool can print. This script reads it
# from user/channel-daemon.env (0600, git-ignored) and execs the runner, so
# supervisord only ever sees a command line without credentials.
#
# Exit code is passed through untouched: supervisord's autorestart decides what
# to do, and this script must not pretend a failed start was fine.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${CHANNEL_DAEMON_ENV:-$ROOT/user/channel-daemon.env}"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

if [ -z "${CHANNEL_WING_BOT_APPSECRET:-}" ]; then
  echo "[daemon] CHANNEL_WING_BOT_APPSECRET is missing (looked in $ENV_FILE)" >&2
  exit 78 # EX_CONFIG: do not spin on autorestart for a configuration problem
fi

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "[daemon] node not found (set NODE_BIN)" >&2
  exit 78
fi

cd "$ROOT"
exec "$NODE_BIN" "$ROOT/channel-run.js" --channel "${CHANNEL_RUN_ID:-wing-bot}"
