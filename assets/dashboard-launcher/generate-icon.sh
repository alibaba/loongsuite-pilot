#!/bin/bash
# Developer-only conversion. End users receive AppIcon.icns in the release archive.
set -euo pipefail
PILOT_ICON_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PILOT_ICON_TMP="$(mktemp -d "${TMPDIR:-/tmp}/pilot-radar-icon.XXXXXX")"
trap 'rm -r -- "$PILOT_ICON_TMP"' EXIT
mkdir "$PILOT_ICON_TMP/AppIcon.iconset"
for size in 16 32 128 256 512; do
    /usr/bin/sips -z "$size" "$size" "$PILOT_ICON_DIR/radar-d4.png" --out "$PILOT_ICON_TMP/AppIcon.iconset/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    /usr/bin/sips -z "$double" "$double" "$PILOT_ICON_DIR/radar-d4.png" --out "$PILOT_ICON_TMP/AppIcon.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
/usr/bin/iconutil -c icns "$PILOT_ICON_TMP/AppIcon.iconset" -o "$PILOT_ICON_DIR/AppIcon.icns"
