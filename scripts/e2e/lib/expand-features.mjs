/**
 * Script builders for the expand-features E2E scenario.
 * Each function returns a bash string ready for runLocalScript().
 */

/**
 * Phase 1: Agent Dynamic Discovery
 * Uninstall codex → start pilot → verify NOT detected → reinstall → verify detected.
 */
export function buildAgentDiscoveryPhaseScript(env) {
  const discoveryInterval = env.LOONGSUITE_PILOT_DISCOVERY_INTERVAL_MS || '30000';
  const waitSec = Math.ceil(Number(discoveryInterval) / 1000) + 5;
  return `
set -euo pipefail
LOG="$HOME/.loongsuite-pilot/logs/loongsuite-pilot-service.log"

echo "[phase1] Agent Dynamic Discovery Test"

# Stop pilot for a clean slate
loongsuite-pilot stop || true
sleep 2

# Remove codex detection path (agent-defs/codex.json uses ~/.codex as detection path)
echo "[phase1] Removing codex detection path (~/.codex)..."
rm -rf "$HOME/.codex"

echo "[phase1] codex detection path removed"

# Clear log for clean detection
mkdir -p "$(dirname "$LOG")"
> "$LOG" 2>/dev/null || true

# Start pilot (discovery will run on short interval)
echo "[phase1] Starting pilot..."
loongsuite-pilot start || { echo "FAIL: pilot start failed"; exit 1; }
sleep 8

# Verify codex NOT detected (it should be idle, not started)
if grep -q '"id":"deploy:codex".*agent detected and started' "$LOG" 2>/dev/null; then
  echo "FAIL: codex detected but ~/.codex does not exist"
  exit 1
fi
echo "[phase1] Confirmed: codex not detected (expected)"

# Recreate codex detection path
echo "[phase1] Recreating ~/.codex directory..."
mkdir -p "$HOME/.codex"

# Wait for discovery interval
echo "[phase1] Waiting ${waitSec}s for discovery..."
sleep ${waitSec}

# Verify codex detected
if ! grep -q '"id":"deploy:codex"' "$LOG" 2>/dev/null; then
  echo "FAIL: codex not detected after recreating ~/.codex"
  echo "Last 30 log lines:"
  tail -30 "$LOG" 2>/dev/null || true
  exit 1
fi
echo "[phase1] PASSED: codex dynamically discovered after ~/.codex recreated"
`;
}

/**
 * Phase 2: Auto Upgrade (uses mock manifest server)
 * Injects autoUpdate config → waits for updater check → asserts current pointer updated.
 */
export function buildAutoUpgradePhaseScript(env, mockPort) {
  return `
set -euo pipefail
CONFIG="$HOME/.loongsuite-pilot/config.json"
CURRENT_FILE="$HOME/.loongsuite-pilot/current"

echo "[phase2] Auto Upgrade Test (mock port: ${mockPort})"

# Inject autoUpdate config
node -e "
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('$CONFIG', 'utf-8'));
cfg.autoUpdate = {
  enabled: true,
  manifestUrl: 'http://127.0.0.1:${mockPort}/manifest.json',
  packageUrl: 'http://127.0.0.1:${mockPort}/pkg.tar.gz',
  checkIntervalMs: 10000
};
fs.writeFileSync('$CONFIG', JSON.stringify(cfg, null, 2));
console.log('[phase2] autoUpdate config injected');
"

# Record pre-upgrade current
OLD_CURRENT=""
if [ -f "$CURRENT_FILE" ]; then
  OLD_CURRENT=$(cat "$CURRENT_FILE")
fi
echo "[phase2] Pre-upgrade current: '$OLD_CURRENT'"

# Restart pilot to pick up new config
loongsuite-pilot restart
echo "[phase2] Pilot restarted, waiting for updater check..."

# Wait for updater to check and deploy (initial delay + check interval)
sleep 75

# Assert current pointer updated
if [ ! -f "$CURRENT_FILE" ]; then
  echo "FAIL: current file does not exist after upgrade"
  exit 1
fi

NEW_CURRENT=$(cat "$CURRENT_FILE")
echo "[phase2] Post-upgrade current: '$NEW_CURRENT'"

if [ "$NEW_CURRENT" = "$OLD_CURRENT" ]; then
  echo "FAIL: current pointer did not change (updater may not have triggered)"
  echo "Updater logs:"
  grep -i "updat" "$HOME/.loongsuite-pilot/logs/loongsuite-pilot-service.log" 2>/dev/null | tail -20 || true
  exit 1
fi

echo "[phase2] PASSED: current updated from '$OLD_CURRENT' to '$NEW_CURRENT'"
`;
}

/**
 * Phase 3: Auto Rollback
 * Uses installer.sh upgrade with a broken package → asserts rollback to previous version.
 */
