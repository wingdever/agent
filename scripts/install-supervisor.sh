#!/usr/bin/env bash
# Register this project's channel runner with the VM's root supervisord.
#
# The VM already runs supervisord as root and includes conf files from
# /runtime/vm_supervisor/services/*.conf, so the least invasive way to keep the
# bot alive is to add one file there. This script is idempotent: it rewrites the
# file, then reread/update. Running it twice changes nothing.
#
# Requires passwordless sudo (verified on this host: `sudo -n id` -> uid=0).
# If that is not available, use scripts/channel-daemon.sh under an external
# supervisor instead (see docs/accounts/persistence.md §2).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF_DIR=/runtime/vm_supervisor/services
CONF_NAME=agent-channel.conf
INSTANCE="${CHANNEL_RUN_ID:-wing-bot}"
LOG_DIR="$ROOT/data/logs"

mkdir -p "$LOG_DIR"

CONF=$(cat <<EOF
[program:agent-channel]
command=/bin/bash $ROOT/scripts/channel-daemon.sh
user=user
directory=$ROOT
autostart=true
autorestart=true
startsecs=5
startretries=10
stopsignal=TERM
stopasgroup=true
killasgroup=true
stdout_logfile=$LOG_DIR/channel-run.log
stdout_logfile_maxbytes=10MB
stdout_logfile_backups=3
stderr_logfile=$LOG_DIR/channel-run.err.log
stderr_logfile_maxbytes=10MB
stderr_logfile_backups=3
EOF
)

echo "[install] writing $CONF_DIR/$CONF_NAME"
printf '%s\n' "$CONF" | sudo -n tee "$CONF_DIR/$CONF_NAME" >/dev/null
sudo -n chown root:root "$CONF_DIR/$CONF_NAME"
sudo -n chmod 600 "$CONF_DIR/$CONF_NAME"

echo "[install] reread + update"
sudo -n supervisorctl -c /etc/mcp-vm/supervisord.conf reread
sudo -n supervisorctl -c /etc/mcp-vm/supervisord.conf update

echo "[install] status"
sudo -n supervisorctl -c /etc/mcp-vm/supervisord.conf status agent-channel || true
