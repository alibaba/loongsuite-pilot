#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Qoder CLI Hook Script
# ============================================================================
# This script is injected into Qoder CLI's settings.json as a PostToolUse hook.
# It intercepts tool execution events and writes them to JSONL log files.
#
# Installation:
#   The HookManager class automatically installs this script to ~/.ai-agent-collector/hooks/
#   and injects the hook command into ~/.qoder/settings.json
#
# Output:
#   ~/.ai-agent-collector/logs/qoder-cli/history/qoder-cli-{YYYY-MM-DD}.jsonl
# ============================================================================

# Resolve cache directory
resolve_cache_dir() {
  if [[ -n "${AAC_CACHE_DIR:-}" ]]; then
    printf '%s' "$AAC_CACHE_DIR"
    return
  fi

  local home="${HOME:-}"
  local target=".ai-agent-collector"
  if [[ -n "$home" ]]; then
    target="$home/.ai-agent-collector"
  fi

  if mkdir -p "$target" 2>/dev/null; then
    printf '%s' "$target"
    return
  fi

  local fallback="${PWD:-.}/.ai-agent-collector"
  mkdir -p "$fallback"
  printf '%s' "$fallback"
}

# Read payload from stdin
read_payload() {
  if [[ -t 0 ]]; then
    printf ''
    return
  fi
  cat || true
}

# Main execution
CACHE_DIR="$(resolve_cache_dir)"
HISTORY_DIR="$CACHE_DIR/logs/qoder-cli/history"
PRE_STATE_DIR="$CACHE_DIR/logs/qoder-cli/state/pre"
DEDUP_DIR="$CACHE_DIR/logs/qoder-cli/state/dedup"

mkdir -p "$HISTORY_DIR" "$PRE_STATE_DIR" "$DEDUP_DIR"

PAYLOAD_RAW="$(read_payload)"
PAYLOAD_RAW="${PAYLOAD_RAW//$'\r'/}"

# Trim whitespace
TRIMMED="$(printf '%s' "$PAYLOAD_RAW" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
if [[ -z "$TRIMMED" ]]; then
  exit 0
fi

# Validate JSON (basic check)
FIRST_CHAR="${TRIMMED:0:1}"
LAST_CHAR="${TRIMMED: -1}"
if [[ "$FIRST_CHAR" != "{" ]] || [[ "$LAST_CHAR" != "}" ]]; then
  # Might be wrapped in markdown code blocks
  if [[ "$TRIMMED" == '```'* ]]; then
    TRIMMED="$(printf '%s' "$TRIMMED" | sed '1d;$d' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    FIRST_CHAR="${TRIMMED:0:1}"
    LAST_CHAR="${TRIMMED: -1}"
    if [[ "$FIRST_CHAR" != "{" ]] || [[ "$LAST_CHAR" != "}" ]]; then
      exit 0
    fi
  else
    exit 0
  fi
fi

# Use Python for JSON processing (more robust)
python3 - "$HISTORY_DIR" "$PRE_STATE_DIR" "$DEDUP_DIR" <<'PYTHON_SCRIPT'
import sys
import os
import json
import hashlib
import datetime
import uuid

def sha1_text(text):
    return hashlib.sha1(text.encode('utf-8')).hexdigest()

def normalize_tool_name(raw):
    if not raw or not isinstance(raw, str):
        return ''
    s = raw.strip().lower()
    if not s:
        return ''
    s = s.replace('-', '_')
    tool_map = {
        'write': 'Edit',
        'edit': 'Edit',
        'str_replace': 'Edit',
        'str_replace_editor': 'Edit',
        'write_to_file': 'Write',
        'create_file': 'Create',
        'create': 'Create',
        'delete': 'Delete',
        'read': 'Read',
        'read_file': 'Read',
    }
    return tool_map.get(s, s.title())

def resolve_tool_input(payload):
    ti = payload.get('tool_input') or payload.get('toolInput') or {}
    if isinstance(ti, str):
        try:
            ti = json.loads(ti)
        except Exception:
            ti = {}
    if not isinstance(ti, dict):
        ti = {}
    return ti

def resolve_file_path(tool_input):
    for key in ['file_path', 'path', 'filepath', 'target_path']:
        val = tool_input.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return ''

def read_file_content(file_path):
    try:
        with open(file_path, 'r', encoding='utf-8', errors='replace') as f:
            return f.read()
    except Exception:
        return ''

def get_file_sha1(file_path):
    try:
        with open(file_path, 'rb') as f:
            return hashlib.sha1(f.read()).hexdigest()
    except Exception:
        return ''

