#!/usr/bin/env bash
# ============================================================
# IDE L1 E2E Runner — local test for IDE-based agent data collection
#
# Sends real conversations to desktop IDE tools via ai-chat.sh,
# then verifies pilot collected the data into JSONL output files.
#
# Usage:
#   ./scripts/e2e/run-ide-e2e.sh                # auto-detect available tools
#   IDE_E2E_TOOLS=qoderwork ./scripts/e2e/run-ide-e2e.sh   # test specific tool(s)
#
# Environment variables:
#   IDE_E2E_TOOLS          comma-separated: qoderwork,cursor,qoder-ide (default: auto-detect)
#   IDE_E2E_PROMPT         custom test prompt (default: built-in)
#   IDE_E2E_FLUSH_TIMEOUT  seconds to wait for pilot flush (default: 120)
#   IDE_E2E_JSONL_STRICT   set to 1 to fail on any JSONL field issues
#
# Prerequisites:
#   - loongsuite-pilot running locally
#   - At least one IDE tool available (QoderWork / Cursor / Qoder IDE)
#   - node on PATH (for JSONL field validation)
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AI_CHAT="$SCRIPT_DIR/ai-chat.sh"
LOG_DIR="${HOME}/.loongsuite-pilot/logs/output"
FLUSH_TIMEOUT="${IDE_E2E_FLUSH_TIMEOUT:-120}"
TEST_PROMPT="${IDE_E2E_PROMPT:-e2e-ide-test: explain what is 1+1, reply in one sentence}"
JSONL_STRICT="${IDE_E2E_JSONL_STRICT:-0}"

# Tool name → JSONL agent-type prefix mapping (Bash 3.2 compatible)
# Qoder IDE uses QoderInput (agentType='qoder'), not QoderCnInput ('qoder-cn')
tool_to_agent() {
  case "$1" in
    qoderwork)  echo "qoder-work" ;;
    cursor)     echo "cursor" ;;
    qoder-ide)  echo "qoder" ;;
    *)          echo "" ;;
  esac
}

ALL_TOOLS="qoderwork cursor qoder-ide"

# ── Helpers ──────────────────────────────────────────────────

log()  { echo "[ide-e2e] $*"; }
ok()   { echo "[ide-e2e] ✓ $*"; }
fail() { echo "[ide-e2e] ✗ $*"; }
die()  { fail "$@"; exit 1; }

today() { date +%Y-%m-%d; }

jsonl_file_for_agent() {
  echo "${LOG_DIR}/${1}-$(today).jsonl"
}

line_count() {
  if [ -f "$1" ]; then
    wc -l < "$1" | tr -d ' '
  else
    echo "0"
  fi
}

# State storage using temp files (Bash 3.2 compatible — no associative arrays)
STATE_DIR="$(mktemp -d)"
trap 'rm -rf "$STATE_DIR"' EXIT

set_state() { echo "$3" > "$STATE_DIR/${1}_${2}"; }
get_state() { cat "$STATE_DIR/${1}_${2}" 2>/dev/null || echo "${3:-}"; }

# ── Phase 1: Preflight ──────────────────────────────────────

log "=== IDE L1 E2E Test ==="
log "Date: $(today)"

if ! command -v node >/dev/null 2>&1; then
  die "node not found on PATH (required for JSONL validation)"
fi

# Qoder IDE CDP mode needs python3 + websockets
if python3 -c "import websockets" 2>/dev/null; then
  ok "python3 websockets available (needed for Qoder IDE CDP)"
else
  log "  python3 websockets not installed — Qoder IDE tests will be skipped"
  log "  install with: pip3 install websockets"
fi

if [ ! -x "$AI_CHAT" ]; then
  die "ai-chat.sh not found or not executable: $AI_CHAT"
fi

if ! loongsuite-pilot status >/dev/null 2>&1; then
  die "loongsuite-pilot is not running. Start it first."
fi
ok "pilot is running"

mkdir -p "$LOG_DIR" 2>/dev/null || true

# ── Phase 2: Probe available tools ──────────────────────────

AVAILABLE_TOOLS=""

if [ -n "${IDE_E2E_TOOLS:-}" ]; then
  PROBE_TOOLS="$(echo "$IDE_E2E_TOOLS" | tr ',' ' ')"
else
  PROBE_TOOLS="$ALL_TOOLS"
fi

log "Probing tools: $PROBE_TOOLS"

