#!/usr/bin/env bash
# package-external.sh — Build external variant (no built-in SLS destination)
#
# Usage:
#   bash deploy/package-external.sh                       # default output
#   bash deploy/package-external.sh -o /tmp/out.tar.gz    # custom output path
#   bash deploy/package-external.sh --skip-build          # skip tsc, use existing dist/

exec bash "$(dirname "${BASH_SOURCE[0]}")/package.sh" --external "$@"
