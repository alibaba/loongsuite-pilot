#!/usr/bin/env bash
set -euo pipefail

# Start dbus (needed by systemd user sessions)
if [ -x /usr/bin/dbus-daemon ] && [ ! -e /run/dbus/pid ]; then
  mkdir -p /run/dbus
  dbus-daemon --system --fork 2>/dev/null || true
fi

# Enable systemd user linger for testuser so user services start without login
loginctl enable-linger testuser 2>/dev/null || true

# Switch to testuser and run the e2e test script
exec sudo -u testuser --preserve-env \
  env HOME=/home/testuser \
  PATH="/home/testuser/.local/bin:/usr/local/bin:/usr/bin:/bin" \
  node /opt/e2e/"${E2E_RUNNER_SCRIPT:-run-docker-e2e.mjs}"
