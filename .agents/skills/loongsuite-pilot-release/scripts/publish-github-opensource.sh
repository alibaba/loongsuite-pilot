#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  publish-github-opensource.sh --version X.Y.Z --source COMMIT --notes-file NOTES.md [--dry-run]

Publishes the GitHub open-source release from a pinned source commit:
  1. create an isolated checkout whose origin/main is the pinned source
  2. create the release branch and release commit locally
  3. run npm ci before any remote write
  4. build and package locally
  5. upload public OSS artifacts
  6. create GitHub Release with exact asset names
  7. verify GitHub Release and public OSS artifacts
USAGE
}

die() {
  echo "Error: $*" >&2
  exit 1
}

cleanup() {
  if [[ -n "${TMPROOT:-}" && "$TMPROOT" == /tmp/github-loongsuite-pilot-release.* && -d "$TMPROOT" ]]; then
    rm -rf -- "$TMPROOT"
  fi
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing command: $1"
}

validate_inputs() {
  [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "--version must be X.Y.Z"
  [[ -n "$SOURCE_COMMIT" ]] || die "--source is required"
  [[ -d "$GITHUB_REPO/.git" ]] || die "GitHub repo not found: $GITHUB_REPO"
}

update_package_version() {
  local version="$1"
  VERSION="$version" node - <<'NODE'
const fs = require('node:fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = process.env.VERSION;
fs.writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
NODE
}

ensure_zip_command() {
  if command -v zip >/dev/null 2>&1; then
    return
  fi
  require_cmd python3
  local bin_dir="${TMPROOT}/bin"
  mkdir -p "$bin_dir"
  cat > "${bin_dir}/zip" <<'ZIPWRAP'
#!/usr/bin/env bash
set -euo pipefail
positional=()
for arg in "$@"; do
  case "$arg" in
    -*) ;;
    *) positional+=("$arg") ;;
  esac
done
if [[ "${#positional[@]}" -lt 2 ]]; then
  echo "zip wrapper expects: zip [flags] output.zip input..." >&2
  exit 2
fi
out="${positional[0]}"
python3 - "$out" "${positional[@]:1}" <<'PY'
import os
import sys
import zipfile

out = sys.argv[1]
inputs = sys.argv[2:]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
    for item in inputs:
        if os.path.isdir(item):
            for root, dirs, files in os.walk(item):
                dirs.sort()
                files.sort()
                for name in files:
                    path = os.path.join(root, name)
                    archive.write(path, path)
        else:
            archive.write(item, item)
PY
ZIPWRAP
  chmod +x "${bin_dir}/zip"
  export PATH="${bin_dir}:${PATH}"
}

load_github_oss_credentials() {
  if [[ -n "${github_accessKeyID:-}" && -n "${github_accessKeySecret:-}" ]]; then
    return
  fi
  if command -v zsh >/dev/null 2>&1; then
    github_accessKeyID="$(zsh -lc 'printf "%s" "${github_accessKeyID:-}"' || true)"
    github_accessKeySecret="$(zsh -lc 'printf "%s" "${github_accessKeySecret:-}"' || true)"
    export github_accessKeyID github_accessKeySecret
  fi
}

upload_oss() {
  local src="$1"
  local dst="$2"
  if [[ -n "${github_accessKeyID:-}" && -n "${github_accessKeySecret:-}" ]]; then
    ossutil cp "$src" "$dst" -i "$github_accessKeyID" -k "$github_accessKeySecret" -f
  else
    ossutil cp "$src" "$dst" -f
  fi
}

zip_read_version() {
  local zipfile="$1"
  if command -v unzip >/dev/null 2>&1; then
    unzip -p "$zipfile" loongsuite-pilot/VERSION
  else
    python3 - "$zipfile" <<'PY'
import sys
import zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    sys.stdout.write(archive.read("loongsuite-pilot/VERSION").decode())
PY
  fi
}