for tool in $PROBE_TOOLS; do
  tool="$(echo "$tool" | tr -d ' ')"
  # Qoder IDE and Cursor CDP mode require python3 websockets
  if [ "$tool" = "qoder-ide" ] || [ "$tool" = "cursor" ]; then
    if ! python3 -c "import websockets" 2>/dev/null; then
      log "  $tool — skipped (python3 websockets not installed)"
      continue
    fi
  fi
  # Cursor: use CDP status check instead of cursor-agent CLI
  if [ "$tool" = "cursor" ]; then
    if CURSOR_CDP=true bash "$AI_CHAT" "$tool" --status >/dev/null 2>&1; then
      ok "$tool is available (CDP mode)"
      AVAILABLE_TOOLS="$AVAILABLE_TOOLS $tool"
    else
      log "  $tool — CDP not available (skipped)"
    fi
  elif bash "$AI_CHAT" "$tool" --status >/dev/null 2>&1; then
    ok "$tool is available"
    AVAILABLE_TOOLS="$AVAILABLE_TOOLS $tool"
  else
    log "  $tool — not available (skipped)"
  fi
done

AVAILABLE_TOOLS="$(echo "$AVAILABLE_TOOLS" | sed 's/^ *//')"

if [ -z "$AVAILABLE_TOOLS" ]; then
  die "No IDE tools available. At least one of $ALL_TOOLS must be running."
fi

log "Available tools: $AVAILABLE_TOOLS"

# ── Phase 3: Record baseline ────────────────────────────────

BASELINE_TS="$(date +%s)"

for tool in $AVAILABLE_TOOLS; do
  agent="$(tool_to_agent "$tool")"
  f="$(jsonl_file_for_agent "$agent")"
  bl="$(line_count "$f")"
  set_state baseline "$tool" "$bl"
  log "  baseline $agent: $bl lines ($(basename "$f"))"

  if [ "$tool" = "cursor" ]; then
    f2="$(jsonl_file_for_agent "cursor-cli")"
    set_state baseline "cursor-cli" "$(line_count "$f2")"
  fi
done

# ── Phase 4: Send test conversations & capture replies ─────

log ""
log "=== Sending test conversations ==="

for tool in $AVAILABLE_TOOLS; do
  log "  chatting with $tool ..."
  chat_env=""
  if [ "$tool" = "qoder-ide" ]; then
    chat_env="QODER_IDE_CDP=true"
  fi
  if [ "$tool" = "cursor" ]; then
    chat_env="CURSOR_CDP=true"
  fi

  reply_file="$STATE_DIR/reply_${tool}"
  log_file="$STATE_DIR/log_${tool}"
  if env $chat_env bash "$AI_CHAT" "$tool" "$TEST_PROMPT" > "$reply_file" 2>"$log_file"; then
    reply_text="$(grep -v '^$' "$reply_file" | tail -1 || true)"
    ok "$tool — reply: ${reply_text:0:120}"
    set_state chat "$tool" "ok"
    set_state reply "$tool" "$reply_text"
  else
    fail "$tool conversation failed (exit $?)"
    tail -3 "$log_file"
    set_state chat "$tool" "chat_failed"
  fi
  sleep 3
done

# ── Phase 5: Wait for pilot to flush JSONL ───────────────────

log ""
log "=== Waiting for pilot to flush (timeout: ${FLUSH_TIMEOUT}s) ==="

elapsed=0
all_flushed=false

while [ "$elapsed" -lt "$FLUSH_TIMEOUT" ]; do
  all_flushed=true
  for tool in $AVAILABLE_TOOLS; do
    [ "$(get_state chat "$tool")" != "ok" ] && continue

    agent="$(tool_to_agent "$tool")"
    f="$(jsonl_file_for_agent "$agent")"
    cur="$(line_count "$f")"
    baseline="$(get_state baseline "$tool")"

    if [ "$tool" = "cursor" ] && [ "$cur" -le "$baseline" ]; then
      f2="$(jsonl_file_for_agent "cursor-cli")"
      cur2="$(line_count "$f2")"
      baseline2="$(get_state baseline "cursor-cli" "0")"
      if [ "$cur2" -gt "$baseline2" ]; then
        cur="$cur2"
        baseline="$baseline2"
      fi
    fi

    if [ "$cur" -le "$baseline" ]; then
      all_flushed=false
    fi
  done

  if $all_flushed; then
    break
  fi

  sleep 5
  elapsed=$((elapsed + 5))
  if [ $((elapsed % 30)) -eq 0 ]; then
    log "  still waiting... (${elapsed}s / ${FLUSH_TIMEOUT}s)"
  fi