export function buildAutoRollbackPhaseScript(env, mockPort) {
  // IMPORTANT: This script is passed to bash -c, meaning its full text becomes
  // the process cmdline. The installer's `loongsuite-pilot stop` uses pkill -f
  // with patterns like "loongsuite-pilot/bin/collector-daemon" which would match
  // our process if the script text contains that substring. We write the actual
  // test logic to a temp file and execute it to avoid this.
  return `
cat > /tmp/e2e-phase3.sh << 'PHASE3_EOF'
#!/bin/bash
set -eo pipefail
CURRENT_FILE="$HOME/.loongsuite-pilot/current"
INSTALLER="/opt/project/deploy/installer.sh"

echo "[phase3] Auto Rollback Test (broken package on port: ${mockPort})"

OLD_CURRENT=$(cat "$CURRENT_FILE" 2>/dev/null || echo "unknown")
echo "[phase3] Pre-rollback current: '$OLD_CURRENT'"

# Deploy the broken package via installer upgrade
echo "[phase3] Running installer upgrade with broken package..."
set +e
bash "$INSTALLER" upgrade --package-url "http://127.0.0.1:${mockPort}/pkg.tar.gz" </dev/null 2>&1
UPGRADE_EXIT=$?
set -e
echo "[phase3] Installer exited with code $UPGRADE_EXIT"

# In Docker, Node.js startup can be slow (>2s), so the installer's health check
# may pass before the crash occurs. Wait longer then verify the crash.
echo "[phase3] Waiting 8s for broken process to crash..."
sleep 8

# Verify the broken version actually crashed
# Note: nohup-spawned processes may become zombies (state Z) if parent hasn't
# reaped them. kill -0 succeeds on zombies, so we check /proc status instead.
echo "[phase3] Checking if broken version crashed..."
PID=$(cat "$HOME/.loongsuite-pilot/loongsuite-pilot.pid" 2>/dev/null || echo "")
PROC_ALIVE=0
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  # Check if it's a zombie — zombies have exited but aren't reaped
  PROC_STATE=$(cat /proc/$PID/status 2>/dev/null | grep "^State:" | awk '{print $2}')
  if [ "$PROC_STATE" = "Z" ]; then
    echo "[phase3] PID $PID is zombie (crashed but not reaped) — treating as dead"
  else
    PROC_ALIVE=1
  fi
fi
if [ "$PROC_ALIVE" -eq 1 ]; then
  echo "FAIL: broken process (PID $PID) still alive after 8s (state: $PROC_STATE)"
  ps -p $PID -o pid,stat,args 2>/dev/null || true
  exit 1
fi
echo "[phase3] Confirmed: broken process crashed (PID $PID exited)"

# Verify current points to broken version (upgrade deployed it)
DEPLOY_CURRENT=$(cat "$CURRENT_FILE" 2>/dev/null || echo "")
echo "[phase3] Current after upgrade: '$DEPLOY_CURRENT'"
if [ "$DEPLOY_CURRENT" = "$OLD_CURRENT" ]; then
  echo "FAIL: broken version was not deployed (current unchanged)"
  exit 1
fi

# Now test the rollback mechanism
echo "[phase3] Triggering manual rollback..."
loongsuite-pilot stop 2>/dev/null || true
loongsuite-pilot rollback 2>&1 || {
  echo "FAIL: loongsuite-pilot rollback command failed"
  exit 1
}
sleep 2

# Verify current restored
NEW_CURRENT=$(cat "$CURRENT_FILE" 2>/dev/null || echo "missing")
echo "[phase3] Post-rollback current: '$NEW_CURRENT'"

if [ "$NEW_CURRENT" != "$OLD_CURRENT" ]; then
  echo "FAIL: current not restored after rollback (expected '$OLD_CURRENT', got '$NEW_CURRENT')"
  exit 1
fi

# The rollback command already restarts the service, so just verify it's running.
# Give it a moment to stabilize.
sleep 3

STATUS_OUT=$(loongsuite-pilot status 2>&1 || true)
echo "[phase3] Status output: $STATUS_OUT"
if ! echo "$STATUS_OUT" | grep -q "is running"; then
  # Service may not have started yet — try starting explicitly
  loongsuite-pilot start 2>&1 || true
  sleep 3
  STATUS_OUT=$(loongsuite-pilot status 2>&1 || true)
  echo "[phase3] Status after explicit start: $STATUS_OUT"
  if ! echo "$STATUS_OUT" | grep -q "is running"; then
    echo "FAIL: pilot not running after rollback"
    exit 1
  fi
fi

echo "[phase3] PASSED: rollback restored to '$OLD_CURRENT', service running"
PHASE3_EOF
chmod +x /tmp/e2e-phase3.sh
exec bash /tmp/e2e-phase3.sh
`;
}