zip_test() {
  local zipfile="$1"
  if command -v unzip >/dev/null 2>&1; then
    unzip -t "$zipfile" >/dev/null
  else
    python3 -m zipfile -t "$zipfile" >/dev/null
  fi
}

verify_local_version() {
  local tarball="$1"
  local zipfile="$2"
  local version="$3"
  local commit="$4"
  local branch="$5"
  tar -xOzf "$tarball" loongsuite-pilot/VERSION | grep -qx "version=${version}"
  tar -xOzf "$tarball" loongsuite-pilot/VERSION | grep -qx "git_commit=${commit}"
  tar -xOzf "$tarball" loongsuite-pilot/VERSION | grep -qx "git_branch=${branch}"
  zip_read_version "$zipfile" | grep -qx "version=${version}"
  zip_read_version "$zipfile" | grep -qx "git_commit=${commit}"
  zip_read_version "$zipfile" | grep -qx "git_branch=${branch}"
  zip_test "$zipfile"
}

verify_release() {
  local version="$1"
  local release_sha="$2"
  local expected_commit="${release_sha:0:7}"
  local verify_dir="${TMPROOT}/verify"
  mkdir -p "$verify_dir/github" "$verify_dir/oss"

  local remote_branch_sha remote_tag_sha
  remote_branch_sha="$(git ls-remote "$REAL_ORIGIN" "refs/heads/release/v${version}" | awk 'NR == 1 {print $1}')"
  remote_tag_sha="$(git ls-remote "$REAL_ORIGIN" "refs/tags/v${version}" "refs/tags/v${version}^{}" | awk 'END {print $1}')"
  [[ "$remote_branch_sha" == "$release_sha" ]] || die "GitHub release branch does not point to ${release_sha}: ${remote_branch_sha:-missing}"
  [[ "$remote_tag_sha" == "$release_sha" ]] || die "GitHub release tag does not point to ${release_sha}: ${remote_tag_sha:-missing}"

  local assets
  assets="$(gh release view "v${version}" --repo "$GITHUB_SLUG" --json isDraft,isPrerelease,assets --jq 'select(.isDraft == false and .isPrerelease == false) | .assets[].name')"
  for name in loongsuite-pilot.tar.gz loongsuite-pilot.zip installer.sh installer.ps1; do
    grep -qx "$name" <<<"$assets" || die "GitHub Release missing asset: $name"
  done

  gh release download "v${version}" --repo "$GITHUB_SLUG" --dir "$verify_dir/github" \
    --pattern loongsuite-pilot.tar.gz \
    --pattern loongsuite-pilot.zip \
    --pattern installer.sh \
    --pattern installer.ps1

  curl -fsSL "${OSS_HTTP_BASE}/${version}/loongsuite-pilot.tar.gz" -o "$verify_dir/oss/versioned.tar.gz"
  curl -fsSL "${OSS_HTTP_BASE}/${version}/loongsuite-pilot.zip" -o "$verify_dir/oss/versioned.zip"
  curl -fsSL "${OSS_HTTP_BASE}/latest/loongsuite-pilot.tar.gz" -o "$verify_dir/oss/latest.tar.gz"
  curl -fsSL "${OSS_HTTP_BASE}/latest/loongsuite-pilot.zip" -o "$verify_dir/oss/latest.zip"

  verify_local_version \
    "$verify_dir/github/loongsuite-pilot.tar.gz" \
    "$verify_dir/github/loongsuite-pilot.zip" \
    "$version" "$expected_commit" "release/v${version}"
  verify_local_version \
    "$verify_dir/oss/versioned.tar.gz" \
    "$verify_dir/oss/versioned.zip" \
    "$version" "$expected_commit" "release/v${version}"
  verify_local_version \
    "$verify_dir/oss/latest.tar.gz" \
    "$verify_dir/oss/latest.zip" \
    "$version" "$expected_commit" "release/v${version}"
}

