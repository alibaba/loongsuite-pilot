#!/usr/bin/env bash
# upload-external.sh — Upload to external OSS path (loongsuite-pilot/)
#
# Usage:
#   bash deploy/upload-external.sh                        # test channel (default)
#   bash deploy/upload-external.sh --channel release      # release channel
#   bash deploy/upload-external.sh --channel test-taiye   # personal test channel

exec bash "$(dirname "${BASH_SOURCE[0]}")/upload.sh" --external "$@"
