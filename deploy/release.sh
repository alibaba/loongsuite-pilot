#!/usr/bin/env bash
# release.sh — Bump version (from git tags), update package.json, tag, build & upload
#
# Usage:
#   bash deploy/release.sh                    # patch bump, internal, release channel
#   bash deploy/release.sh --patch            # same as default (explicit patch bump)
#   bash deploy/release.sh --minor            # minor bump (1.0.x → 1.1.0)
#   bash deploy/release.sh --major            # major bump (1.x.x → 2.0.0)
#   bash deploy/release.sh --version 1.2.3    # explicit version
#   bash deploy/release.sh --canary            # canary release (灰度发布)
#   bash deploy/release.sh --canary --hotfix  # canary hotfix (bump hotfix_version only)
#   bash deploy/release.sh --external         # external deploy mode
#   bash deploy/release.sh --dry-run          # show what would happen, don't execute
#   bash deploy/release.sh --skip-upload      # build only, skip OSS upload
#
# Flow:
#   1. Fetch latest tags from remote
#   2. Determine next version
#   3. Create release/<version> branch from origin/master
#   4. Bump package.json, commit, tag
#   5. Build (package.sh) & Upload (upload.sh)
#   6. Push branch + tag to remote
#   7. Print CR creation hint

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

BUMP_TYPE="patch"
EXPLICIT_VERSION=""
DEPLOY_MODE=""
DRY_RUN=0
SKIP_UPLOAD=0
CANARY=0
HOTFIX=0
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
        --canary)          CANARY=1; shift ;;
        --hotfix)          HOTFIX=1; shift ;;
        --external)       DEPLOY_MODE="external"; shift ;;
        --dry-run)        DRY_RUN=1; shift ;;
        --skip-upload)    SKIP_UPLOAD=1; shift ;;
        *)
            echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

cd "$PROJECT_ROOT"

# ── Validate canary/hotfix combination ──
if [ "$HOTFIX" -eq 1 ] && [ "$CANARY" -eq 0 ]; then
    echo "❌ --hotfix can only be used with --canary"
    exit 1
fi

# ── Ensure working tree is clean ──
if [ -n "$(git status --porcelain)" ]; then
    echo "❌ Working tree is not clean. Please commit or stash changes first."
    git status --short
    exit 1
fi

# ── Fetch latest state from remote ──
echo "==> Fetching from remote..."
git fetch origin --prune --prune-tags --quiet
echo "    ✅ Synced tags and branches"

# ── Determine current version from git tags ──
get_latest_version_from_tags() {
    local latest
    latest=$(git tag -l 'v*' --sort=-v:refname | head -1 | sed 's/^v//')
    if [ -z "$latest" ]; then
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

if [ "$CANARY" -eq 1 ] && [ "$HOTFIX" -eq 1 ]; then
    # Hotfix mode: keep current canary version, no bump
    NEXT_VERSION="$CURRENT_VERSION"
elif [ -n "$EXPLICIT_VERSION" ]; then
    NEXT_VERSION="$EXPLICIT_VERSION"
else
    NEXT_VERSION=$(bump_version "$CURRENT_VERSION" "$BUMP_TYPE")
fi

validate_semver "$NEXT_VERSION"

RELEASE_BRANCH="release/v${NEXT_VERSION}"

RELEASE_TYPE="stable"
if [ "$CANARY" -eq 1 ] && [ "$HOTFIX" -eq 1 ]; then
    RELEASE_TYPE="canary-hotfix"
elif [ "$CANARY" -eq 1 ]; then
    RELEASE_TYPE="canary"
fi

echo "==> Version"
echo "    Current: ${CURRENT_VERSION}"
echo "    Next:    ${NEXT_VERSION} (${BUMP_TYPE})"
echo "    Type:    ${RELEASE_TYPE}"
echo "    Branch:  ${RELEASE_BRANCH}"
echo ""

if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] Would create branch: ${RELEASE_BRANCH} from origin/master"
    echo "[dry-run] Would update package.json: ${CURRENT_VERSION} → ${NEXT_VERSION}"
    echo "[dry-run] Would commit and tag: v${NEXT_VERSION}"
    echo "[dry-run] Would build and upload (channel=release, type=${RELEASE_TYPE}, mode=${DEPLOY_MODE:-internal})"
    echo "[dry-run] Would push branch + tag, then prompt to create CR → master"
    exit 0
fi

# ── Confirm ──
read -r -p "Proceed with ${RELEASE_TYPE} release v${NEXT_VERSION}? [y/N] " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
fi

# ── Create release branch from origin/master ──
echo "==> Creating release branch..."
if git show-ref --verify --quiet "refs/heads/${RELEASE_BRANCH}"; then
    echo "    Branch ${RELEASE_BRANCH} already exists locally, switching to it"
    git checkout "${RELEASE_BRANCH}"
else
    git checkout -b "${RELEASE_BRANCH}" origin/master
fi
echo "    ✅ On branch ${RELEASE_BRANCH}"

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
if [ "$DEPLOY_MODE" = "external" ]; then
    bash "$SCRIPT_DIR/package.sh" --external
else
    bash "$SCRIPT_DIR/package.sh"
fi

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
    if [ "$CANARY" -eq 1 ]; then
        UPLOAD_ARGS+=(--canary)
    fi
    if [ "$HOTFIX" -eq 1 ]; then
        UPLOAD_ARGS+=(--hotfix)
    fi
    bash "$SCRIPT_DIR/upload.sh" "${UPLOAD_ARGS[@]}"
fi

# ── Push branch and tag to remote ──
echo ""
echo "==> Pushing to remote..."
git push origin "${RELEASE_BRANCH}" "v${NEXT_VERSION}" -u
echo "    ✅ Pushed branch ${RELEASE_BRANCH} and tag v${NEXT_VERSION}"

# ── Done ──
echo ""
echo "============================================================"
echo "✅ Release v${NEXT_VERSION} complete!"
echo ""
echo "   Tag:     v${NEXT_VERSION}"
echo "   Branch:  ${RELEASE_BRANCH}"
echo "   Channel: release"
echo "   Type:    ${RELEASE_TYPE}"
echo "   Mode:    ${DEPLOY_MODE:-internal}"
echo ""
if [ "$CANARY" -eq 1 ]; then
    echo "   Next step: adjust rollout percentage"
    echo "   Run: bash deploy/rollout.sh --percentage 5"
else
    echo "   Next step: create CR to merge ${RELEASE_BRANCH} → master"
    echo "   Run: claude /submit-cr"
fi
echo "============================================================"