done

if $all_flushed; then
  ok "all JSONL files received new data (${elapsed}s)"
else
  log "WARNING: flush timeout reached — some tools may not have produced data"
fi

# ── Phase 6: Validate replies ──────────────────────────────

log ""
log "=== Reply Validation ==="

REPLY_OK=0
REPLY_FAIL=0

for tool in $AVAILABLE_TOOLS; do
  if [ "$(get_state chat "$tool")" != "ok" ]; then
    fail "$tool — no reply (chat failed)"
    REPLY_FAIL=$((REPLY_FAIL + 1))
    continue
  fi

  reply="$(get_state reply "$tool" "")"
  if [ -n "$reply" ]; then
    ok "$tool — got reply (${#reply} chars)"
    REPLY_OK=$((REPLY_OK + 1))
  else
    fail "$tool — empty reply"
    REPLY_FAIL=$((REPLY_FAIL + 1))
  fi
done

log "  replies: ${REPLY_OK} ok, ${REPLY_FAIL} failed"

# ── Phase 7: Validate JSONL entries ──────────────────────────

log ""
log "=== JSONL Validation ==="

TESTED=0
PASSED=0
SKIPPED=0
FAILED_TOOLS=""
SKIPPED_TOOLS=""

for tool in $AVAILABLE_TOOLS; do
  if [ "$(get_state chat "$tool")" != "ok" ]; then
    fail "$tool — skipped (chat failed)"
    FAILED_TOOLS="$FAILED_TOOLS $tool"
    TESTED=$((TESTED + 1))
    continue
  fi

  agent="$(tool_to_agent "$tool")"
  f="$(jsonl_file_for_agent "$agent")"
  baseline="$(get_state baseline "$tool")"

  actual_file="$f"
  if [ "$tool" = "cursor" ]; then
    cur="$(line_count "$f")"
    f2="$(jsonl_file_for_agent "cursor-cli")"
    cur2="$(line_count "$f2")"
    baseline2="$(get_state baseline "cursor-cli" "0")"
    if [ "$cur" -le "$baseline" ] && [ "$cur2" -gt "$baseline2" ]; then
      actual_file="$f2"
      baseline="$baseline2"
      agent="cursor-cli"
    fi
  fi

  cur_lines="$(line_count "$actual_file")"
  new_lines=$((cur_lines - baseline))
  TESTED=$((TESTED + 1))

  if [ "$new_lines" -le 0 ]; then
    fail "$tool ($agent) — no new JSONL entries after conversation"
    FAILED_TOOLS="$FAILED_TOOLS $tool"
    continue
  fi

  log "  $tool ($agent): +${new_lines} new entries in $(basename "$actual_file")"

  tool_ok=true
  validation_output=$(tail -n "$new_lines" "$actual_file" | node -e "
'use strict';
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });

const REQUIRED = [
  'time_unix_nano', 'event.id', 'user.id', 'event.name',
  'gen_ai.session.id', 'gen_ai.agent.type', 'gen_ai.provider.name',
];
const EVENT_NAME_ENUM = new Set([
  'llm.request', 'llm.response', 'tool.call', 'tool.result',
  'skill.use', 'tool.approve', 'other',
]);
const EXPECTED_AGENT = '${agent}';
const STRICT = '${JSONL_STRICT}' === '1';

let total = 0, missingCount = 0, badEnum = 0, parseErr = 0, agentMismatch = 0;
const missingSamples = [];

rl.on('line', (line) => {
  if (!line.trim()) return;
  let entry;
  try { entry = JSON.parse(line); } catch { parseErr++; return; }
  total++;
  const miss = REQUIRED.filter(k => entry[k] === undefined || entry[k] === null || entry[k] === '');
  if (miss.length) {
    missingCount++;
    if (missingSamples.length < 3) missingSamples.push({ missing: miss, eventId: entry['event.id'] || '<no-id>' });
  }
  const en = entry['event.name'];
  if (en !== undefined && !EVENT_NAME_ENUM.has(en)) badEnum++;
  const at = entry['gen_ai.agent.type'];
  if (at && at !== EXPECTED_AGENT) agentMismatch++;
});

