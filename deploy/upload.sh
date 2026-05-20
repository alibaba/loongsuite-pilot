#!/usr/bin/env bash
# upload.sh — Upload package + loongsuite-pilot-installer.sh to Alibaba Cloud OSS
#
# Prerequisites:
#   - ossutil installed (https://help.aliyun.com/document_detail/120075.html)
#     brew install ossutil   OR   pip install ossutil2
#   - OSS credentials configured:
#     ossutil config -e oss-cn-hangzhou.aliyuncs.com -i <AK_ID> -k <AK_SECRET>
#
# Usage:
#   bash deploy/upload.sh                              # defaults to test channel
#   bash deploy/upload.sh --channel release            # upload to release path
#   bash deploy/upload.sh --channel test               # upload to test path (default)
#   bash deploy/upload.sh --channel test-<self>        # upload to test path (self dir)
#   bash deploy/upload.sh --bucket my-bucket           # custom bucket (overrides channel)
#   bash deploy/upload.sh --prefix custom/path         # custom OSS prefix
#   bash deploy/upload.sh --package /tmp/out.tar.gz    # custom package path
#   bash deploy/upload.sh --region cn-hangzhou         # custom region
#
# Environment variables (override CLI args):
#   LOONGSUITE_PILOT_CHANNEL   — release or test (default: test)
#   OSS_BUCKET    — target bucket name (overrides channel)
#   OSS_PREFIX    — key prefix in bucket (overrides channel)
#   OSS_REGION    — region for the public URL (overrides channel)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Channel presets ──
# release: production bucket, end-user facing
# test:    pre-release bucket, internal testing
_RELEASE_BUCKET="aliyun-observability-release-cn-shanghai"
_RELEASE_PREFIX="loongsuite/loongsuite-pilot"
_RELEASE_REGION="cn-shanghai"

_TEST_BUCKET="aliyun-observability-release-cn-shanghai"
_TEST_PREFIX="loongsuite-dev/loongsuite-pilot"
_TEST_REGION="cn-shanghai"

# ── Defaults (test channel is the safe default for dev) ──
CHANNEL="${LOONGSUITE_PILOT_CHANNEL:-test}"
BUCKET="${OSS_BUCKET:-}"
PREFIX="${OSS_PREFIX:-}"
REGION="${OSS_REGION:-}"
PKG_PATH="$PROJECT_ROOT/loongsuite-pilot.tar.gz"
INSTALLER_SCRIPT="$PROJECT_ROOT/deploy/loongsuite-pilot-installer.sh"
INSTALLER_INNER_SCRIPT="$PROJECT_ROOT/deploy/loongsuite-pilot-installer-inner.sh"
PATCHELF_SCRIPT="$PROJECT_ROOT/deploy/patchelf_node_for_7u.sh"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --channel)
            CHANNEL="$2"; shift 2 ;;
        --channel=*)
            CHANNEL="${1#*=}"; shift ;;
        --bucket)
            BUCKET="$2"; shift 2 ;;
        --bucket=*)
            BUCKET="${1#*=}"; shift ;;
        --prefix)
            PREFIX="$2"; shift 2 ;;
        --prefix=*)
            PREFIX="${1#*=}"; shift ;;
        --region)
            REGION="$2"; shift 2 ;;
        --region=*)
            REGION="${1#*=}"; shift ;;
        --package)
            PKG_PATH="$2"; shift 2 ;;
        --package=*)
            PKG_PATH="${1#*=}"; shift ;;
        *)
            echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

# Apply channel presets for any value not explicitly overridden
case "$CHANNEL" in
    release|prod)
        CHANNEL_CANONICAL="release"
        BUCKET="${BUCKET:-$_RELEASE_BUCKET}"
        PREFIX="${PREFIX:-$_RELEASE_PREFIX}"
        REGION="${REGION:-$_RELEASE_REGION}"
        ;;
    test|pre)
        CHANNEL_CANONICAL="test"
        BUCKET="${BUCKET:-$_TEST_BUCKET}"
        PREFIX="${PREFIX:-$_TEST_PREFIX}"
        REGION="${REGION:-$_TEST_REGION}"
        ;;
    test-*)
        # check test-suffix: test-taiye → prefix loongsuite-dev/test-taiye/loongsuite-pilot
        if [[ "$CHANNEL" =~ ^test-[a-zA-Z0-9]+$ ]]; then
            CHANNEL_CANONICAL="${CHANNEL}"
            BUCKET="${BUCKET:-$_TEST_BUCKET}"
            PREFIX="${PREFIX:-loongsuite-dev/${CHANNEL}/loongsuite-pilot}"
            REGION="${REGION:-$_TEST_REGION}"
        else
            echo "❌ Invalid format: requires a single suffix after 'test-'" >&2
            exit 1
        fi
        ;;
    *)
        echo "❌ Unknown channel: $CHANNEL (use 'release' or 'test')" >&2
        exit 1
        ;;
