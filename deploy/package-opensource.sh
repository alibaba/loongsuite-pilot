#!/usr/bin/env bash
# package-opensource.sh — Build the project and create distributable packages
#
# Produces both .tar.gz (Linux/macOS) and .zip (Windows) packages.
# Internal-only and updater files are stripped automatically.
#
# Usage:
#   bash deploy/package-opensource.sh                       # default output
#   bash deploy/package-opensource.sh -o /tmp/out.tar.gz    # custom .tar.gz path
#   bash deploy/package-opensource.sh --skip-build          # skip build, use existing dist/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PACKAGE_NAME="loongsuite-pilot"
OUTPUT_PATH=""
SKIP_BUILD=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        -o|--output)
            OUTPUT_PATH="$2"; shift 2 ;;
        --skip-build)
            SKIP_BUILD=1; shift ;;
        *)
            echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

if [ -z "$OUTPUT_PATH" ]; then
    OUTPUT_PATH="$PROJECT_ROOT/$PACKAGE_NAME.tar.gz"
fi
ZIP_OUTPUT_PATH="${OUTPUT_PATH%.tar.gz}.zip"

cd "$PROJECT_ROOT"

# ── Build ──
if [ "$SKIP_BUILD" -eq 0 ]; then
    echo "==> Building..."
    rm -rf dist
    npm run build
    echo "    ✅ Build complete"
else
    echo "==> Skipping build (--skip-build)"
    if [ ! -d dist ]; then
        echo "❌ dist/ not found. Run 'npm run build' first or remove --skip-build."
        exit 1
    fi
fi

# ── Stage files into a temp directory ──
STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT

PKG_DIR="$STAGE_DIR/$PACKAGE_NAME"
mkdir -p "$PKG_DIR"

echo "==> Generating VERSION file..."
PKG_VERSION=$(node -e "process.stdout.write(require('./package.json').version)")
GIT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
BUILD_TIME=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

cat > VERSION << VEOF
version=${PKG_VERSION}
git_commit=${GIT_COMMIT}
git_branch=${GIT_BRANCH}
build_time=${BUILD_TIME}
VEOF
echo "    ✅ VERSION: v${PKG_VERSION} (${GIT_COMMIT}, ${BUILD_TIME})"

echo "==> Staging files..."

# Core distributable dirs
cp -r dist     "$PKG_DIR/dist"
cp -r assets   "$PKG_DIR/assets"
cp -r scripts  "$PKG_DIR/scripts"

# Agent definition files (declarative deployment configs)
if [ -d agents.d ]; then
    cp -r agents.d "$PKG_DIR/agents.d"
    echo "    ✅ Agent definitions bundled: $(ls agents.d/*.json 2>/dev/null | wc -l | tr -d ' ') files"
fi

