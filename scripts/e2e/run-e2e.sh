#!/usr/bin/env bash
# Unified E2E test runner — loads env from .env.e2e and dispatches to docker or ssh mode.
#
# Usage:
#   ./scripts/e2e/run-e2e.sh [docker|ssh] [scenario]
#
# Examples:
#   ./scripts/e2e/run-e2e.sh docker install-smoke
#   ./scripts/e2e/run-e2e.sh docker preflight
#   ./scripts/e2e/run-e2e.sh ssh install-smoke
#   ./scripts/e2e/run-e2e.sh docker                  # uses E2E_SCENARIO from .env.e2e
#
# Environment file: .env.e2e (project root, gitignored)
#   Copy .env.e2e.example to .env.e2e and fill in your values.

set -euo pipefail
cd "$(dirname "$0")/../.."

ENV_FILE=".env.e2e"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found."
  echo "Copy .env.e2e.example to .env.e2e and fill in your values:"
  echo "  cp .env.e2e.example .env.e2e"
  exit 1
fi

# Load env file (skip comments and empty lines)
set -a
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%%#*}"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [ -z "$line" ] && continue
  eval "$line"
done < "$ENV_FILE"
set +a

# CLI overrides
MODE="${1:-docker}"
if [ -n "${2:-}" ]; then
  export E2E_SCENARIO="$2"
fi

echo "=== E2E Test Runner ==="
echo "Mode:     $MODE"
echo "Scenario: ${E2E_SCENARIO:-preflight}"
echo "User ID:  ${E2E_USER_ID:-<not set>}"
echo "========================"
echo ""

case "$MODE" in
  docker)
    if [ "${E2E_LOCAL_BUILD:-0}" = "1" ]; then
      echo "[e2e] Local build mode: running npm run build..."
      npm run build
    fi
    # Stop any leftover container from previous keep-alive run
    docker compose -f tests/e2e-docker/docker-compose.yml down -v 2>/dev/null || true
    exec npm run test:e2e:docker
    ;;
  ssh)
    exec npm run test:e2e:remote
    ;;
  *)
    echo "ERROR: Unknown mode '$MODE'. Use 'docker' or 'ssh'."
    exit 1
    ;;
esac
