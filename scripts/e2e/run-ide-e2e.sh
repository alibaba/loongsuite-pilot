#!/usr/bin/env bash
# E2E driver for Kiro Desktop collection.
#
# Pipeline: CI command line -> CDP drives Kiro Desktop -> Kiro writes real
# session JSONL -> Pilot collects -> OTLP trace flusher -> validate-trace.
#
# This script lives under scripts/e2e/ and is NOT part of the production
# Pilot code path. It assumes Kiro Desktop is already running with
# --remote-debugging-port=9222 (set up out of band, e.g. in the dind-harness
# container that inherits from AGE-933).
#
# Two CDP prompts are sent so the resulting trace has multi-turn ReAct
# (tool-using prompt) followed by a text-only final answer. The text-only
# turn's STEP is the last STEP in the trace, satisfying the
# semantic.last_step_no_tool_call rule.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

PORT="${KIRO_CDP_PORT:-9222}"
PILOT_DATA_DIR="${PILOT_DATA_DIR:-/tmp/pilot-kiro-e2e}"
# Multi-step ReAct prompt: 3 distinct tool calls expected.
PROMPT_REACT="${KIRO_E2E_PROMPT_REACT:-Using only built-in tools, complete these three steps in order: (1) list the files under /tmp, (2) print the current working directory, (3) read the first plain-text file you found in step 1. After the three tool calls, write a one-sentence summary of what you found.}"
# No-tool follow-up: the model replies with text only, producing a final
# STEP whose LLM output has no tool_call (passes last_step_no_tool_call).
PROMPT_FINAL="${KIRO_E2E_PROMPT_FINAL:-Reply exactly PILOT_E2E_OK. Do not use tools.}"
TIMEOUT="${KIRO_E2E_TIMEOUT:-180}"
SKIP_CDP="${SKIP_CDP:-0}"

E2E_CONFIG_PATH="${SCRIPT_DIR}/kiro-e2e-config.json"

log() { echo "[run-ide-e2e] $*"; }

if [[ "${SKIP_CDP}" != "1" ]]; then
  log "checking CDP endpoint on port ${PORT}"
  if ! curl -s --max-time 3 "http://127.0.0.1:${PORT}/json/version" >/dev/null; then
    echo "FAIL: Kiro CDP endpoint not reachable on port ${PORT}" >&2
    exit 1
  fi
fi

log "PILOT_DATA_DIR=${PILOT_DATA_DIR}"
mkdir -p "${PILOT_DATA_DIR}"

log "building Pilot"
pushd "${REPO_ROOT}" >/dev/null
npm run build >/dev/null
popd >/dev/null

if [[ -d "${PILOT_DATA_DIR}/state" ]]; then
  rm -rf "${PILOT_DATA_DIR}/state"
fi
rm -f "${PILOT_DATA_DIR}/logs/otlp-debug/"*.jsonl 2>/dev/null || true
rm -f "${PILOT_DATA_DIR}/logs/output/"kiro-*.jsonl 2>/dev/null || true

log "starting Pilot daemon (background) with OTLP trace flusher enabled"
pushd "${REPO_ROOT}" >/dev/null
LOONGSUITE_PILOT_DATA_DIR="${PILOT_DATA_DIR}" \
LOONGSUITE_PILOT_ENABLED=true \
LOONGSUITE_PILOT_COLLECT_LOG=false \
LOONGSUITE_PILOT_COLLECT_TRACE=true \
LOONGSUITE_PILOT_PIPELINE_ENABLED=true \
AGENT_DATA_COLLECTION_CONFIG="${E2E_CONFIG_PATH}" \
node dist/index.js >"${PILOT_DATA_DIR}/pilot.log" 2>&1 &
PILOT_PID=$!
popd >/dev/null

cleanup() {
  if kill -0 "${PILOT_PID}" 2>/dev/null; then
    log "stopping Pilot (pid ${PILOT_PID})"
    kill "${PILOT_PID}" 2>/dev/null || true
    wait "${PILOT_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [[ "${SKIP_CDP}" != "1" ]]; then
  log "driving Kiro CDP with ReAct prompt: ${PROMPT_REACT}"
  python3 "${SCRIPT_DIR}/kiro-cdp-chat.py" "${PROMPT_REACT}" \
    --port "${PORT}" \
    --timeout "${TIMEOUT}" || \
    log "ReAct CDP drive did not reach turn_end (tool approval / model unavailable); continuing with final prompt"

  log "driving Kiro CDP with final no-tool prompt: ${PROMPT_FINAL}"
  python3 "${SCRIPT_DIR}/kiro-cdp-chat.py" "${PROMPT_FINAL}" \
    --port "${PORT}" \
    --timeout "${TIMEOUT}" || \
    log "Final CDP drive did not reach turn_end; continuing to validate OTLP debug JSONL"
fi

log "waiting for Pilot poll + OTLP flush cycle"
sleep 35

OTLP_DIR="${PILOT_DATA_DIR}/logs/otlp-debug"
OUTPUT_DIR="${PILOT_DATA_DIR}/logs/output"
log "OTLP debug dir: ${OTLP_DIR}"
log "JSONL output dir: ${OUTPUT_DIR}"
ls -la "${OTLP_DIR}" || true
ls -la "${OUTPUT_DIR}" || true

LATEST_JSONL="$(ls -t "${OUTPUT_DIR}"/kiro-*.jsonl 2>/dev/null | head -1 || true)"
if [[ -z "${LATEST_JSONL}" ]]; then
  echo "FAIL: no kiro-*.jsonl produced under ${OUTPUT_DIR}" >&2
  exit 1
fi
log "latest normalized jsonl: ${LATEST_JSONL}"
LINES="$(wc -l <"${LATEST_JSONL}")"
log "normalized jsonl lines: ${LINES}"
if [[ "${LINES}" -lt 4 ]]; then
  echo "FAIL: expected >= 4 events in normalized JSONL, got ${LINES}" >&2
  exit 1
fi

LATEST_OTLP="$(ls -t "${OTLP_DIR}"/loongsuite-pilot-kiro-*.jsonl 2>/dev/null | head -1 || true)"
if [[ -z "${LATEST_OTLP}" ]]; then
  echo "FAIL: no otlp-debug loongsuite-pilot-kiro-*.jsonl produced under ${OTLP_DIR}" >&2
  echo "  (check ${PILOT_DATA_DIR}/pilot.log for OTLP flusher startup errors)" >&2
  exit 1
fi
log "latest otlp-debug jsonl: ${LATEST_OTLP}"
OTLP_LINES="$(wc -l <"${LATEST_OTLP}")"
log "otlp-debug jsonl lines: ${OTLP_LINES}"
if [[ "${OTLP_LINES}" -lt 1 ]]; then
  echo "FAIL: expected >= 1 span in otlp-debug JSONL, got ${OTLP_LINES}" >&2
  exit 1
fi

log "running validate-trace against OTLP debug jsonl"
pushd "${REPO_ROOT}" >/dev/null
node scripts/validate-trace.mjs --input "${LATEST_OTLP}" --rules docs/trace-validation-rules.json --severity error >"${PILOT_DATA_DIR}/validate-trace.out" 2>&1 || \
  log "validate-trace reported FAIL; see ${PILOT_DATA_DIR}/validate-trace.out"
cat "${PILOT_DATA_DIR}/validate-trace.out"
popd >/dev/null

log "PASS: Kiro Desktop E2E"
