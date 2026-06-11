#!/usr/bin/env bash
# rollout.sh — Manage canary rollout percentage or promote canary to stable
#
# Usage:
#   bash deploy/rollout.sh --percentage 5          # set rollout to 5%
#   bash deploy/rollout.sh --percentage 100        # full rollout (all clients get canary)
#   bash deploy/rollout.sh --percentage 0          # stop the bleed — pause canary
#   bash deploy/rollout.sh --promote               # promote canary to stable, remove canary field
#   bash deploy/rollout.sh --channel test-shimu     # operate on test channel
#   bash deploy/rollout.sh --external              # operate on external deploy target
#   bash deploy/rollout.sh --dry-run               # show what would happen
#
# Prerequisites:
#   - ossutil installed and configured
#   - A canary release must exist in latest.json (see upload.sh --canary)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Channel presets (mirror upload.sh) ──
_INNER_RELEASE_BUCKET="aliyun-observability-release-cn-shanghai"
_INNER_RELEASE_PREFIX="loongsuite/loongsuite-pilot"
_INNER_RELEASE_REGION="cn-shanghai"

_INNER_TEST_BUCKET="aliyun-observability-release-cn-shanghai"
_INNER_TEST_PREFIX="loongsuite-dev/loongsuite-pilot"
_INNER_TEST_REGION="cn-shanghai"

_EXT_RELEASE_BUCKET="aliyun-observability-release-cn-shanghai"
_EXT_RELEASE_PREFIX="loongsuite-pilot"
_EXT_RELEASE_REGION="cn-shanghai"

_EXT_TEST_BUCKET="aliyun-observability-release-cn-shanghai"
_EXT_TEST_PREFIX="loongsuite-pilot-dev"
_EXT_TEST_REGION="cn-shanghai"

DEPLOY_MODE="internal"
CHANNEL="${LOONGSUITE_PILOT_CHANNEL:-release}"
PERCENTAGE=""
PROMOTE=0
DRY_RUN=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --percentage)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --percentage requires a value" >&2; exit 1
            fi
            PERCENTAGE="$2"; shift 2 ;;
        --percentage=*)
            PERCENTAGE="${1#*=}"; shift ;;
        --promote)
            PROMOTE=1; shift ;;
        --channel)
            CHANNEL="$2"; shift 2 ;;
        --channel=*)
            CHANNEL="${1#*=}"; shift ;;
        --external)
            DEPLOY_MODE="external"; shift ;;
        --dry-run)
            DRY_RUN=1; shift ;;
        *)
            echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

# Validate: exactly one action
if [ -z "$PERCENTAGE" ] && [ "$PROMOTE" -eq 0 ]; then
    echo "❌ Specify --percentage N or --promote" >&2
    exit 1
fi
if [ -n "$PERCENTAGE" ] && [ "$PROMOTE" -eq 1 ]; then
    echo "❌ Cannot use --percentage and --promote together" >&2
    exit 1
fi

# Validate percentage range
if [ -n "$PERCENTAGE" ]; then
    if ! [[ "$PERCENTAGE" =~ ^[0-9]+$ ]] || [ "$PERCENTAGE" -lt 0 ] || [ "$PERCENTAGE" -gt 100 ]; then
        echo "❌ Percentage must be an integer between 0 and 100" >&2
        exit 1
    fi
fi

# Select presets based on deploy mode and channel
if [ "$DEPLOY_MODE" = "external" ]; then
    _RELEASE_BUCKET="$_EXT_RELEASE_BUCKET"
    _RELEASE_PREFIX="$_EXT_RELEASE_PREFIX"
    _RELEASE_REGION="$_EXT_RELEASE_REGION"
    _TEST_BUCKET="$_EXT_TEST_BUCKET"
    _TEST_PREFIX="$_EXT_TEST_PREFIX"
    _TEST_REGION="$_EXT_TEST_REGION"
else
    _RELEASE_BUCKET="$_INNER_RELEASE_BUCKET"
    _RELEASE_PREFIX="$_INNER_RELEASE_PREFIX"
    _RELEASE_REGION="$_INNER_RELEASE_REGION"
    _TEST_BUCKET="$_INNER_TEST_BUCKET"
    _TEST_PREFIX="$_INNER_TEST_PREFIX"
    _TEST_REGION="$_INNER_TEST_REGION"
fi

case "$CHANNEL" in
    release|prod)
        BUCKET="$_RELEASE_BUCKET"
        PREFIX="$_RELEASE_PREFIX"
        REGION="$_RELEASE_REGION"
        ;;
    test|pre)
        BUCKET="$_TEST_BUCKET"
        PREFIX="$_TEST_PREFIX"
        REGION="$_TEST_REGION"
        ;;
    test-*)
        if [[ "$CHANNEL" =~ ^test-[a-zA-Z0-9]+$ ]]; then
            BUCKET="$_TEST_BUCKET"
            if [ "$DEPLOY_MODE" = "external" ]; then
                PREFIX="loongsuite-pilot-dev/${CHANNEL}"
            else
                PREFIX="loongsuite-dev/${CHANNEL}/loongsuite-pilot"
            fi
            REGION="$_TEST_REGION"
        else
            echo "❌ Invalid format: requires a single suffix after 'test-'" >&2
            exit 1
        fi
        ;;
    *)
        echo "❌ Unknown channel: $CHANNEL (use 'release', 'test', or 'test-<name>')" >&2
        exit 1
        ;;
esac

OSS_BASE="oss://${BUCKET}/${PREFIX}"
PUBLIC_BASE="https://${BUCKET}.oss-${REGION}.aliyuncs.com/${PREFIX}"

