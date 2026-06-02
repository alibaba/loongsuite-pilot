#!/usr/bin/env bash
# release.sh — Bump version (from git tags), update package.json, tag, build & upload
#
# Usage:
#   bash deploy/release.sh                    # patch bump, internal, release channel
#   bash deploy/release.sh --minor            # minor bump (1.0.x → 1.1.0)
#   bash deploy/release.sh --major            # major bump (1.x.x → 2.0.0)
#   bash deploy/release.sh --version 1.2.3    # explicit version
#   bash deploy/release.sh --external         # external deploy mode
#   bash deploy/release.sh --dry-run          # show what would happen, don't execute
#
# The script will:
#   1. Determine next version from git tags (or use --version)
#   2. Update package.json
#   3. Commit & tag
#   4. Build (package.sh)
#   5. Upload (upload.sh)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

BUMP_TYPE="patch"
EXPLICIT_VERSION=""
DEPLOY_MODE=""
DRY_RUN=0
SKIP_UPLOAD=0
UPLOAD_ARGS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --patch)          BUMP_TYPE="patch"; shift ;;
        --minor)          BUMP_TYPE="minor"; shift ;;
        --major)          BUMP_TYPE="major"; shift ;;
        --version)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --version requires a value" >&2; exit 1
            fi
            EXPLICIT_VERSION="$2"; shift 2 ;;
        --version=*)      EXPLICIT_VERSION="${1#*=}"; shift ;;
        --external)       DEPLOY_MODE="external"; shift ;;
        --dry-run)        DRY_RUN=1; shift ;;
        --skip-upload)    SKIP_UPLOAD=1; shift ;;
        *)
            echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

cd "$PROJECT_ROOT"

# ── Ensure working tree is clean ──
if [ -n "$(git status --porcelain)" ]; then
    echo "❌ Working tree is not clean. Please commit or stash changes first."
    git status --short
    exit 1
fi

# ── Determine current version from git tags ──
get_latest_version_from_tags() {
    git fetch origin --prune --prune-tags --quiet 2>/dev/null || true
    local latest
    latest=$(git tag -l 'v*' --sort=-v:refname | head -1 | sed 's/^v//')
    if [ -z "$latest" ]; then
        # Fallback: read from package.json if no tags exist yet
        latest=$(node -e "process.stdout.write(require('./package.json').version)")
    fi
    echo "$latest"
}

# ── Bump version ──
bump_version() {
    local current="$1" type="$2"
    local major minor patch
    IFS='.' read -r major minor patch <<< "$current"
    case "$type" in
        major) echo "$((major + 1)).0.0" ;;
        minor) echo "${major}.$((minor + 1)).0" ;;
        patch) echo "${major}.${minor}.$((patch + 1))" ;;
    esac
}

# ── Validate semver format ──
validate_semver() {
    if [[ ! "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "❌ Invalid version format: $1 (expected X.Y.Z)" >&2
        exit 1
    fi
}

# ── Resolve next version ──
CURRENT_VERSION=$(get_latest_version_from_tags)

if [ -n "$EXPLICIT_VERSION" ]; then
    NEXT_VERSION="$EXPLICIT_VERSION"
else
    NEXT_VERSION=$(bump_version "$CURRENT_VERSION" "$BUMP_TYPE")
fi

validate_semver "$NEXT_VERSION"

echo "==> Version"
echo "    Current: ${CURRENT_VERSION}"
echo "    Next:    ${NEXT_VERSION} (${BUMP_TYPE})"
echo ""

if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] Would update package.json: ${CURRENT_VERSION} → ${NEXT_VERSION}"
    echo "[dry-run] Would commit and tag: v${NEXT_VERSION}"
    echo "[dry-run] Would build and upload (channel=release, mode=${DEPLOY_MODE:-internal})"
    exit 0
fi

# ── Confirm ──
read -r -p "Proceed with release v${NEXT_VERSION}? [y/N] " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
fi

# ── Update package.json ──
echo "==> Updating package.json..."
NEXT_VERSION="$NEXT_VERSION" node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = process.env.NEXT_VERSION;
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
echo "    ✅ package.json → ${NEXT_VERSION}"

# ── Commit & Tag ──
echo "==> Committing and tagging..."
git add package.json
if git diff --cached --quiet; then
    echo "    ⏭️  No changes to commit (version already ${NEXT_VERSION})"
else
    git commit -m "release: v${NEXT_VERSION}"
fi
if git rev-parse "v${NEXT_VERSION}" >/dev/null 2>&1; then
    echo "    ⏭️  Tag v${NEXT_VERSION} already exists"
else
    git tag -a "v${NEXT_VERSION}" -m "Release v${NEXT_VERSION}"
    echo "    ✅ Tagged v${NEXT_VERSION}"
fi

# ── Build ──
echo ""
bash "$SCRIPT_DIR/package.sh"

# ── Upload ──
if [ "$SKIP_UPLOAD" -eq 1 ]; then
    echo ""
    echo "==> Skipping upload (--skip-upload)"
else
    echo ""
    UPLOAD_ARGS+=(--channel release)
    if [ -n "$DEPLOY_MODE" ]; then
        UPLOAD_ARGS+=("--${DEPLOY_MODE}")
    fi
    bash "$SCRIPT_DIR/upload.sh" "${UPLOAD_ARGS[@]}"
fi

# ── Push commit and tag to remote ──
echo ""
echo "==> Pushing to remote..."
git push origin HEAD "v${NEXT_VERSION}"
echo "    ✅ Pushed commit and tag v${NEXT_VERSION}"

# ── Done ──
echo ""
echo "============================================================"
echo "✅ Release v${NEXT_VERSION} complete!"
echo ""
echo "   Tag:     v${NEXT_VERSION}"
echo "   Channel: release"
echo "   Mode:    ${DEPLOY_MODE:-internal}"
echo ""
echo "   To see all releases: git tag -l 'v*' --sort=-v:refname"
echo "============================================================"