esac

# ── Validate ──
if ! command -v ossutil &>/dev/null; then
    echo "❌ ossutil not found. Install it first:"
    echo "   brew install ossutil   OR   pip install ossutil2"
    echo "   Then configure: ossutil config -e oss-${REGION}.aliyuncs.com -i <AK_ID> -k <AK_SECRET>"
    exit 1
fi

if [ ! -f "$PKG_PATH" ]; then
    echo "❌ Package not found: $PKG_PATH"
    echo "   Run 'bash deploy/package.sh' first."
    exit 1
fi

if [ ! -f "$INSTALLER_SCRIPT" ]; then
    echo "❌ Installer script not found: $INSTALLER_SCRIPT"
    exit 1
fi

if [ ! -f "$INSTALLER_INNER_SCRIPT" ]; then
    echo "❌ Inner installer script not found: $INSTALLER_INNER_SCRIPT"
    exit 1
fi

if [ ! -f "$PATCHELF_SCRIPT" ]; then
    echo "❌ Patchelf script not found: $PATCHELF_SCRIPT"
    exit 1
fi

OSS_BASE="oss://${BUCKET}/${PREFIX}"
PUBLIC_BASE="https://${BUCKET}.oss-${REGION}.aliyuncs.com/${PREFIX}"

# ── Extract version from package ──
PACKAGE_NAME="loongsuite-pilot"
PKG_NAME="$(basename "$PKG_PATH")"
VERSION_INFO=$(tar -xzf "$PKG_PATH" -O "${PACKAGE_NAME}/VERSION" 2>/dev/null || true)
PKG_VER=$(echo "$VERSION_INFO" | grep '^version=' | cut -d= -f2)
PKG_COMMIT=$(echo "$VERSION_INFO" | grep '^git_commit=' | cut -d= -f2)

if [ -z "$PKG_VER" ]; then
    echo "❌ Could not extract version from package. Ensure VERSION file exists."
    exit 1
fi

echo "==> Upload target"
echo "    Channel:  $CHANNEL"
echo "    Bucket:   $BUCKET"
echo "    Prefix:   $PREFIX"
echo "    Region:   $REGION"
echo "    Version:  $PKG_VER"
echo "    Commit:   ${PKG_COMMIT:-unknown}"
echo ""

# ── Helper: upload file, set ACL, print URL ──
upload_file() {
    local src="$1" dest="$2" label="$3"
    ossutil cp "$src" "$dest" --force
    ossutil set-acl "$dest" public-read 2>/dev/null || \
        echo "    ⚠️  Could not set ACL for $label (may need bucket-level policy)"
}

prepare_channel_installer() {
    local src="$1"
    local out
    out="$(mktemp)"
    sed "s#LOONGSUITE_PILOT_DEFAULT_CHANNEL:-release#LOONGSUITE_PILOT_DEFAULT_CHANNEL:-${CHANNEL_CANONICAL}#" "$src" > "$out"    
    chmod +x "$out"
    echo "$out"
}

# ── Generate manifest JSON ──
RELEASED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
PKG_SHA256="$(shasum -a 256 "$PKG_PATH" | cut -d' ' -f1)"
MANIFEST_TMP="$(mktemp)"
cat > "$MANIFEST_TMP" << MJSON
{
  "version": "${PKG_VER}",
  "git_commit": "${PKG_COMMIT}",
  "package_url": "${PUBLIC_BASE}/latest/${PKG_NAME}",
  "released_at": "${RELEASED_AT}",
  "sha256": "${PKG_SHA256}"
}
MJSON

# ── Upload to versioned path: <prefix>/<version>/ ──
echo "==> Uploading to versioned path: ${PREFIX}/${PKG_VER}/"
upload_file "$PKG_PATH"         "${OSS_BASE}/${PKG_VER}/${PKG_NAME}" "versioned package"
echo "    ✅ ${PUBLIC_BASE}/${PKG_VER}/${PKG_NAME}"
upload_file "$MANIFEST_TMP"     "${OSS_BASE}/${PKG_VER}/latest.json" "versioned manifest"
echo "    ✅ ${PUBLIC_BASE}/${PKG_VER}/latest.json"
echo ""