parse_args() {
  VERSION=""
  SOURCE_COMMIT=""
  GITHUB_REPO="${HOME}/github-loongsuite-pilot"
  GITHUB_SLUG="alibaba/loongsuite-pilot"
  NOTES_FILE=""
  DRY_RUN=0

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --version)
        VERSION="${2:-}"; shift 2 ;;
      --version=*)
        VERSION="${1#*=}"; shift ;;
      --source)
        SOURCE_COMMIT="${2:-}"; shift 2 ;;
      --source=*)
        SOURCE_COMMIT="${1#*=}"; shift ;;
      --github-repo)
        GITHUB_REPO="${2:-}"; shift 2 ;;
      --github-repo=*)
        GITHUB_REPO="${1#*=}"; shift ;;
      --github-slug)
        GITHUB_SLUG="${2:-}"; shift 2 ;;
      --github-slug=*)
        GITHUB_SLUG="${1#*=}"; shift ;;
      --notes-file)
        NOTES_FILE="${2:-}"; shift 2 ;;
      --notes-file=*)
        NOTES_FILE="${1#*=}"; shift ;;
      --dry-run)
        DRY_RUN=1; shift ;;
      -h|--help)
        usage; exit 0 ;;
      *)
        echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
    esac
  done
}

main() {
  parse_args "$@"

  PACKAGE_NAME="loongsuite-pilot"
  BRANCH="release/v${VERSION}"
  TAG="v${VERSION}"
  OSS_BUCKET="oss://loongcollector-community-edition"
  OSS_HTTP_BASE="https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot"
  OSS_PREFIX="loongsuite-pilot"

  validate_inputs
  require_cmd git
  require_cmd npm
  require_cmd node
  require_cmd gh
  require_cmd ossutil
  require_cmd curl
  require_cmd tar

  REAL_ORIGIN="$(git -C "$GITHUB_REPO" remote get-url origin)"

  git -C "$GITHUB_REPO" fetch origin --prune --tags --quiet
  git -C "$GITHUB_REPO" cat-file -e "${SOURCE_COMMIT}^{commit}"

  REMOTE_BRANCH_SHA="$(git -C "$GITHUB_REPO" ls-remote "$REAL_ORIGIN" "refs/heads/${BRANCH}" | awk '{print $1}')"
  REMOTE_TAG_SHA="$(git -C "$GITHUB_REPO" ls-remote "$REAL_ORIGIN" "refs/tags/${TAG}" "refs/tags/${TAG}^{}" | awk 'NR == 1 {print $1}')"
  REMOTE_RELEASE_URL="$(gh release view "$TAG" --repo "$GITHUB_SLUG" --json url --jq '.url' 2>/dev/null || true)"

  if [[ -n "$REMOTE_BRANCH_SHA" || -n "$REMOTE_TAG_SHA" || -n "$REMOTE_RELEASE_URL" ]]; then
    echo "Remote release state already exists:" >&2
    [[ -n "$REMOTE_BRANCH_SHA" ]] && echo "  branch ${BRANCH}: ${REMOTE_BRANCH_SHA}" >&2
    [[ -n "$REMOTE_TAG_SHA" ]] && echo "  tag ${TAG}: ${REMOTE_TAG_SHA}" >&2
    [[ -n "$REMOTE_RELEASE_URL" ]] && echo "  release ${TAG}: ${REMOTE_RELEASE_URL}" >&2
    echo "Stop before mutating. Inspect existing state or use a targeted recovery path." >&2
    exit 1
  fi

  TMPROOT="$(mktemp -d /tmp/github-loongsuite-pilot-release.XXXXXX)"
  trap cleanup EXIT
  PINNED_BARE="${TMPROOT}/pinned-origin.git"
  PINNED_WT="${TMPROOT}/wt"

  git init --bare "$PINNED_BARE" >/dev/null
  git --git-dir="$PINNED_BARE" fetch "$GITHUB_REPO" "$SOURCE_COMMIT" --quiet
  git --git-dir="$PINNED_BARE" update-ref refs/heads/main "$SOURCE_COMMIT"
  git clone "$PINNED_BARE" "$PINNED_WT" --quiet
  git -C "$PINNED_WT" remote set-url --push origin "$REAL_ORIGIN"

  cat <<SUMMARY
GitHub open-source release plan:
  version:       ${TAG}
  source:        ${SOURCE_COMMIT}
  branch:        ${BRANCH}
  pinned repo:   ${PINNED_WT}
  github repo:   ${GITHUB_SLUG}
  remote:        ${REAL_ORIGIN}
  notes file:    ${NOTES_FILE:-<required for real publish>}
  strategy:      local build/package + OSS upload + gh release create

This path does not push the tag with git, so it does not rely on the tag-push
GitHub Actions release workflow.
SUMMARY

  if [[ "$DRY_RUN" -eq 1 ]]; then
    exit 0
  fi

  if [[ -z "$NOTES_FILE" || ! -s "$NOTES_FILE" ]]; then
    echo "--notes-file is required for real publish and must be non-empty." >&2
    exit 1
  fi
  NOTES_FILE="$(cd "$(dirname "$NOTES_FILE")" && pwd)/$(basename "$NOTES_FILE")"

  cd "$PINNED_WT"
  git checkout -b "$BRANCH" origin/main
  update_package_version "$VERSION"
  git add package.json
  if git diff --cached --quiet; then
    echo "package.json already at ${VERSION}; no release commit needed"
  else
    git commit -m "release: v${VERSION}"
  fi
  RELEASE_SHA="$(git rev-parse HEAD)"

  npm ci
  npm run build
  ensure_zip_command
  bash deploy/package-opensource.sh --skip-build

  TARBALL="${PINNED_WT}/${PACKAGE_NAME}.tar.gz"
  ZIPFILE="${PINNED_WT}/${PACKAGE_NAME}.zip"
  [[ -f "$TARBALL" ]] || die "Missing package: $TARBALL"
  [[ -f "$ZIPFILE" ]] || die "Missing package: $ZIPFILE"

  verify_local_version "$TARBALL" "$ZIPFILE" "$VERSION" "$(git rev-parse --short HEAD)" "$BRANCH"

  git push origin "$BRANCH"

  load_github_oss_credentials
  upload_oss "$TARBALL" "${OSS_BUCKET}/${OSS_PREFIX}/${VERSION}/${PACKAGE_NAME}.tar.gz"
  upload_oss "$ZIPFILE" "${OSS_BUCKET}/${OSS_PREFIX}/${VERSION}/${PACKAGE_NAME}.zip"
  upload_oss "$TARBALL" "${OSS_BUCKET}/${OSS_PREFIX}/latest/${PACKAGE_NAME}.tar.gz"
  upload_oss "$ZIPFILE" "${OSS_BUCKET}/${OSS_PREFIX}/latest/${PACKAGE_NAME}.zip"
  upload_oss deploy/installer-opensource.sh "${OSS_BUCKET}/${OSS_PREFIX}/installer.sh"
  upload_oss deploy/installer-opensource.ps1 "${OSS_BUCKET}/${OSS_PREFIX}/installer.ps1"

  ASSET_DIR="${TMPROOT}/assets"
  mkdir -p "$ASSET_DIR"
  cp deploy/installer-opensource.sh "${ASSET_DIR}/installer.sh"
  cp deploy/installer-opensource.ps1 "${ASSET_DIR}/installer.ps1"

  gh release create "$TAG" \
    "$TARBALL" \
    "$ZIPFILE" \
    "${ASSET_DIR}/installer.sh" \
    "${ASSET_DIR}/installer.ps1" \
    --repo "$GITHUB_SLUG" \
    --target "$RELEASE_SHA" \
    --title "LoongSuite Pilot ${TAG}" \
    --notes-file "$NOTES_FILE"

  verify_release "$VERSION" "$RELEASE_SHA"

  cat <<DONE

GitHub open-source release published:
  release:    https://github.com/${GITHUB_SLUG}/releases/tag/${TAG}
  branch:     ${BRANCH}
  commit:     ${RELEASE_SHA}
DONE
}

main "$@"
