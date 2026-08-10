#!/usr/bin/env bash
# package-node-deps.sh — Build the OSS artifacts that installer.sh / installer.ps1
# download at install time (managed Node.js runtime + prebuilt node_modules).
#
# It produces, under a staging directory (default: dist/node-deps/):
#
#   node/<node-version>/
#       node-v<ver>-darwin-arm64.tar.gz
#       node-v<ver>-darwin-x64.tar.gz
#       node-v<ver>-linux-x64.tar.gz
#       node-v<ver>-linux-arm64.tar.gz
#       node-v<ver>-win-x64.zip
#       SHASUMS256.txt              # official nodejs.org sums, filtered to the 5 tarballs
#
#   node-modules/<app-version>/
#       node-modules-<os>-<arch>.tar.gz   # built for THIS machine's platform only
#       SHASUMS256.txt                    # merged: keeps other platforms' entries if present
#
# The layout mirrors the installer's download keys:
#   <NODE_DEPS_BASE>/<node-version>/node-v<ver>-<os>-<arch>.<ext>
#   <NODE_MODULES_BASE>/<app-version>/node-modules-<os>-<arch>.tar.gz
#
# node_modules is inherently per-platform (native addons are compiled against a
# specific OS/arch/ABI), so this script only builds the current machine's tarball.
# Run it once per target platform (a CI matrix) and point every run at the SAME
# --out directory: the node-modules SHASUMS256.txt is merged, so entries for
# already-built platforms are preserved.
#
# Usage:
#   bash deploy/package-node-deps.sh                       # both runtime + modules
#   bash deploy/package-node-deps.sh --skip-node-runtime   # only prebuilt node_modules
#   bash deploy/package-node-deps.sh --skip-node-modules   # only mirror the node runtime
#   bash deploy/package-node-deps.sh --node-version 22.22.2
#   bash deploy/package-node-deps.sh --app-version 1.2.0
#   bash deploy/package-node-deps.sh --out /tmp/node-deps
#
# Then upload with:  bash deploy/upload-node-deps.sh --dir dist/node-deps

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

NODE_VERSION="${LOONGSUITE_PILOT_NODE_VERSION:-22.22.2}"
NODE_UPSTREAM_URL="${NODE_UPSTREAM_URL:-https://nodejs.org/dist}"
APP_VERSION=""
OUT_DIR="$PROJECT_ROOT/dist/node-deps"
SKIP_NODE_RUNTIME=0
SKIP_NODE_MODULES=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --node-version)   NODE_VERSION="$2"; shift 2 ;;
        --node-version=*) NODE_VERSION="${1#*=}"; shift ;;
        --app-version)    APP_VERSION="$2"; shift 2 ;;
        --app-version=*)  APP_VERSION="${1#*=}"; shift ;;
        --out)            OUT_DIR="$2"; shift 2 ;;
        --out=*)          OUT_DIR="${1#*=}"; shift ;;
        --skip-node-runtime)  SKIP_NODE_RUNTIME=1; shift ;;
        --skip-node-modules)  SKIP_NODE_MODULES=1; shift ;;
        -h|--help)
            sed -n '2,40p' "${BASH_SOURCE[0]}"; exit 0 ;;
        *)
            echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

# ── Platform detection (must match installer's managed_node_platform) ──
detect_platform() {
    local os arch
    case "$(uname -s)" in
        Darwin) os="darwin" ;;
        Linux)  os="linux" ;;
        MINGW*|MSYS*|CYGWIN*) os="win" ;;
        *) echo "❌ Unsupported platform: $(uname -s)" >&2; return 1 ;;
    esac
    case "$(uname -m)" in
        arm64|aarch64) arch="arm64" ;;
        x86_64|amd64)  arch="x64" ;;
        *) echo "❌ Unsupported architecture: $(uname -m)" >&2; return 1 ;;
    esac
    echo "$os $arch"
}