# Validate ossutil
if ! command -v ossutil &>/dev/null; then
    echo "❌ ossutil not found. Install it first." >&2
    exit 1
fi

# ── Download existing latest.json ──
echo "==> Downloading latest.json..."
MANIFEST_TMP="$(mktemp)"
UPDATED_TMP=""
trap 'rm -f "$MANIFEST_TMP" "$UPDATED_TMP"' EXIT
ossutil cp "${OSS_BASE}/latest.json" "$MANIFEST_TMP" --force 2>/dev/null || true

if [ ! -s "$MANIFEST_TMP" ]; then
    echo "❌ Cannot fetch latest.json from ${OSS_BASE}/latest.json"
    exit 1
fi

# Verify canary field exists
HAS_CANARY=$(node -e "
    const m = JSON.parse(require('fs').readFileSync('$MANIFEST_TMP','utf8'));
    process.stdout.write(m.canary ? '1' : '0');
" 2>/dev/null || echo "0")

if [ "$HAS_CANARY" = "0" ]; then
    echo "❌ No canary field found in latest.json."
    echo "   Publish a canary first: bash deploy/upload.sh --canary --channel release"
    exit 1
fi

# Show current state
CURRENT_STATE=$(node -e "
    const m = JSON.parse(require('fs').readFileSync('$MANIFEST_TMP','utf8'));
    const c = m.canary;
    console.log('Stable:  v' + m.version);
    console.log('Canary:  v' + c.version + ' (hotfix=' + (c.hotfix_version || 0) + ')');
    console.log('Rollout: ' + c.rollout_percentage + '%');
" 2>/dev/null)
echo "$CURRENT_STATE"
echo ""

if [ "$PROMOTE" -eq 1 ]; then
    # ── Promote: copy canary fields to top-level, remove canary ──
    echo "==> Promoting canary to stable..."

    if [ "$DRY_RUN" -eq 1 ]; then
        node -e "
            const m = JSON.parse(require('fs').readFileSync('$MANIFEST_TMP','utf8'));
            console.log('[dry-run] Would promote canary v' + m.canary.version + ' to stable');
            console.log('[dry-run] Would remove canary field from latest.json');
        "
        exit 0
    fi

    read -r -p "Promote canary to stable? This replaces the current stable version. [y/N] " confirm
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 0
    fi

    UPDATED_TMP="$(mktemp)"
    node -e "
        const fs = require('fs');
        const m = JSON.parse(fs.readFileSync('$MANIFEST_TMP','utf8'));
        const c = m.canary;
        m.version = c.version;
        m.git_commit = c.git_commit;
        m.package_url = c.package_url;
        m.sha256 = c.sha256;
        m.released_at = c.released_at;
        delete m.canary;
        fs.writeFileSync('$UPDATED_TMP', JSON.stringify(m, null, 2) + '\n');
    "

    PROMOTED_VER=$(node -e "
        const m = JSON.parse(require('fs').readFileSync('$UPDATED_TMP','utf8'));
        process.stdout.write(m.version);
    ")
    PKG_NAME="loongsuite-pilot.tar.gz"

    ossutil cp "$UPDATED_TMP" "${OSS_BASE}/latest.json" --force
    ossutil cp "$UPDATED_TMP" "${OSS_BASE}/latest/latest.json" --force
    ossutil set-acl "${OSS_BASE}/latest.json" public-read 2>/dev/null || true
    ossutil set-acl "${OSS_BASE}/latest/latest.json" public-read 2>/dev/null || true

    # Copy canary package to latest/ so direct-download URLs stay consistent
    ossutil cp "${OSS_BASE}/${PROMOTED_VER}/${PKG_NAME}" "${OSS_BASE}/latest/${PKG_NAME}" --force
    ossutil set-acl "${OSS_BASE}/latest/${PKG_NAME}" public-read 2>/dev/null || true

    echo ""
    echo "============================================================"
    echo "✅ Canary promoted to stable!"
    echo "   Stable version is now: v${PROMOTED_VER}"
    echo "   Canary field removed from latest.json"
    echo "============================================================"
else
    # ── Set rollout percentage ──
    echo "==> Setting rollout_percentage to ${PERCENTAGE}%..."

    if [ "$DRY_RUN" -eq 1 ]; then
        echo "[dry-run] Would update canary.rollout_percentage to ${PERCENTAGE}"
        exit 0
    fi

    UPDATED_TMP="$(mktemp)"
    node -e "
        const fs = require('fs');
        const m = JSON.parse(fs.readFileSync('$MANIFEST_TMP','utf8'));
        m.canary.rollout_percentage = ${PERCENTAGE};
        fs.writeFileSync('$UPDATED_TMP', JSON.stringify(m, null, 2) + '\n');
    "

    ossutil cp "$UPDATED_TMP" "${OSS_BASE}/latest.json" --force
    ossutil cp "$UPDATED_TMP" "${OSS_BASE}/latest/latest.json" --force
    ossutil set-acl "${OSS_BASE}/latest.json" public-read 2>/dev/null || true
    ossutil set-acl "${OSS_BASE}/latest/latest.json" public-read 2>/dev/null || true

    echo ""
    echo "============================================================"
    echo "✅ Rollout percentage updated to ${PERCENTAGE}%"
    if [ "$PERCENTAGE" -eq 0 ]; then
        echo "   Canary is paused — no clients will receive it"
    elif [ "$PERCENTAGE" -eq 100 ]; then
        echo "   Full rollout — all clients will receive canary"
        echo "   When ready, promote with: bash deploy/rollout.sh --promote"
    else
        echo "   ~${PERCENTAGE}% of clients will receive canary"
    fi
    echo "============================================================"
fi