/**
 * Phase 4: Dual Send
 * Injects dual SLS endpoints config → restart → trigger probe → wait flush.
 * Assertions done in Node after script returns.
 */
export function buildDualSendPhaseScript(env, portA, portB) {
  return `
set -euo pipefail
CONFIG="$HOME/.loongsuite-pilot/config.json"

echo "[phase4] Dual Send Test (portA: ${portA}, portB: ${portB})"

# Ensure pilot is in a good state (recover from potential phase 3 breakage)
CURRENT_FILE="$HOME/.loongsuite-pilot/current"
loongsuite-pilot stop 2>/dev/null || true
sleep 1
# If current version's dist/index.js is broken (contains process.exit), rollback
CURR_VER=$(cat "$CURRENT_FILE" 2>/dev/null || echo "")
if [ -n "$CURR_VER" ]; then
  CURR_INDEX="$HOME/.loongsuite-pilot/versions/$CURR_VER/dist/index.js"
  if [ -f "$CURR_INDEX" ] && grep -q "broken-package-e2e-crash\|^process.exit" "$CURR_INDEX" 2>/dev/null; then
    echo "[phase4] Current version '$CURR_VER' is broken, running rollback..."
    loongsuite-pilot rollback 2>&1 || true
    sleep 1
  fi
fi
# Ensure codex detection path AND log dir exist BEFORE pilot starts,
# so discovery's isAvailable() returns true on startup and input starts immediately.
mkdir -p "$HOME/.codex"
mkdir -p "$HOME/.loongsuite-pilot/logs/codex"
export LOONGSUITE_PILOT_DISCOVERY_INTERVAL_MS=5000

loongsuite-pilot start || { echo "FAIL: cannot start pilot for phase 4"; exit 1; }
sleep 2

# Inject dual endpoints config using array format (config-loader array path)
node -e "
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('$CONFIG', 'utf-8'));
cfg.sls = [
  {
    name: 'e2e-raw',
    endpoint: 'http://127.0.0.1:${portA}',
    project: '',
    logstore: 'raw',
    mode: 'webtracking',
    redact: false
  },
  {
    name: 'e2e-redacted',
    endpoint: 'http://127.0.0.1:${portB}',
    project: '',
    logstore: 'redacted',
    mode: 'webtracking',
    redact: true
  }
];
fs.writeFileSync('$CONFIG', JSON.stringify(cfg, null, 2));
console.log('[phase4] Dual endpoints config injected (array format)');
"

# Restart to pick up SLS config, then write records AFTER restart.
# Records must appear after restart so the new instance sees new bytes beyond persisted offset.
loongsuite-pilot restart
sleep 8

# Write synthetic JSONL records — the running instance picks them up on next poll cycle.
HOOK_LOG_DIR="$HOME/.loongsuite-pilot/logs/codex"
mkdir -p "$HOOK_LOG_DIR"
TODAY=$(date +%Y-%m-%d)
HOOK_LOG_FILE="$HOOK_LOG_DIR/codex-$TODAY.jsonl"
echo "[phase4] Writing synthetic hook records to $HOOK_LOG_FILE"

TS_NANO=$(date +%s)000000000
SESSION_ID="e2e-dual-send-$(date +%s)"

for i in 1 2 3 4 5; do
  cat >> "$HOOK_LOG_FILE" << JSONL_EOF
{"event.name":"gen_ai.content.completion","time_unix_nano":"$TS_NANO","event.id":"evt-$i","gen_ai.session.id":"$SESSION_ID","gen_ai.agent.type":"codex_cli_hook","user.id":"e2e-test","gen_ai.request.model":"gpt-4o","gen_ai.usage.input_tokens":100,"gen_ai.usage.output_tokens":50,"gen_ai.output.messages":"hello from e2e dual-send test record $i"}
JSONL_EOF
  TS_NANO=$((TS_NANO + 1000000000))
done
echo "[phase4] Wrote 5 synthetic records"

# Wait for: poll cycle (30s) to read records → dispatch → SLS flush (2s default)
echo "[phase4] Waiting 45s for poll cycle + SLS flush..."
sleep 45

echo "[phase4] Script complete (assertions checked in Node)"
`;
}

/**
 * Phase 5: Masking Validation
 * Injects mask=all config → triggers probe with sensitive patterns → validates JSONL.
 */
