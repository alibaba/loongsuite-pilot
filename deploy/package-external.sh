#!/usr/bin/env bash
# DEPRECATED: There is no longer a separate external build variant.
# Use package.sh directly — it produces a unified build.
# The internal/external distinction is now a runtime config, not a build-time flag.

echo "⚠️  package-external.sh is deprecated. Use 'bash deploy/package.sh' instead." >&2
exec bash "$(dirname "${BASH_SOURCE[0]}")/package.sh" "$@"