TRACKED_FILE_TOOLS = {'Create', 'Write', 'Edit', 'Delete', 'Read'}
SHELL_TOOLS = {'Bash', 'Shell', 'Terminal', 'Run'}

raw = sys.stdin.read() if not sys.stdin.isatty() else ''
if not raw.strip():
    sys.exit(0)

try:
    payload = json.loads(raw)
except Exception:
    sys.exit(0)

if not isinstance(payload, dict):
    sys.exit(0)

event_name = payload.get('hook_event_name') or payload.get('hookEvent') or ''
if event_name not in ('PreToolUse', 'PostToolUse', 'PostToolUseFailure'):
    sys.exit(0)

tool_name_raw = payload.get('tool_name') or payload.get('toolName') or ''
tool_name = normalize_tool_name(tool_name_raw)
if not tool_name:
    sys.exit(0)

if tool_name not in TRACKED_FILE_TOOLS and tool_name not in SHELL_TOOLS:
    sys.exit(0)

tool_input = resolve_tool_input(payload)
file_path = resolve_file_path(tool_input)

now = datetime.datetime.utcnow()
log_time = now.strftime('%Y-%m-%dT%H:%M:%SZ')
utc_day = now.strftime('%Y-%m-%d')

history_dir = sys.argv[1]
pre_state_dir = sys.argv[2]
dedup_dir = sys.argv[3]

# Build operation key for dedup
operation_key = f"{event_name}|{tool_name}|{file_path}|{log_time}"
dedup_hash = sha1_text(operation_key)
dedup_path = os.path.join(dedup_dir, f'{dedup_hash}.mark')

# Check dedup
if os.path.exists(dedup_path):
    sys.exit(0)

try:
    with open(dedup_path, 'w', encoding='utf-8') as f:
        f.write(log_time)
except Exception:
    pass

# PreToolUse: capture file state
if event_name == 'PreToolUse' and tool_name in TRACKED_FILE_TOOLS and file_path:
    pre_state = {
        'captured_at': log_time,
        'file_path': file_path,
        'exists': os.path.exists(file_path),
    }
    if os.path.exists(file_path):
        pre_state['content'] = read_file_content(file_path)
        pre_state['sha1'] = get_file_sha1(file_path)
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                pre_state['line_count'] = sum(1 for _ in f)
        except Exception:
            pre_state['line_count'] = 0
    
    pre_state_path = os.path.join(pre_state_dir, f'{sha1_text(file_path)}.json')
    try:
        with open(pre_state_path, 'w', encoding='utf-8') as f:
            json.dump(pre_state, f, ensure_ascii=False)
    except Exception:
        pass

# PostToolUse: enrich with pre-state
if event_name in ('PostToolUse', 'PostToolUseFailure') and tool_name in TRACKED_FILE_TOOLS and file_path:
    pre_state_path = os.path.join(pre_state_dir, f'{sha1_text(file_path)}.json')
    if os.path.exists(pre_state_path):
        try:
            with open(pre_state_path, 'r', encoding='utf-8') as f:
                pre_state = json.load(f)
            if isinstance(pre_state, dict):
                payload['aac_pre_file_exists'] = pre_state.get('exists') is True
                payload['aac_pre_file_content'] = pre_state.get('content', '')
                payload['aac_pre_file_sha1'] = pre_state.get('sha1', '')
                payload['aac_pre_file_line_count'] = pre_state.get('line_count')
                payload['aac_pre_file_captured_at'] = pre_state.get('captured_at')
                payload['aac_pre_file_path'] = pre_state.get('file_path', file_path)
            # Clean up pre-state file
            try:
                os.remove(pre_state_path)
            except Exception:
                pass
        except Exception:
            pass

# Enrich payload
payload['capturedAt'] = payload.get('capturedAt') or log_time
payload['logTime'] = payload.get('logTime') or log_time
payload['aac_client_type'] = 'Qoder'
payload['aac_tool_name_normalized'] = tool_name

# Build record
record = {
    'uuid': str(uuid.uuid4()),
    'logTime': log_time,
    'reported': False,
    'clientType': 'Qoder',
    'hookEvent': event_name,
    'data': payload,
}

# Write to JSONL
log_file = os.path.join(history_dir, f'qoder-cli-{utc_day}.jsonl')
with open(log_file, 'a', encoding='utf-8') as f:
    f.write(json.dumps(record, ensure_ascii=False) + '\n')

PYTHON_SCRIPT

exit 0
