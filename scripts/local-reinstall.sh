#!/usr/bin/env bash
# local-reinstall.sh — Uninstall, rebuild, package, and reinstall pilot from local source.
#
# Usage:
#   bash scripts/local-reinstall.sh              # full cycle: uninstall → build → package → install
#   bash scripts/local-reinstall.sh --skip-build # reuse existing dist/
#
# This script:
#   1. Backs up ~/.loongsuite-pilot/config.json
#   2. Uninstalls current pilot (--purge)
#   3. Builds and packages the local source
#   4. Installs from local tarball
#   5. Restores config.json
#   6. Starts the service

set -euo pipefail
cd "$(dirname "$0")/.."

SKIP_BUILD=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

CONFIG_FILE="$HOME/.loongsuite-pilot/config.json"
BACKUP_FILE="/tmp/loongsuite-pilot-config-backup-$(date +%s).json"
TARBALL="$(pwd)/loongsuite-pilot.tar.gz"

echo "==> Step 1: Backup config"
if [ -f "$CONFIG_FILE" ]; then
  cp "$CONFIG_FILE" "$BACKUP_FILE"
  echo "    Backed up to $BACKUP_FILE"
else
  echo "    No config found, skipping backup"
  BACKUP_FILE=""
fi

echo ""
echo "==> Step 2: Uninstall (--purge)"
bash deploy/installer.sh uninstall --purge 2>&1 | tail -5
echo ""

echo "==> Step 3: Build & Package"
if [ "$SKIP_BUILD" -eq 0 ]; then
  bash deploy/package.sh
else
  bash deploy/package.sh --skip-build
fi
echo ""

echo "==> Step 4: Install from local tarball"
bash deploy/installer.sh install --package-url "file://$TARBALL" || true
echo ""

echo "==> Step 5: Restore config"
if [ -n "$BACKUP_FILE" ] && [ -f "$BACKUP_FILE" ]; then
  cp "$BACKUP_FILE" "$CONFIG_FILE"
  echo "    Config restored from $BACKUP_FILE"
else
  echo "    No backup to restore"
fi

echo ""
echo "==> Step 6: Restart service with restored config"
loongsuite-pilot restart-collector 2>/dev/null || loongsuite-pilot start || true
sleep 2
loongsuite-pilot status || true

echo ""
echo "==> Done! Local reinstall complete."
echo "    To verify: loongsuite-pilot status"
echo "    To trigger test: qoder '你好'"