sha256_of() {
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        sha256sum "$1" | awk '{print $1}'
    fi
}

# Rewrite (or add) a "<sha256>  <name>" line for $name in the shasums file $file,
# preserving entries for other files so a CI matrix can accumulate platforms.
merge_shasum() {
    local file="$1" name="$2" sum="$3"
    local tmp; tmp="$(mktemp)"
    if [ -f "$file" ]; then
        grep -v "  ${name}\$" "$file" > "$tmp" 2>/dev/null || true
    fi
    echo "${sum}  ${name}" >> "$tmp"
    sort -k2 "$tmp" -o "$tmp"
    mv "$tmp" "$file"
}

# ── The 5 supported node runtime artifacts (matches the installer matrix) ──
NODE_TARBALLS=(
    "node-v${NODE_VERSION}-darwin-arm64.tar.gz"
    "node-v${NODE_VERSION}-darwin-x64.tar.gz"
    "node-v${NODE_VERSION}-linux-x64.tar.gz"
    "node-v${NODE_VERSION}-linux-arm64.tar.gz"
    "node-v${NODE_VERSION}-win-x64.zip"
)

mirror_node_runtime() {
    local dest="$OUT_DIR/node/${NODE_VERSION}"
    mkdir -p "$dest"
    echo "==> Mirroring managed Node.js v${NODE_VERSION} -> $dest"

    local upstream_sums="$dest/SHASUMS256.upstream.txt"
    curl -fsSL "${NODE_UPSTREAM_URL}/v${NODE_VERSION}/SHASUMS256.txt" -o "$upstream_sums"

    : > "$dest/SHASUMS256.txt"
    local tarball dst expected actual
    for tarball in "${NODE_TARBALLS[@]}"; do
        dst="$dest/$tarball"
        expected=$(grep "  ${tarball}\$" "$upstream_sums" | awk '{print $1}' | head -1)
        if [ -z "$expected" ]; then
            echo "  ❌ upstream SHASUMS256.txt has no entry for $tarball" >&2
            exit 1
        fi
        if [ -f "$dst" ] && [ "$(sha256_of "$dst")" = "$expected" ]; then
            echo "  ✓ cached: $tarball"
        else
            echo "  ↓ download: $tarball"
            curl -fL --progress-bar "${NODE_UPSTREAM_URL}/v${NODE_VERSION}/$tarball" -o "$dst"
            actual=$(sha256_of "$dst")
            if [ "$expected" != "$actual" ]; then
                echo "  ❌ checksum mismatch for $tarball (expected $expected, got $actual)" >&2
                exit 1
            fi
            echo "    sha256 OK"
        fi
        # Emit the official-format line the installer greps for.
        echo "${expected}  ${tarball}" >> "$dest/SHASUMS256.txt"
    done
    rm -f "$upstream_sums"
    sort -k2 "$dest/SHASUMS256.txt" -o "$dest/SHASUMS256.txt"
    echo "    ✅ Node runtime mirrored ($(ls "$dest"/node-v* | wc -l | tr -d ' ') artifacts)"
}

