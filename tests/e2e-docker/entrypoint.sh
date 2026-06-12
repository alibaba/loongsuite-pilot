#!/usr/bin/env bash
set -euo pipefail

# Start dbus (needed by systemd user sessions)
if [ -x /usr/bin/dbus-daemon ] && [ ! -e /run/dbus/pid ]; then
  sudo mkdir -p /run/dbus
  sudo dbus-daemon --system --fork 2>/dev/null || true
fi

# Enable systemd user linger for testuser so user services start without login
sudo loginctl enable-linger testuser 2>/dev/null || true

# Run the e2e test script (already running as testuser via Dockerfile USER)
exec node /opt/e2e/"${E2E_RUNNER_SCRIPT:-run-docker-e2e.mjs}"