# Plugin tarballs (pre-built, bundled)
if [ -d plugins ] && ls plugins/*.tar.gz &>/dev/null; then
    cp -r plugins  "$PKG_DIR/plugins"
    echo "    ✅ Plugins bundled: $(ls plugins/*.tar.gz | xargs -I{} basename {} | tr '\n' ' ')"
fi

# Status bar app (macOS native binary + Swift source)
if [ -d app/macos-status-bar ]; then
    mkdir -p "$PKG_DIR/app/macos-status-bar"
    cp -r app/macos-status-bar/Sources "$PKG_DIR/app/macos-status-bar/Sources"
    cp app/macos-status-bar/Package.swift "$PKG_DIR/app/macos-status-bar/"
    # Include pre-built binaries if available
    if [ -d app/macos-status-bar/bin ]; then
        cp -r app/macos-status-bar/bin "$PKG_DIR/app/macos-status-bar/bin"
        echo "    ✅ Status bar app bundled (with pre-built binary)"
    else
        echo "    ✅ Status bar app bundled (source only, will build on install)"
    fi
fi

# Package metadata & version
cp package.json      "$PKG_DIR/"
cp package-lock.json "$PKG_DIR/" 2>/dev/null || true
cp .npmrc            "$PKG_DIR/" 2>/dev/null || true
cp README.md         "$PKG_DIR/" 2>/dev/null || true
cp VERSION           "$PKG_DIR/"

# Ensure scripts are executable
chmod +x "$PKG_DIR/scripts/"*.sh 2>/dev/null || true
chmod +x "$PKG_DIR/assets/hooks/"*.sh 2>/dev/null || true

# Strip internal-only files (always for opensource)
rm -f "$PKG_DIR/scripts/migrate-internal-config.js"
rm -f "$PKG_DIR/scripts/updater-daemon.js"
echo "    ✅ Stripped internal-only files"

echo "    ✅ Staged into $PKG_DIR"

# ── Create .tar.gz (Linux/macOS) ──
echo "==> Creating .tar.gz package..."
tar -czf "$OUTPUT_PATH" -C "$STAGE_DIR" "$PACKAGE_NAME"

PKG_SIZE=$(du -h "$OUTPUT_PATH" | cut -f1)
echo "    ✅ $OUTPUT_PATH ($PKG_SIZE)"

# ── Create .zip (Windows) ──
echo "==> Creating .zip package..."
if command -v zip >/dev/null 2>&1 && [ "${LOONGSUITE_PILOT_FORCE_NODE_ZIP:-0}" != "1" ]; then
    (cd "$STAGE_DIR" && zip -qr "$ZIP_OUTPUT_PATH" "$PACKAGE_NAME")
else
    echo "    zip command not found; using Node.js zip fallback"
    node - "$PKG_DIR" "$ZIP_OUTPUT_PATH" <<'NODEZIP'
const fs = require('fs');
const path = require('path');

const root = process.argv[2];
const output = process.argv[3];
const base = path.dirname(root);

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i += 1) {
  let c = i;
  for (let k = 0; k < 8; k += 1) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[i] = c >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

function walk(absPath, entries) {
  const stat = fs.lstatSync(absPath);
  const relPath = path.relative(base, absPath).split(path.sep).join('/');
  if (stat.isDirectory()) {
    entries.push({ absPath, relPath: `${relPath}/`, stat, data: Buffer.alloc(0), isDirectory: true });
    for (const child of fs.readdirSync(absPath).sort()) {
      walk(path.join(absPath, child), entries);
    }
    return;
  }
  if (stat.isFile()) {
    entries.push({ absPath, relPath, stat, data: fs.readFileSync(absPath), isDirectory: false });
  }
}

const entries = [];
walk(root, entries);

const chunks = [];
const centralDirectory = [];
let offset = 0;

for (const entry of entries) {
  const name = Buffer.from(entry.relPath, 'utf8');
  const { time, date } = dosDateTime(entry.stat.mtime);
  const crc = entry.isDirectory ? 0 : crc32(entry.data);
  const size = entry.data.length;
  const localOffset = offset;
  const mode = ((entry.stat.mode & 0xffff) << 16) >>> 0;
  const flags = 0x0800;

  const localHeader = Buffer.concat([
    u32(0x04034b50),
    u16(10),
    u16(flags),
    u16(0),
    u16(time),
    u16(date),
    u32(crc),
    u32(size),
    u32(size),
    u16(name.length),
    u16(0),
    name,
  ]);
  chunks.push(localHeader, entry.data);
  offset += localHeader.length + entry.data.length;

  centralDirectory.push(Buffer.concat([
    u32(0x02014b50),
    u16(0x031e),
    u16(10),
    u16(flags),
    u16(0),
    u16(time),
    u16(date),
    u32(crc),
    u32(size),
    u32(size),
    u16(name.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(mode),
    u32(localOffset),
    name,
  ]));
}

const centralOffset = offset;
const centralBuffer = Buffer.concat(centralDirectory);
const end = Buffer.concat([
  u32(0x06054b50),
  u16(0),
  u16(0),
  u16(entries.length),
  u16(entries.length),
  u32(centralBuffer.length),
  u32(centralOffset),
  u16(0),
]);

fs.writeFileSync(output, Buffer.concat([...chunks, centralBuffer, end]));
NODEZIP
fi

ZIP_SIZE=$(du -h "$ZIP_OUTPUT_PATH" | cut -f1)
echo "    ✅ $ZIP_OUTPUT_PATH ($ZIP_SIZE)"

# ── Summary ──
echo ""
echo "==> Contents:"
tar -tzf "$OUTPUT_PATH" | sed -n '1,20p'
echo "    ... (truncated)"
echo ""
echo "Done."
