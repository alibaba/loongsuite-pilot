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
#   bash deploy/release-opensource.sh --oss-only         # build, package, upload to OSS only (no git)
#
# Flow:
#   1. Fetch latest tags from remote
#   2. Determine next version
#   3. Create release/<version> branch from origin/main
#   4. Bump package.json, commit, tag
#   5. Push branch + tag to remote
#   6. Build, package, and upload to OSS
#   7. GitHub Actions (release.yml) picks up the tag → create GitHub Release

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

BUMP_TYPE="patch"
EXPLICIT_VERSION=""
DRY_RUN=0
SKIP_OSS=0
OSS_ONLY=0

OSS_BUCKET="oss://loongcollector-community-edition"
OSS_PREFIX="loongsuite-pilot"

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
        --skip-oss)       SKIP_OSS=1; shift ;;
        --oss-only)       OSS_ONLY=1; shift ;;
        *)
            echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

cd "$PROJECT_ROOT"

PACKAGE_NAME="loongsuite-pilot"

# ── Validate semver format ──
validate_semver() {
    if [[ ! "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "❌ Invalid version format: $1 (expected X.Y.Z)" >&2
        exit 1
    fi
}

# ── Resolve version ──
if [ "$OSS_ONLY" -eq 1 ]; then
    # --oss-only: use explicit version or current package.json version
    if [ -n "$EXPLICIT_VERSION" ]; then
        NEXT_VERSION="$EXPLICIT_VERSION"
    else
        NEXT_VERSION=$(node -e "process.stdout.write(require('./package.json').version)")
    fi
    validate_semver "$NEXT_VERSION"

    echo "==> OSS-only mode"
    echo "    Version: ${NEXT_VERSION}"
    echo ""

    if [ "$DRY_RUN" -eq 1 ]; then
        echo "[dry-run] Would build, package, and upload to OSS:"
        echo "[dry-run]   ${OSS_BUCKET}/${OSS_PREFIX}/${NEXT_VERSION}/${PACKAGE_NAME}.tar.gz"
        echo "[dry-run]   ${OSS_BUCKET}/${OSS_PREFIX}/${NEXT_VERSION}/${PACKAGE_NAME}.zip"
        echo "[dry-run]   ${OSS_BUCKET}/${OSS_PREFIX}/latest/${PACKAGE_NAME}.tar.gz"
        echo "[dry-run]   ${OSS_BUCKET}/${OSS_PREFIX}/latest/${PACKAGE_NAME}.zip"
        echo "[dry-run]   ${OSS_BUCKET}/${OSS_PREFIX}/installer.sh"
        echo "[dry-run]   ${OSS_BUCKET}/${OSS_PREFIX}/installer.ps1"
        exit 0
    fi
else
    # Full release flow: ensure clean tree and resolve version from tags
    if [ -n "$(git status --porcelain)" ]; then
        echo "❌ Working tree is not clean. Please commit or stash changes first."
        git status --short
        exit 1
    fi

    echo "==> Fetching from remote..."
    git fetch origin --prune --prune-tags --quiet
    echo "    ✅ Synced tags and branches"

    get_latest_version_from_tags() {
        local latest
        latest=$(git tag -l 'v*' --sort=-v:refname | head -1 | sed 's/^v//')
        if [ -z "$latest" ]; then
            latest=$(node -e "process.stdout.write(require('./package.json').version)")
        fi
        echo "$latest"
    }

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
        echo "[dry-run] Would create branch: ${RELEASE_BRANCH} from origin/main"
        echo "[dry-run] Would update package.json: ${CURRENT_VERSION} → ${NEXT_VERSION}"
        echo "[dry-run] Would commit and tag: v${NEXT_VERSION}"
        echo "[dry-run] Would push tag → GitHub Actions creates the Release"
        echo "[dry-run] Would build, package, and upload to OSS:"
        echo "[dry-run]   ${OSS_BUCKET}/${OSS_PREFIX}/${NEXT_VERSION}/${PACKAGE_NAME}.tar.gz"
        echo "[dry-run]   ${OSS_BUCKET}/${OSS_PREFIX}/${NEXT_VERSION}/${PACKAGE_NAME}.zip"
        echo "[dry-run]   ${OSS_BUCKET}/${OSS_PREFIX}/latest/${PACKAGE_NAME}.tar.gz"
        echo "[dry-run]   ${OSS_BUCKET}/${OSS_PREFIX}/latest/${PACKAGE_NAME}.zip"
        echo "[dry-run]   ${OSS_BUCKET}/${OSS_PREFIX}/installer.sh"
        echo "[dry-run]   ${OSS_BUCKET}/${OSS_PREFIX}/installer.ps1"
        exit 0
    fi

    # ── Confirm ──
    read -r -p "Proceed with release v${NEXT_VERSION}? [y/N] " confirm
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 0
    fi

    # ── Create release branch from origin/main ──
    echo "==> Creating release branch..."
    if git show-ref --verify --quiet "refs/heads/${RELEASE_BRANCH}"; then
        echo "    Branch ${RELEASE_BRANCH} already exists locally, switching to it"
        git checkout "${RELEASE_BRANCH}"
    else
        git checkout -b "${RELEASE_BRANCH}" origin/main
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
fi

if [ "$SKIP_OSS" -eq 0 ]; then
    echo ""
    echo "==> Building and packaging..."
    bash deploy/package-opensource.sh
    TARBALL="$PROJECT_ROOT/${PACKAGE_NAME}.tar.gz"
    ZIPFILE="$PROJECT_ROOT/${PACKAGE_NAME}.zip"

    if [ ! -f "$TARBALL" ]; then
        echo "❌ Package file not found: $TARBALL"
        exit 1
    fi
    if [ ! -f "$ZIPFILE" ]; then
        echo "❌ Package file not found: $ZIPFILE"
        exit 1
    fi

    if ! command -v ossutil &>/dev/null; then
        echo "❌ ossutil not found. Install it or use --skip-oss to skip OSS upload."
        exit 1
    fi

    echo ""
    echo "==> Uploading to OSS..."

    # Upload versioned packages (Linux/macOS .tar.gz + Windows .zip)
    ossutil cp "$TARBALL" "${OSS_BUCKET}/${OSS_PREFIX}/${NEXT_VERSION}/${PACKAGE_NAME}.tar.gz" -f
    echo "    ✅ ${OSS_PREFIX}/${NEXT_VERSION}/${PACKAGE_NAME}.tar.gz"

    ossutil cp "$ZIPFILE" "${OSS_BUCKET}/${OSS_PREFIX}/${NEXT_VERSION}/${PACKAGE_NAME}.zip" -f
    echo "    ✅ ${OSS_PREFIX}/${NEXT_VERSION}/${PACKAGE_NAME}.zip"

    # Upload as latest
    ossutil cp "$TARBALL" "${OSS_BUCKET}/${OSS_PREFIX}/latest/${PACKAGE_NAME}.tar.gz" -f
    echo "    ✅ ${OSS_PREFIX}/latest/${PACKAGE_NAME}.tar.gz"

    ossutil cp "$ZIPFILE" "${OSS_BUCKET}/${OSS_PREFIX}/latest/${PACKAGE_NAME}.zip" -f
    echo "    ✅ ${OSS_PREFIX}/latest/${PACKAGE_NAME}.zip"

    # Upload installer scripts (Linux/macOS .sh + Windows .ps1)
    ossutil cp deploy/installer-opensource.sh "${OSS_BUCKET}/${OSS_PREFIX}/installer.sh" -f
    echo "    ✅ ${OSS_PREFIX}/installer.sh"

    ossutil cp deploy/installer-opensource.ps1 "${OSS_BUCKET}/${OSS_PREFIX}/installer.ps1" -f
    echo "    ✅ ${OSS_PREFIX}/installer.ps1"

    # Cleanup
    rm -f "$TARBALL" "$ZIPFILE"
else
    echo ""
    echo "==> Skipping OSS upload (--skip-oss)"
fi

# ── Done ──
echo ""
echo "============================================================"
if [ "$OSS_ONLY" -eq 1 ]; then
    echo "✅ OSS upload v${NEXT_VERSION} complete!"
else
    echo "✅ Release v${NEXT_VERSION} complete!"
    echo ""
    echo "   Tag:     v${NEXT_VERSION}"
    echo "   Branch:  ${RELEASE_BRANCH}"
fi
echo ""
echo "   OSS:     https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/${OSS_PREFIX}/${NEXT_VERSION}/${PACKAGE_NAME}.tar.gz (Linux/macOS)"
echo "            https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/${OSS_PREFIX}/${NEXT_VERSION}/${PACKAGE_NAME}.zip (Windows)"
if [ "$OSS_ONLY" -eq 0 ]; then
    echo "   GitHub Actions will create the GitHub Release."
    echo "   Next step: create PR to merge ${RELEASE_BRANCH} → main"
fi
echo "============================================================"
