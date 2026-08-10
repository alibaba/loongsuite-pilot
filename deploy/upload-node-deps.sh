#!/usr/bin/env bash
# upload-node-deps.sh — Upload the managed-node-runtime + prebuilt node_modules
# artifacts (staged by package-node-deps.sh) to Alibaba Cloud OSS.
#
# It uploads, preserving the layout the installers download from:
#   dist/node-deps/node/<ver>/*          -> oss://<bucket>/<node-prefix>/<ver>/
#   dist/node-deps/node-modules/<ver>/*  -> oss://<bucket>/<modules-prefix>/<ver>/
#
# The default bucket/prefixes match the shared opensource defaults baked into
# installer.sh / installer.ps1:
#   NODE_DEPS_BASE    = loongsuite-pilot/deps/node
#   NODE_MODULES_BASE = loongsuite-pilot/deps/node-modules
#   bucket            = aliyun-observability-release-cn-shanghai (cn-shanghai)
#
# Prerequisites:
#   - ossutil installed and configured (see deploy/upload.sh header)
#
# Usage:
#   bash deploy/upload-node-deps.sh                       # upload dist/node-deps
#   bash deploy/upload-node-deps.sh --dir /tmp/node-deps  # custom staging dir
#   bash deploy/upload-node-deps.sh --dry-run             # print, do NOT upload
#   bash deploy/upload-node-deps.sh --skip-node-runtime   # only node_modules
#   bash deploy/upload-node-deps.sh --skip-node-modules   # only node runtime
#   bash deploy/upload-node-deps.sh --bucket my-bucket --region cn-shanghai
#   bash deploy/upload-node-deps.sh --node-prefix loongsuite-pilot/deps/node --modules-prefix loongsuite-pilot/deps/node-modules
#
# Environment variables (override defaults; same names the installers honor):
#   OSS_BUCKET                        — target bucket
#   OSS_REGION                        — region for the public URL
#   LOONGSUITE_PILOT_NODE_DEPS_URL    — full base URL for node runtime (informational)
#   LOONGSUITE_PILOT_NODE_MODULES_URL — full base URL for node_modules (informational)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DIR="$PROJECT_ROOT/dist/node-deps"
BUCKET="${OSS_BUCKET:-aliyun-observability-release-cn-shanghai}"
REGION="${OSS_REGION:-cn-shanghai}"
NODE_PREFIX="loongsuite-pilot/deps/node"
MODULES_PREFIX="loongsuite-pilot/deps/node-modules"
DRY_RUN=0
SKIP_NODE_RUNTIME=0
SKIP_NODE_MODULES=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dir)             DIR="$2"; shift 2 ;;
        --dir=*)           DIR="${1#*=}"; shift ;;
        --bucket)          BUCKET="$2"; shift 2 ;;
        --bucket=*)        BUCKET="${1#*=}"; shift ;;
        --region)          REGION="$2"; shift 2 ;;
        --region=*)        REGION="${1#*=}"; shift ;;
        --node-prefix)     NODE_PREFIX="$2"; shift 2 ;;
        --node-prefix=*)   NODE_PREFIX="${1#*=}"; shift ;;
        --modules-prefix)  MODULES_PREFIX="$2"; shift 2 ;;
        --modules-prefix=*) MODULES_PREFIX="${1#*=}"; shift ;;
        --dry-run)         DRY_RUN=1; shift ;;
        --skip-node-runtime)  SKIP_NODE_RUNTIME=1; shift ;;
        --skip-node-modules)  SKIP_NODE_MODULES=1; shift ;;
        -h|--help)
            sed -n '2,34p' "${BASH_SOURCE[0]}"; exit 0 ;;
        *)
            echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

# ── Validate ──
if [ "$DRY_RUN" -eq 0 ] && ! command -v ossutil &>/dev/null; then
    echo "❌ ossutil not found. Install it first:"
    echo "   brew install ossutil   OR   pip install ossutil2"
    echo "   Then configure: ossutil config -e oss-${REGION}.aliyuncs.com -i <AK_ID> -k <AK_SECRET>"
    exit 1
fi

if [ ! -d "$DIR" ]; then
    echo "❌ Staging dir not found: $DIR"
    echo "   Run 'bash deploy/package-node-deps.sh' first."
    exit 1
fi

PUBLIC_BASE="https://${BUCKET}.oss-${REGION}.aliyuncs.com"

echo "==> Upload node-deps"
echo "    Source:   $DIR"
echo "    Bucket:   $BUCKET"
echo "    Region:   $REGION"
echo "    Node:     oss://${BUCKET}/${NODE_PREFIX}/"
echo "    Modules:  oss://${BUCKET}/${MODULES_PREFIX}/"
if [ "$DRY_RUN" -eq 1 ]; then
    echo "    Mode:     DRY-RUN (nothing will be uploaded)"
fi
echo ""

# ── Helper: upload a file, set public-read ACL, print URL ──
upload_file() {
    local src="$1" dest="$2" label="$3"
    if [ "$DRY_RUN" -eq 1 ]; then
        echo "    [dry-run] $src"
        echo "           -> $dest"
        return 0
    fi
    ossutil cp "$src" "$dest" --force
    ossutil set-acl "$dest" public-read 2>/dev/null || \
        echo "    ⚠️  Could not set ACL for $label (may need bucket-level policy)"
}

# Upload every file under $subdir/<ver>/ to oss://<bucket>/<prefix>/<ver>/
upload_tree() {
    local subdir="$1" prefix="$2" what="$3"
    local base="$DIR/$subdir"
    if [ ! -d "$base" ]; then
        echo "==> Skipping $what: $base not found"
        echo ""
        return 0
    fi
    local ver_dir ver f name dest
    for ver_dir in "$base"/*/; do
        [ -d "$ver_dir" ] || continue
        ver="$(basename "$ver_dir")"
        echo "==> Uploading $what v${ver} -> oss://${BUCKET}/${prefix}/${ver}/"
        for f in "$ver_dir"*; do
            [ -f "$f" ] || continue
            name="$(basename "$f")"
            # Skip intermediate upstream sums that package-node-deps.sh may leave.
            case "$name" in
                *.upstream.txt) continue ;;
            esac
            dest="oss://${BUCKET}/${prefix}/${ver}/${name}"
            upload_file "$f" "$dest" "$what/$name"
            echo "    ✅ ${PUBLIC_BASE}/${prefix}/${ver}/${name}"
        done
        echo ""
    done
}

if [ "$SKIP_NODE_RUNTIME" -eq 0 ]; then
    upload_tree "node" "$NODE_PREFIX" "node runtime"
fi

if [ "$SKIP_NODE_MODULES" -eq 0 ]; then
    upload_tree "node-modules" "$MODULES_PREFIX" "node_modules"
fi

echo "============================================================"
if [ "$DRY_RUN" -eq 1 ]; then
    echo "✅ Dry-run complete — no objects were uploaded."
    echo "   Re-run without --dry-run to publish."
else
    echo "✅ node-deps upload complete."
    echo ""
    echo "Installers will resolve these automatically. To pin/override:"
    echo "   export LOONGSUITE_PILOT_NODE_DEPS_URL=${PUBLIC_BASE}/${NODE_PREFIX}"
    echo "   export LOONGSUITE_PILOT_NODE_MODULES_URL=${PUBLIC_BASE}/${MODULES_PREFIX}"
fi
echo "============================================================"
