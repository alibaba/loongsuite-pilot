#!/usr/bin/env bash
# upload.sh — Upload tarball + aac-installer.sh to Alibaba Cloud OSS
#
# Prerequisites:
#   - ossutil installed (https://help.aliyun.com/document_detail/120075.html)
#     brew install ossutil   OR   pip install ossutil2
#   - OSS credentials configured:
#     ossutil config -e oss-cn-hangzhou.aliyuncs.com -i <AK_ID> -k <AK_SECRET>
#
# Usage:
#   bash deploy/upload.sh                          # use defaults
#   bash deploy/upload.sh --bucket my-bucket       # custom bucket
#   bash deploy/upload.sh --prefix custom/path     # custom OSS prefix
#   bash deploy/upload.sh --tarball /tmp/out.tar.gz  # custom tarball path
#   bash deploy/upload.sh --region cn-hangzhou     # custom region
#
# Environment variables (override CLI args):
#   OSS_BUCKET    — target bucket name
#   OSS_PREFIX    — key prefix in bucket
#   OSS_REGION    — region for the public URL

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Defaults ──
BUCKET="${OSS_BUCKET:-arms-apm-cn-hangzhou-pre}"
PREFIX="${OSS_PREFIX:-agenttrack}"
REGION="${OSS_REGION:-cn-hangzhou}"
TARBALL_PATH="$PROJECT_ROOT/ai-agent-collector.tar.gz"
INSTALLER_SCRIPT="$PROJECT_ROOT/deploy/aac-installer.sh"

while [[ $# -gt 0 ]]; do
    case "$1" in
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
        --tarball)
            TARBALL_PATH="$2"; shift 2 ;;
        --tarball=*)
            TARBALL_PATH="${1#*=}"; shift ;;
        *)
            echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

# ── Validate ──
if ! command -v ossutil &>/dev/null; then
    echo "❌ ossutil not found. Install it first:"
    echo "   brew install ossutil   OR   pip install ossutil2"
    echo "   Then configure: ossutil config -e oss-${REGION}.aliyuncs.com -i <AK_ID> -k <AK_SECRET>"
    exit 1
fi

if [ ! -f "$TARBALL_PATH" ]; then
    echo "❌ Tarball not found: $TARBALL_PATH"
    echo "   Run 'bash deploy/package.sh' first."
    exit 1
fi

if [ ! -f "$INSTALLER_SCRIPT" ]; then
    echo "❌ Installer script not found: $INSTALLER_SCRIPT"
    exit 1
fi

OSS_BASE="oss://${BUCKET}/${PREFIX}"
PUBLIC_BASE="https://${BUCKET}.oss-${REGION}.aliyuncs.com/${PREFIX}"

echo "==> Upload target"
echo "    Bucket:  $BUCKET"
echo "    Prefix:  $PREFIX"
echo "    Region:  $REGION"
echo ""

# ── Upload tarball ──
TARBALL_NAME="$(basename "$TARBALL_PATH")"
echo "==> Uploading tarball: $TARBALL_NAME"
ossutil cp "$TARBALL_PATH" "${OSS_BASE}/${TARBALL_NAME}" --force
echo "    ✅ Uploaded: ${PUBLIC_BASE}/${TARBALL_NAME}"
echo ""

# ── Upload installer script ──
INSTALLER_NAME="aac-installer.sh"
echo "==> Uploading installer: $INSTALLER_NAME"
ossutil cp "$INSTALLER_SCRIPT" "${OSS_BASE}/${INSTALLER_NAME}" --force
echo "    ✅ Uploaded: ${PUBLIC_BASE}/${INSTALLER_NAME}"
echo ""

# ── Set ACL to public-read ──
echo "==> Setting public-read ACL..."
ossutil set-acl "${OSS_BASE}/${TARBALL_NAME}" public-read 2>/dev/null || \
    echo "    ⚠️  Could not set ACL for tarball (may need bucket-level policy)"
ossutil set-acl "${OSS_BASE}/${INSTALLER_NAME}" public-read 2>/dev/null || \
    echo "    ⚠️  Could not set ACL for installer (may need bucket-level policy)"
echo ""

# ── Summary ──
TARBALL_SIZE=$(du -h "$TARBALL_PATH" | cut -f1)

echo "============================================================"
echo "✅ Upload complete!"
echo ""
echo "📦 Tarball  ($TARBALL_SIZE):"
echo "   ${PUBLIC_BASE}/${TARBALL_NAME}"
echo ""
echo "📜 Installer:"
echo "   ${PUBLIC_BASE}/${INSTALLER_NAME}"
echo ""
echo "One-line install:"
echo "   curl -fsSL ${PUBLIC_BASE}/${INSTALLER_NAME} | bash"
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