# Locate a node/npm to build node_modules with. Prefer the mirrored managed
# runtime for the current platform so native addons match the runtime that will
# actually execute them; fall back to system node with a version warning.
build_node_bin() {
    local os="$1" arch="$2"
    local runtime_tar="$OUT_DIR/node/${NODE_VERSION}/node-v${NODE_VERSION}-${os}-${arch}.tar.gz"
    if [ "$os" != "win" ] && [ -f "$runtime_tar" ]; then
        local extract_dir="$OUT_DIR/.buildnode"
        local node_dir="$extract_dir/node-v${NODE_VERSION}-${os}-${arch}"
        if [ ! -x "$node_dir/bin/node" ]; then
            mkdir -p "$extract_dir"
            tar -xzf "$runtime_tar" -C "$extract_dir"
        fi
        if [ -x "$node_dir/bin/node" ]; then
            echo "$node_dir/bin/node"
            return 0
        fi
    fi
    if command -v node >/dev/null 2>&1; then
        local sys_major; sys_major=$(node -e "process.stdout.write(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)
        local want_major="${NODE_VERSION%%.*}"
        if [ "$sys_major" != "$want_major" ]; then
            echo "  ⚠️  building node_modules with system node v$(node --version | sed 's/^v//') but runtime targets v${NODE_VERSION}" >&2
            echo "     native addon ABI may not match; prefer building with node v${want_major}.x" >&2
        fi
        command -v node
        return 0
    fi
    return 1
}

build_node_modules() {
    local tuple os arch
    tuple=$(detect_platform) || exit 1
    os="${tuple% *}"; arch="${tuple#* }"

    local app_version="$APP_VERSION"
    if [ -z "$app_version" ]; then
        app_version=$(node -e "process.stdout.write(require('$PROJECT_ROOT/package.json').version)" 2>/dev/null || echo "")
    fi
    if [ -z "$app_version" ]; then
        echo "❌ Could not determine app version. Pass --app-version." >&2
        exit 1
    fi

    local dest="$OUT_DIR/node-modules/${app_version}"
    mkdir -p "$dest"
    echo "==> Building prebuilt node_modules for ${os}-${arch} (app v${app_version})"

    local node_bin; node_bin=$(build_node_bin "$os" "$arch") || {
        echo "❌ No node available to build node_modules." >&2
        exit 1
    }
    local npm_bin="$(dirname "$node_bin")/npm"
    [ -x "$npm_bin" ] || npm_bin="$(command -v npm)"
    echo "    using node: $node_bin ($("$node_bin" --version))"

    # Install prod deps into a clean staging tree seeded with the exact manifest
    # the deployed app carries (package.json + lockfile), so node_modules matches
    # what npm install would have produced in PERMANENT_DIR.
    local build_dir; build_dir="$(mktemp -d)"
    trap 'rm -rf "$build_dir"' RETURN
    cp "$PROJECT_ROOT/package.json" "$build_dir/"
    cp "$PROJECT_ROOT/package-lock.json" "$build_dir/" 2>/dev/null || true
    cp "$PROJECT_ROOT/.npmrc" "$build_dir/" 2>/dev/null || true

    (
        cd "$build_dir"
        export PATH="$(dirname "$node_bin"):$PATH"
        if [ -f package-lock.json ]; then
            "$npm_bin" ci --omit=dev --omit=optional
        else
            "$npm_bin" install --omit=dev --omit=optional --no-package-lock
        fi
    )

    if [ ! -d "$build_dir/node_modules" ]; then
        echo "❌ npm produced no node_modules/" >&2
        exit 1
    fi

    local archive="node-modules-${os}-${arch}.tar.gz"
    echo "==> Packing $archive"
    tar -czf "$dest/$archive" -C "$build_dir" node_modules

    local sum; sum=$(sha256_of "$dest/$archive")
    merge_shasum "$dest/SHASUMS256.txt" "$archive" "$sum"
    local size; size=$(du -h "$dest/$archive" | cut -f1)
    echo "    ✅ $archive ($size)  sha256=$sum"
}

# ── Run ──
mkdir -p "$OUT_DIR"

if [ "$SKIP_NODE_RUNTIME" -eq 0 ]; then
    mirror_node_runtime
    echo ""
fi

if [ "$SKIP_NODE_MODULES" -eq 0 ]; then
    build_node_modules
    echo ""
fi

# ── Summary ──
echo "============================================================"
echo "✅ node-deps staged under: $OUT_DIR"
echo ""
find "$OUT_DIR" -type f ! -name '*.upstream.txt' | sed "s#^$OUT_DIR/#   #" | sort
echo ""
echo "Upload with:"
echo "   bash deploy/upload-node-deps.sh --dir $OUT_DIR"
echo "============================================================"
