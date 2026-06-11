#!/usr/bin/env bash
# package-inner.sh — Build and package (delegates to package.sh)
#
# Usage:
#   bash deploy/package-inner.sh                       # default output
#   bash deploy/package-inner.sh -o /tmp/out.tar.gz    # custom output path
#   bash deploy/package-inner.sh --skip-build          # skip build, use existing dist/

BUILD_TYPE=internal exec bash "$(dirname "${BASH_SOURCE[0]}")/package.sh" "$@"
