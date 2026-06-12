#!/usr/bin/env bash
# release-opensource.sh — Bump version, tag, and push. CI creates the GitHub Release.
#
# Usage:
#   bash deploy/release-opensource.sh                    # patch bump
#   bash deploy/release-opensource.sh --patch            # same as default
#   bash deploy/release-opensource.sh --minor            # minor bump (1.0.x → 1.1.0)
#   bash deploy/release-opensource.sh --major            # major bump (1.x.x → 2.0.0)
#   bash deploy/release-opensource.sh --version 1.2.3    # explicit version
#   bash deploy/release-opensource.sh --dry-run          # show what would happen
#
# Flow:
#   1. Fetch latest tags from remote
#   2. Determine next version
#   3. Create release/<version> branch from origin/master
#   4. Bump package.json, commit, tag
#   5. Push branch + tag to remote
#   6. GitHub Actions (release.yml) picks up the tag → build, package, create Release

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

BUMP_TYPE="patch"
EXPLICIT_VERSION=""
DRY_RUN=0

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
        --dry-run)        DRY_RUN=1; shift ;;
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

if [ -n "$EXPLICIT_VERSION" ]; then
    NEXT_VERSION="$EXPLICIT_VERSION"
else
    NEXT_VERSION=$(bump_version "$CURRENT_VERSION" "$BUMP_TYPE")
fi

validate_semver "$NEXT_VERSION"

RELEASE_BRANCH="release/v${NEXT_VERSION}"

echo "==> Version"
echo "    Current: ${CURRENT_VERSION}"
echo "    Next:    ${NEXT_VERSION} (${BUMP_TYPE})"
echo "    Branch:  ${RELEASE_BRANCH}"
echo ""

if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] Would create branch: ${RELEASE_BRANCH} from origin/master"
    echo "[dry-run] Would update package.json: ${CURRENT_VERSION} → ${NEXT_VERSION}"
    echo "[dry-run] Would commit and tag: v${NEXT_VERSION}"
    echo "[dry-run] Would push tag → GitHub Actions creates the Release"
    exit 0
fi

# ── Confirm ──
read -r -p "Proceed with release v${NEXT_VERSION}? [y/N] " confirm
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

# ── Push branch and tag to remote ──
echo ""
echo "==> Pushing to remote..."
git push origin "${RELEASE_BRANCH}" "v${NEXT_VERSION}" -u
echo "    ✅ Pushed branch ${RELEASE_BRANCH} and tag v${NEXT_VERSION}"

# ── Done ──
echo ""
echo "============================================================"
echo "✅ Release v${NEXT_VERSION} tagged and pushed!"
echo ""
echo "   Tag:     v${NEXT_VERSION}"
echo "   Branch:  ${RELEASE_BRANCH}"
echo ""
echo "   GitHub Actions will build, package, and create the Release."
echo "   Next step: create PR to merge ${RELEASE_BRANCH} → master"
echo "============================================================"
