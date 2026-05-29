#!/usr/bin/env bash
# upload-inner.sh — Upload to internal OSS path (loongsuite/loongsuite-pilot/)
#
# Usage:
#   bash deploy/upload-inner.sh                        # test channel (default)
#   bash deploy/upload-inner.sh --channel release      # release channel
#   bash deploy/upload-inner.sh --channel test-taiye   # personal test channel

exec bash "$(dirname "${BASH_SOURCE[0]}")/upload.sh" "$@"