# ── Upload to latest path: <prefix>/latest/ ──
echo "==> Uploading to latest path: ${PREFIX}/latest/"
upload_file "$PKG_PATH"         "${OSS_BASE}/latest/${PKG_NAME}"     "latest package"
echo "    ✅ ${PUBLIC_BASE}/latest/${PKG_NAME}"
upload_file "$MANIFEST_TMP"     "${OSS_BASE}/latest/latest.json"     "latest manifest"
echo "    ✅ ${PUBLIC_BASE}/latest/latest.json"
echo ""

# ── Upload root-level latest.json (for backward compat & quick version check) ──
echo "==> Uploading root latest.json"
upload_file "$MANIFEST_TMP"     "${OSS_BASE}/latest.json"            "root manifest"
echo "    ✅ ${PUBLIC_BASE}/latest.json"
rm -f "$MANIFEST_TMP"
echo ""

# ── Upload installer scripts (version-independent, stays at prefix root) ──
INSTALLER_NAME="loongsuite-pilot-installer.sh"
INSTALLER_INNER_NAME="loongsuite-pilot-installer-inner.sh"
PATCHELF_NAME="patchelf_node_for_7u.sh"
echo "==> Uploading installers: $INSTALLER_NAME, $INSTALLER_INNER_NAME, $PATCHELF_NAME"
INSTALLER_UPLOAD="$(prepare_channel_installer "$INSTALLER_SCRIPT")"
INSTALLER_INNER_UPLOAD="$(prepare_channel_installer "$INSTALLER_INNER_SCRIPT")"
trap 'rm -f "$MANIFEST_TMP" "$INSTALLER_UPLOAD" "$INSTALLER_INNER_UPLOAD"' EXIT
upload_file "$INSTALLER_UPLOAD"       "${OSS_BASE}/${INSTALLER_NAME}"       "installer"
echo "    ✅ ${PUBLIC_BASE}/${INSTALLER_NAME}"
upload_file "$INSTALLER_INNER_UPLOAD" "${OSS_BASE}/${INSTALLER_INNER_NAME}" "installer-inner"
echo "    ✅ ${PUBLIC_BASE}/${INSTALLER_INNER_NAME}"
upload_file "$PATCHELF_SCRIPT"        "${OSS_BASE}/${PATCHELF_NAME}"        "patchelf-script"
echo "    ✅ ${PUBLIC_BASE}/${PATCHELF_NAME}"
echo ""

# ── Summary ──
PKG_SIZE=$(du -h "$PKG_PATH" | cut -f1)

echo "============================================================"
echo "✅ Upload complete!  Version: ${PKG_VER}"
echo ""
echo "📦 Versioned package ($PKG_SIZE):"
echo "   ${PUBLIC_BASE}/${PKG_VER}/${PKG_NAME}"
echo ""
echo "📦 Latest package:"
echo "   ${PUBLIC_BASE}/latest/${PKG_NAME}"
echo ""
echo "📜 Installer:"
echo "   ${PUBLIC_BASE}/${INSTALLER_NAME}"
echo ""
echo "Install (latest):"
echo "   curl -fsSL ${PUBLIC_BASE}/${INSTALLER_NAME} | bash"
echo ""
echo "Install specific version:"
echo "   curl -fsSL ${PUBLIC_BASE}/${INSTALLER_NAME} | bash -s -- install --version ${PKG_VER}"
echo ""
echo "Install with SLS backend:"
echo "   curl -fsSL ${PUBLIC_BASE}/${INSTALLER_NAME} | bash -s -- install \\"
echo "     --sls-endpoint \"cn-hangzhou.log.aliyuncs.com\" \\"
echo "     --sls-project \"your-project\" \\"
echo "     --sls-logstore \"your-logstore\" \\"
echo "     --sls-ak-id \"your-ak-id\" \\"
echo "     --sls-ak-secret \"your-ak-secret\""
echo ""
echo "Upgrade:"
echo "   curl -fsSL ${PUBLIC_BASE}/${INSTALLER_NAME} | bash -s -- upgrade"
echo ""
echo "Uninstall:"
echo "   curl -fsSL ${PUBLIC_BASE}/${INSTALLER_NAME} | bash -s -- uninstall"
echo "============================================================"