rl.on('close', () => {
  console.log('    entries=' + total + ' missing_required=' + missingCount + ' bad_event_name=' + badEnum + ' parse_errors=' + parseErr + ' agent_mismatch=' + agentMismatch);
  if (missingSamples.length) {
    for (const s of missingSamples) console.log('    sample: eventId=' + s.eventId + ' missing=[' + s.missing.join(',') + ']');
  }
  const failed = missingCount > 0 || badEnum > 0 || parseErr > 0;
  if (failed && STRICT) process.exit(1);
  if (total === 0) { console.log('    WARNING: 0 parseable entries'); process.exit(1); }
  process.exit(0);
});
" 2>&1) || tool_ok=false

  echo "$validation_output"

  if $tool_ok; then
    ok "$tool ($agent) — PASSED"
    PASSED=$((PASSED + 1))
  else
    fail "$tool ($agent) — FAILED"
    FAILED_TOOLS="$FAILED_TOOLS $tool"
  fi
done

# ── Phase 8: Summary ─────────────────────────────────────────

log ""
log "============================================"
log "  IDE E2E Summary"
log "  tools tested:  $TESTED"
log "  replies:       ${REPLY_OK} ok / ${REPLY_FAIL} failed"
log "  JSONL passed:  $PASSED"
log "  JSONL failed:  $((TESTED - PASSED))"
if [ -n "$FAILED_TOOLS" ]; then
  log "  failed tools: $FAILED_TOOLS"
fi
log "============================================"

# Run full JSONL validator (same as CLI e2e) scoped to tested agents
agent_filter=""
for tool in $AVAILABLE_TOOLS; do
  [ "$(get_state chat "$tool")" != "ok" ] && continue
  agent="$(tool_to_agent "$tool")"
  agent_filter="${agent_filter:+$agent_filter,}$agent"
  [ "$tool" = "cursor" ] && agent_filter="$agent_filter,cursor-cli"
done

if [ -n "$agent_filter" ]; then
  log ""
  log "=== Full JSONL schema validation (agents: $agent_filter) ==="
  since_seconds=$(( $(date +%s) - BASELINE_TS + 60 ))
  E2E_JSONL_AGENT_FILTER="$agent_filter" \
  E2E_JSONL_SINCE_SECONDS="$since_seconds" \
  E2E_JSONL_STRICT="$JSONL_STRICT" \
    node -e "$(cat <<'JSEOF'
'use strict';
const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env._JV_LOG_DIR || (process.env.HOME + '/.loongsuite-pilot/logs/output');
const SINCE_SECONDS = parseInt(process.env.E2E_JSONL_SINCE_SECONDS || '0', 10);
const STRICT = (process.env.E2E_JSONL_STRICT || '0') === '1';
const _RAW_FILTER = process.env.E2E_JSONL_AGENT_FILTER;
const _FILTER_SRC = (_RAW_FILTER === undefined || _RAW_FILTER === '') ? 'all' : _RAW_FILTER;
const AGENT_FILTER = (_FILTER_SRC.trim().toLowerCase() === 'all' || _FILTER_SRC.trim() === '*')
  ? []
  : _FILTER_SRC.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const MAX_SAMPLES = 3;

const REQUIRED = [
  'time_unix_nano', 'event.id', 'user.id', 'event.name',
  'gen_ai.session.id', 'gen_ai.agent.type', 'gen_ai.provider.name',
];
const EVENT_NAME_ENUM = new Set([
  'llm.request', 'llm.response', 'tool.call', 'tool.result',
  'skill.use', 'tool.approve', 'other',
]);
const OPTIONAL_COVERAGE = [
  'trace_id', 'span_id', 'gen_ai.request.model', 'gen_ai.response.model',
  'gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens', 'gen_ai.usage.total_tokens',
];

function listJsonl(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => path.join(dir, f));
}

function matchesAgentFilter(file) {
  if (!AGENT_FILTER.length) return true;
  const base = path.basename(file, '.jsonl').toLowerCase();
  return AGENT_FILTER.some(a => base.startsWith(a + '-') || base === a);
}

function withinWindow(entry) {
  if (!SINCE_SECONDS || SINCE_SECONDS <= 0) return true;
  const ns = entry && entry.time_unix_nano;
  if (!ns || typeof ns !== 'string') return true;
  const ms = Number(ns.slice(0, -6)) || 0;
  return (Date.now() - ms) <= SINCE_SECONDS * 1000;
}

function pct(num, total) {
  if (!total) return '0.0%';
  return ((num / total) * 100).toFixed(1) + '%';
}

const files = listJsonl(LOG_DIR).filter(matchesAgentFilter);
if (!files.length) {
  console.log('[jsonl-validate] no .jsonl files in ' + LOG_DIR + (AGENT_FILTER.length ? ' (filter=' + AGENT_FILTER.join(',') + ')' : ''));
  process.exit(STRICT ? 1 : 0);
}

