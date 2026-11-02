#!/usr/bin/env bash
# Explicit developer-only agent-plugin contracts; never invoked by product packaging.
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
rust_root="$(printenv PILOT_TEST_RUST_ROOT || echo /opt/rust)"
node_bin="$(printenv PILOT_TEST_HOST_NODE_BIN || true)"
if test -z "$node_bin"; then
  printf "%s\n" "Set PILOT_TEST_HOST_NODE_BIN to a Node 22+ bin directory compatible with the verification image." >&2
  exit 2
fi
image="$(printenv PILOT_TEST_GLIBC234_IMAGE || echo pilot-dev-glibc234:20261030)"
test -x "$node_bin/node"
image_id="$(docker image inspect --format '{{.Id}}' "$image")"
if test "$#" -eq 0; then
  set -- cargo test --offline --locked --manifest-path tests/host-plugin-contracts/Cargo.toml
fi
exec docker run --rm --network none \
  --mount "type=bind,src=$repo_root,dst=$repo_root" \
  --mount "type=bind,src=$rust_root,dst=/opt/rust,readonly" \
  --mount "type=bind,src=$node_bin,dst=/opt/pilot-node,readonly" \
  --workdir "$repo_root" \
  --env PATH=/opt/pilot-node:/opt/rust/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  --env RUSTUP_HOME=/opt/rust --env CARGO_HOME=/opt/rust --env RUSTUP_TOOLCHAIN=1.99.1 \
  --env CARGO_TARGET_DIR="$repo_root/target/glibc234" \
  --env CARGO_PROFILE_DEV_DEBUG=0 --env CARGO_PROFILE_TEST_DEBUG=0 \
  --env HOME=/tmp/pilot-plugin-contract-home --env USERPROFILE=/tmp/pilot-plugin-contract-home \
  --env APPDATA=/tmp/pilot-plugin-contract-home/appdata --env LOCALAPPDATA=/tmp/pilot-plugin-contract-home/localappdata \
  --env XDG_CONFIG_HOME=/tmp/pilot-plugin-contract-home/config \
  --env XDG_DATA_HOME=/tmp/pilot-plugin-contract-home/data \
  --env XDG_CACHE_HOME=/tmp/pilot-plugin-contract-home/cache \
  --entrypoint /bin/bash "$image_id" -euo pipefail -c '
    test "$(getconf GNU_LIBC_VERSION)" = "glibc 2.34"
    node --version
    python3 --version
    mkdir -p "$HOME"
    exec "$@"
  ' pilot-host-plugins "$@"
