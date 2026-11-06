#!/usr/bin/env bash
# Isolated GNU verification: no real HOME, Agent data, service or Docker socket.
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
rust_root="$(printenv PILOT_TEST_RUST_ROOT || echo /opt/rust)"
image="$(printenv PILOT_TEST_GLIBC234_IMAGE || echo pilot-dev-glibc234:20261030)"
test -d "$rust_root/toolchains"
image_id="$(docker image inspect --format '{{.Id}}' "$image")"
printf 'verification image %s\n' "$image_id"
docker run --rm --network none \
  --mount "type=bind,src=$repo_root,dst=$repo_root" \
  --mount "type=bind,src=$rust_root,dst=/opt/rust" \
  --workdir "$repo_root" \
  --env PATH=/opt/rust/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  --env RUSTUP_HOME=/opt/rust --env CARGO_HOME=/opt/rust \
  --env RUSTUP_TOOLCHAIN=1.99.1 \
  --env CARGO_TARGET_DIR="$repo_root/target/glibc234" \
  --env CARGO_PROFILE_DEV_DEBUG=0 --env CARGO_PROFILE_TEST_DEBUG=0 \
  --env HOME=/tmp/pilot-verification-home --env USERPROFILE=/tmp/pilot-verification-home \
  --env APPDATA=/tmp/pilot-verification-home/appdata \
  --env LOCALAPPDATA=/tmp/pilot-verification-home/localappdata \
  --env XDG_CONFIG_HOME=/tmp/pilot-verification-home/config \
  --env XDG_DATA_HOME=/tmp/pilot-verification-home/data \
  --env XDG_CACHE_HOME=/tmp/pilot-verification-home/cache \
  --entrypoint /bin/bash "$image_id" -euo pipefail -c '
    test "$(getconf GNU_LIBC_VERSION)" = "glibc 2.34"
    rustc --version
    mkdir -p "$HOME"
    python3 scripts/build/prepare-rust-dependencies.py --offline
    if test "$#" -eq 0; then
      set -- cargo test --workspace --all-features --locked --offline
    fi
    exec "$@"
  ' pilot-glibc234 "$@"
