#!/usr/bin/env bash
# package-inner.sh — Build internal variant (with built-in SLS destination)
#
# Usage:
#   bash deploy/package-inner.sh                       # default output
#   bash deploy/package-inner.sh -o /tmp/out.tar.gz    # custom output path
#   bash deploy/package-inner.sh --skip-build          # skip tsc, use existing dist/

exec bash "$(dirname "${BASH_SOURCE[0]}")/package.sh" "$@"
