#!/usr/bin/env bash
set -euo pipefail
# Usage: run-qemu.sh start|ssh|stop [--work-dir DIR] [-- COMMAND...]
exec python3 "$(dirname "${BASH_SOURCE[0]}")/qemu-env.py" "$@"