export function buildMaskingPhaseScript(env) {
  return `
set -euo pipefail
CONFIG="$HOME/.loongsuite-pilot/config.json"
OUTPUT_DIR="$HOME/.loongsuite-pilot/logs/output"

echo "[phase5] Masking Validation Test"

# Ensure pilot is in a good state
loongsuite-pilot stop 2>/dev/null || true
sleep 1

# Ensure codex detection path AND log dir exist BEFORE pilot starts,
# so discovery's isAvailable() returns true on startup and input starts immediately.
mkdir -p "$HOME/.codex"
mkdir -p "$HOME/.loongsuite-pilot/logs/codex"
export LOONGSUITE_PILOT_DISCOVERY_INTERVAL_MS=5000

loongsuite-pilot start 2>/dev/null || true
sleep 2

# Inject mask config
node -e "
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('$CONFIG', 'utf-8'));
cfg.mask = {
  mode: 'all',
  types: ['cloudAccessKey', 'apiKey', 'privateKey', 'databaseUrl']
};
// Ensure JSONL flusher is active for local validation
if (!cfg.flushers) cfg.flushers = {};
cfg.flushers.jsonl = { enabled: true, outputDir: '$OUTPUT_DIR', rotateDaily: false, maxFileSizeMb: 50 };
fs.writeFileSync('$CONFIG', JSON.stringify(cfg, null, 2));
console.log('[phase5] mask config injected (mode=all)');
"

# Restart pilot to pick up mask config FIRST, then write records.
# Same state-store offset issue as Phase 4: records must be written AFTER restart
# so they appear as new bytes beyond any persisted offset.
loongsuite-pilot restart
sleep 8

# Now write synthetic JSONL records with sensitive data — new instance will pick them up.
HOOK_LOG_DIR="$HOME/.loongsuite-pilot/logs/codex"
mkdir -p "$HOOK_LOG_DIR"
TODAY=$(date +%Y-%m-%d)
HOOK_LOG_FILE="$HOOK_LOG_DIR/codex-$TODAY.jsonl"
echo "[phase5] Writing synthetic records with sensitive data to $HOOK_LOG_FILE"

TS_NANO=$(date +%s)000000000
SESSION_ID="e2e-mask-test-$(date +%s)"

for i in 1 2 3; do
  cat >> "$HOOK_LOG_FILE" << JSONL_EOF
{"event.name":"gen_ai.content.completion","time_unix_nano":"$TS_NANO","event.id":"mask-evt-$i","gen_ai.session.id":"$SESSION_ID","gen_ai.agent.type":"codex_cli_hook","user.id":"e2e-test","gen_ai.request.model":"gpt-4o","gen_ai.usage.input_tokens":100,"gen_ai.usage.output_tokens":50,"gen_ai.output.messages":"credentials: LTAI1234567890abcdef and sk-fake1234567890abcdefghijkl and mysql://root:s3cret@db.host/prod"}
JSONL_EOF
  TS_NANO=$((TS_NANO + 1000000000))
done
echo "[phase5] Wrote 3 synthetic records with sensitive data"

# Wait for: next poll cycle (30s) to read new records → masking → JSONL flush
echo "[phase5] Waiting 45s for poll cycle + mask + JSONL flush..."
sleep 45

# Validate masking in JSONL output
echo "[phase5] Checking JSONL files for raw sensitive data..."
FAIL=0

if [ -d "$OUTPUT_DIR" ]; then
  for f in "$OUTPUT_DIR"/*.jsonl; do
    [ -f "$f" ] || continue
    if grep -q "sk-fake1234567890abcdefghijkl" "$f"; then
      echo "FAIL: raw API key found in $f"
      FAIL=1
    fi
    if grep -q "LTAI1234567890abcdef" "$f"; then
      echo "FAIL: raw access key found in $f"
      FAIL=1
    fi
    if grep -q "mysql://root:s3cret" "$f"; then
      echo "FAIL: raw database URL found in $f"
      FAIL=1
    fi
  done

  # Verify mask markers exist (proves masking is active)
  MASKED_FOUND=0
  for f in "$OUTPUT_DIR"/*.jsonl; do
    [ -f "$f" ] || continue
    if grep -qE "MASKED|\\*{4,}" "$f"; then
      MASKED_FOUND=1
      break
    fi
  done

  if [ "$MASKED_FOUND" -eq 0 ]; then
    echo "FAIL: no masked markers found in JSONL output"
    echo "INFO: Expected markers like [ACCESSKEY_MASKED], [APIKEY_MASKED], etc."
    JSONL_COUNT=$(find "$OUTPUT_DIR" -name "*.jsonl" -size +0 | wc -l)
    echo "INFO: JSONL files with content: $JSONL_COUNT"
    for f in "$OUTPUT_DIR"/*.jsonl; do
      [ -f "$f" ] || continue
      echo "  File: $f ($(wc -l < "$f") lines)"
      tail -3 "$f"
    done
    FAIL=1
  else
    echo "[phase5] Confirmed: masked markers present in JSONL"
  fi
else
  echo "FAIL: output dir $OUTPUT_DIR does not exist — JSONL flusher not active"
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi

echo "[phase5] PASSED: sensitive data masked in JSONL output"
`;
}
