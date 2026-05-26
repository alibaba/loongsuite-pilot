#!/usr/bin/env bash
# One-shot local Docker verification: L2 preflight + L1 preflight + L1 install-smoke.
# Validates the L1/L2 split end-to-end before pushing the branch.
#
# Usage:
#   bash scripts/e2e/verify-local-docker.sh
#
# Requires:
#   - Docker daemon running with `docker compose` (v2) plugin
#   - .env.e2e present with at least the 9 L1 envs filled

set -uo pipefail
cd "$(dirname "$0")/../.."

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
banner() { printf '\n\033[1;36m========== %s ==========\033[0m\n' "$*"; }

# ---------- Preflight checks ----------
banner "Preflight: docker compose v2"
if ! docker compose version >/dev/null 2>&1; then
  red "docker compose (v2) is not available."
  cat <<'EOF'

Fix on macOS (Colima/Homebrew):
  brew install docker-compose
  mkdir -p ~/.docker/cli-plugins
  ln -sfn /opt/homebrew/bin/docker-compose ~/.docker/cli-plugins/docker-compose
  docker compose version    # should print v2.x

EOF
  exit 2
fi
green "OK: $(docker compose version | head -1)"

banner "Preflight: .env.e2e"
if [ ! -f .env.e2e ]; then
  red ".env.e2e not found."
  cat <<'EOF'

Prepare it with one of:
  cp .env.e2e.example .env.e2e         # 9 envs, enough for L1
  cp .env.e2e.l2.example .env.e2e      # full env list, covers L1 + L2

Then edit .env.e2e and fill in real values (SLS creds, agent API keys).
EOF
  exit 2
fi

REQUIRED=(
  E2E_USER_ID
  E2E_CODEX_OPENAI_API_KEY
  E2E_ANTHROPIC_API_KEY
  E2E_QODER_PERSONAL_ACCESS_TOKEN
  E2E_SLS_PROJECT
  E2E_SLS_LOGSTORE
  E2E_SLS_ACCESS_KEY_ID
  E2E_SLS_ACCESS_KEY_SECRET
)

# Load .env.e2e using the same parser as run-e2e.sh
set -a
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%%#*}"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [ -z "$line" ] && continue
  eval "$line"
done < .env.e2e
set +a

MISSING=()
for k in "${REQUIRED[@]}"; do
  v="$(eval echo "\${$k:-}")"
  if [ -z "${v// }" ] || [[ "$v" == *your-*-key* ]] || [[ "$v" == your-employee-id ]] || [[ "$v" == your-* ]] || [[ "$v" == pt-your-* ]] || [[ "$v" == sk-your-* ]]; then
    MISSING+=("$k")
  fi
done

if [ ${#MISSING[@]} -gt 0 ]; then
  red ".env.e2e has placeholder / empty values for:"
  for k in "${MISSING[@]}"; do echo "  - $k"; done
  exit 2
fi
green "OK: all 8 L1 envs look populated"

# ---------- Cleanup hook ----------
cleanup() {
  docker compose -f tests/e2e-docker/docker-compose.l1.yml down -v >/dev/null 2>&1 || true
  docker compose -f tests/e2e-docker/docker-compose.yml down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# ---------- Build once ----------
banner "Build: npm run build"
if ! npm run build; then
  red "npm run build failed — fix before running container tests."
  exit 1
fi

# ---------- Run scenarios ----------
L2_PRE=fail
L1_PRE=fail
L1_SMOKE=fail

banner "1/3: L2 preflight (zero-regression for old runner)"
if E2E_SCENARIO=preflight npm run test:e2e:l2; then
  L2_PRE=pass
  green "L2 preflight passed"
else
  red "L2 preflight FAILED"
fi
docker compose -f tests/e2e-docker/docker-compose.yml down -v >/dev/null 2>&1 || true

banner "2/3: L1 preflight (new runner, lightest scenario)"
if bash scripts/e2e/run-e2e.sh preflight; then
  L1_PRE=pass
  green "L1 preflight passed"
else
  red "L1 preflight FAILED"
fi
docker compose -f tests/e2e-docker/docker-compose.l1.yml down -v >/dev/null 2>&1 || true

banner "3/3: L1 install-smoke (real SLS upload + 4 agent probes, ~10 min)"
if bash scripts/e2e/run-e2e.sh install-smoke; then
  L1_SMOKE=pass
  green "L1 install-smoke passed"
else
  red "L1 install-smoke FAILED"
  yellow "Hint: re-run with E2E_KEEP_ALIVE=1 then 'docker exec -it loongsuite-pilot-e2e-l1 bash'"
fi
docker compose -f tests/e2e-docker/docker-compose.l1.yml down -v >/dev/null 2>&1 || true

# ---------- Summary ----------
banner "Summary"
printf '  %-22s %s\n' "L2 preflight"      "$L2_PRE"
printf '  %-22s %s\n' "L1 preflight"      "$L1_PRE"
printf '  %-22s %s\n' "L1 install-smoke"  "$L1_SMOKE"

if [ "$L2_PRE" = pass ] && [ "$L1_PRE" = pass ] && [ "$L1_SMOKE" = pass ]; then
  green ""
  green "ALL PASS — branch is safe to push"
  exit 0
else
  red ""
  red "SOME FAILED — check tests/e2e-docker/output/ for artifacts"
  exit 1
fi