let totalEntries = 0, totalWindowed = 0, totalMissing = 0, totalBadEnum = 0, totalParseErr = 0;
const globalEventName = Object.create(null);
const globalAgentType = Object.create(null);
const globalProvider = Object.create(null);
const globalCoverage = Object.create(null);
OPTIONAL_COVERAGE.forEach(k => { globalCoverage[k] = 0; });
const missingSamples = [];

for (const file of files) {
  const base = path.basename(file);
  let entries = 0, windowed = 0, missing = 0, badEnum = 0, parseErr = 0;
  const eventName = Object.create(null);
  const raw = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of raw) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { parseErr++; totalParseErr++; continue; }
    entries++; totalEntries++;
    if (!withinWindow(entry)) continue;
    windowed++; totalWindowed++;
    const miss = REQUIRED.filter(k => entry[k] === undefined || entry[k] === null || entry[k] === '');
    if (miss.length) {
      missing++; totalMissing++;
      if (missingSamples.length < MAX_SAMPLES) missingSamples.push({ file: base, missing: miss, eventId: entry['event.id'] || '<no-id>' });
    }
    const en = entry['event.name'];
    if (en !== undefined && !EVENT_NAME_ENUM.has(en)) { badEnum++; totalBadEnum++; }
    if (en) eventName[en] = (eventName[en] || 0) + 1;
    if (en) globalEventName[en] = (globalEventName[en] || 0) + 1;
    const at = entry['gen_ai.agent.type']; if (at) globalAgentType[at] = (globalAgentType[at] || 0) + 1;
    const pr = entry['gen_ai.provider.name']; if (pr) globalProvider[pr] = (globalProvider[pr] || 0) + 1;
    for (const k of OPTIONAL_COVERAGE) if (entry[k] !== undefined && entry[k] !== null && entry[k] !== '') globalCoverage[k]++;
  }
  const tag = missing || badEnum || parseErr ? 'FAIL' : 'OK';
  const summary = Object.entries(eventName).map(([k, v]) => k + '=' + v).join(', ') || '<none>';
  console.log('[jsonl-validate] ' + tag + ' ' + base + ' entries=' + entries + ' windowed=' + windowed + ' missing=' + missing + ' badEnum=' + badEnum + ' parseErr=' + parseErr + ' event.name{' + summary + '}');
}

console.log('');
console.log('=== [jsonl-validate] summary ===');
console.log('  files=' + files.length + ' entries=' + totalEntries + ' windowed=' + totalWindowed);
console.log('  missing_required=' + totalMissing + ' (' + pct(totalMissing, totalWindowed) + ')');
console.log('  bad_event_name=' + totalBadEnum + ' parse_errors=' + totalParseErr);
console.log('  event.name: ' + (Object.entries(globalEventName).map(([k, v]) => k + '=' + v).join(', ') || '<none>'));
console.log('  gen_ai.agent.type: ' + (Object.entries(globalAgentType).map(([k, v]) => k + '=' + v).join(', ') || '<none>'));
console.log('  gen_ai.provider.name: ' + (Object.entries(globalProvider).map(([k, v]) => k + '=' + v).join(', ') || '<none>'));
console.log('  optional field coverage (of windowed):');
for (const k of OPTIONAL_COVERAGE) console.log('    ' + k + '=' + globalCoverage[k] + ' (' + pct(globalCoverage[k], totalWindowed) + ')');
if (missingSamples.length) {
  console.log('  missing samples (up to ' + MAX_SAMPLES + '):');
  for (const s of missingSamples) console.log('    - ' + s.file + ' eventId=' + s.eventId + ' missing=[' + s.missing.join(',') + ']');
}

const failed = totalMissing > 0 || totalBadEnum > 0 || totalParseErr > 0;
if (failed && STRICT) {
  console.error('[jsonl-validate] STRICT: failures detected → exit 1');
  process.exit(1);
}
process.exit(0);
JSEOF
)"
fi

if [ "$PASSED" -eq "$TESTED" ] && [ "$TESTED" -gt 0 ] && [ "$REPLY_FAIL" -eq 0 ]; then
  log ""
  ok "IDE E2E test PASSED ($PASSED/$TESTED tools, ${REPLY_OK} replies)"
  exit 0
else
  log ""
  fail "IDE E2E test FAILED (JSONL: $PASSED/$TESTED, replies: ${REPLY_OK} ok / ${REPLY_FAIL} failed)"
  exit 1
fi
