#!/usr/bin/env bash
# Run from a source tree inside the RISC-V guest. No host node_modules may be copied in.
set -euo pipefail
if [[ "${1:-}" != --artifacts || -z "${2:-}" ]]; then
  echo 'Usage: build-native.sh --artifacts DIRECTORY' >&2
  exit 2
fi
artifacts="$(realpath -m "$2")"
mkdir -p "$artifacts"
exec > >(tee "$artifacts/native-build.log") 2>&1
test "$(uname -m)" = riscv64
node -e 'if(process.arch!=="riscv64") process.exit(1)'
test -f package-lock.json
export npm_config_nodedir npm_config_python npm_config_jobs
npm_config_nodedir="$(dirname "$(dirname "$(readlink -f "$(command -v node)")")")"
npm_config_python=/usr/bin/python3
npm_config_jobs=4
printf 'start=%s node_headers=%s\n' "$(date --iso-8601=seconds)" "$npm_config_nodedir"
node -e 'console.log(JSON.stringify({node:process.version,arch:process.arch,versions:process.versions}))'
cc --version
python3 --version
# Avoid root postinstall and all native prebuilds until the explicit rebuild below.
timeout --signal=TERM --kill-after=10s 1800s npm ci --ignore-scripts --omit=dev --omit=optional --no-audit --no-fund
node -e 'try { console.log("local node-gyp",require("node-gyp/package.json").version) } catch(e) { if(e.code!=="MODULE_NOT_FOUND") throw e; console.log("local node-gyp omitted; npm lifecycle may use its bundled node-gyp (actual version is in build logs)") }'
: > "$artifacts/build-times.tsv"
for module in sqlite3 zstd-napi; do
  if [[ "$module" == sqlite3 ]]; then napi_version=6; else napi_version=8; fi
  start_seconds=$SECONDS
  printf 'BUILD module=%s time=%s\n' "$module" "$(date --iso-8601=seconds)"
  set +e
  npm_config_build_from_source=true npm_config_napi_build_version="$napi_version" \
    timeout --signal=TERM --kill-after=10s 1800s \
    npm rebuild "$module" --foreground-scripts --loglevel verbose > "$artifacts/$module-build.log" 2>&1
  status=$?
  set -e
  elapsed=$((SECONDS - start_seconds))
  printf '%s\t%s\t%s\n' "$module" "$status" "$elapsed" >> "$artifacts/build-times.tsv"
  printf 'BUILD RESULT module=%s exit=%s seconds=%s\n' "$module" "$status" "$elapsed"
  tail -n 12 "$artifacts/$module-build.log"
done
node "$(dirname "${BASH_SOURCE[0]}")/native-probe.cjs" "$PWD" "$artifacts"
