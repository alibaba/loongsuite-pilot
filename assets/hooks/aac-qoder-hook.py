#!/usr/bin/env python3
"""
Qoder CLI Hook Handler.

Intercepts PreToolUse / PostToolUse / PostToolUseFailure events from Qoder CLI,
captures pre-tool file state, enriches post-tool events with diff context,
and writes structured records to JSONL log files.

Optionally uploads to Alibaba Cloud SLS when configured.

Called by aac-qoder-hook.sh with cache_dir as argv[1] and
optional agent_id as argv[2] (defaults to "qoder-cli").
Reads hook payload JSON from stdin.
"""

import sys
import os
import json
import hashlib
import datetime
import uuid
import socket
import fcntl
import time
from typing import Optional, List, Tuple, Any

# ---------------------------------------------------------------------------
# SLS Configuration (placeholders — filled by install.sh)
# ---------------------------------------------------------------------------
SLS_ENDPOINT = ''
SLS_ACCESS_KEY_ID = ''
SLS_ACCESS_KEY = ''
SLS_PROJECT = ''
SLS_LOGSTORE = ''
ENABLE_SLS_UPLOAD = False
ENABLE_LOGGING = False

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
MAX_FIELD_LEN = 4096

TRACKED_FILE_TOOLS = {'Create', 'Write', 'Edit', 'Delete', 'Read'}
SHELL_TOOLS = {'Bash', 'Shell', 'Terminal', 'Run'}

TOOL_NAME_MAP = {
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

# ---------------------------------------------------------------------------
# Runtime state (resolved once in init_paths)
# ---------------------------------------------------------------------------
_agent_id = 'qoder-cli'
_history_dir = ''
_pre_state_dir = ''
_dedup_dir = ''
_log_file = ''
_sls_client = None


def init_paths(cache_dir: str, agent_id: str = 'qoder-cli'):
    """Create and cache all working directories."""
    global _agent_id, _history_dir, _pre_state_dir, _dedup_dir, _log_file
    _agent_id = agent_id
    base = os.path.join(cache_dir, 'logs', agent_id)
    _history_dir = os.path.join(base, 'history')
    _pre_state_dir = os.path.join(base, 'state', 'pre')
    _dedup_dir = os.path.join(base, 'state', 'dedup')
    _log_file = os.path.join(base, 'hook.log')
    os.makedirs(_history_dir, exist_ok=True)
    os.makedirs(_pre_state_dir, exist_ok=True)
    os.makedirs(_dedup_dir, exist_ok=True)


# ---------------------------------------------------------------------------
# Debug logging (with file locking, per qoder_hook.py pattern)
# ---------------------------------------------------------------------------
def log_debug(message: str):
    """Append a timestamped debug line with exclusive file lock."""
    if not ENABLE_LOGGING:
        return
    try:
        ts = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime())
        with open(_log_file, 'a', encoding='utf-8') as f:
            fcntl.flock(f.fileno(), fcntl.LOCK_EX)
            try:
                f.write(f"[{ts}] {message}\n")
            finally:
                fcntl.flock(f.fileno(), fcntl.LOCK_UN)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Data serialization (per qoder_hook.py pattern)
# ---------------------------------------------------------------------------
def _trunc(v: str, limit: int = MAX_FIELD_LEN) -> str:
    return v if len(v) <= limit else v[:limit] + '...[truncated]'


def _serialize_value(v: Any) -> str:
    if v is None:
        return ''
    if isinstance(v, bool):
        return str(v).lower()
    if isinstance(v, (dict, list)):
        return _trunc(json.dumps(v, ensure_ascii=False))
    return _trunc(str(v))


def prepare_log_contents(
    data: dict, log_source: str = '',
) -> List[Tuple[str, str]]:
    """Flatten *data* into SLS-compatible key-value pairs."""
    contents: List[Tuple[str, str]] = []
    if log_source:
        contents.append(('log_source', log_source))

    session_id = data.get('session_id') or data.get('sessionId') or ''
    has_session_id = 'session_id' in data

    for k, v in data.items():
        if v is None:
            continue
        contents.append((k, _serialize_value(v)))

    if session_id and not has_session_id:
        contents.append(('session_id', str(session_id)))

    return contents


# ---------------------------------------------------------------------------
# SLS upload (optional, per qoder_hook.py pattern)
# ---------------------------------------------------------------------------
def _get_sls_client():
    global _sls_client
    if _sls_client is not None:
        return _sls_client
    try:
        from aliyun.log import LogClient
        _sls_client = LogClient(SLS_ENDPOINT, SLS_ACCESS_KEY_ID, SLS_ACCESS_KEY)
        return _sls_client
    except ImportError:
        log_debug('aliyun-log-python-sdk not installed, SLS disabled')
        return None


def send_to_sls(record: dict) -> bool:
    """Upload a single record to SLS. No-op when SLS is not configured."""
    if not ENABLE_SLS_UPLOAD or not SLS_ENDPOINT:
        return False
    client = _get_sls_client()
    if client is None:
        return False
    try:
        from aliyun.log import LogItem, PutLogsRequest
        contents = prepare_log_contents(record, log_source='hook')
        item = LogItem()
        item.set_time(int(time.time()))
        item.set_contents(contents)
        req = PutLogsRequest(SLS_PROJECT, SLS_LOGSTORE, '', '', [item])
        req.set_log_tags([('__hostname__', socket.gethostname())])
        client.put_logs(req)
        log_debug('SLS upload OK')
        return True
    except Exception as e:
        log_debug(f'SLS upload failed: {e}')
        return False


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def sha1_text(text: str) -> str:
    return hashlib.sha1(text.encode('utf-8')).hexdigest()


def normalize_tool_name(raw: str) -> str:
    if not raw or not isinstance(raw, str):
        return ''
    s = raw.strip().lower().replace('-', '_')
    if not s:
        return ''
    return TOOL_NAME_MAP.get(s, s.title())


def resolve_tool_input(payload: dict) -> dict:
    ti = payload.get('tool_input') or payload.get('toolInput') or {}
    if isinstance(ti, str):
        try:
            ti = json.loads(ti)
        except Exception:
            ti = {}
    return ti if isinstance(ti, dict) else {}


def resolve_file_path(tool_input: dict) -> str:
    for key in ('file_path', 'path', 'filepath', 'target_path'):
        val = tool_input.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return ''


def read_file_content(file_path: str) -> str:
    try:
        with open(file_path, 'r', encoding='utf-8', errors='replace') as f:
            return f.read()
    except Exception:
        return ''


def get_file_sha1(file_path: str) -> str:
    try:
        with open(file_path, 'rb') as f:
            return hashlib.sha1(f.read()).hexdigest()
    except Exception:
        return ''


def count_lines(file_path: str) -> int:
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            return sum(1 for _ in f)
    except Exception:
        return 0


# ---------------------------------------------------------------------------
# Dedup
# ---------------------------------------------------------------------------
def is_duplicate(
    event_name: str, tool_name: str, file_path: str, log_time: str,
) -> bool:
    key = f'{event_name}|{tool_name}|{file_path}|{log_time}'
    mark = os.path.join(_dedup_dir, f'{sha1_text(key)}.mark')
    if os.path.exists(mark):
        return True
    try:
        with open(mark, 'w', encoding='utf-8') as f:
            f.write(log_time)
    except Exception:
        pass
    return False


# ---------------------------------------------------------------------------
# PreToolUse — capture file state before tool execution
# ---------------------------------------------------------------------------
def handle_pre_tool_use(tool_name: str, file_path: str, log_time: str):
    if tool_name not in TRACKED_FILE_TOOLS or not file_path:
        return

    pre_state: dict = {
        'captured_at': log_time,
        'file_path': file_path,
        'exists': os.path.exists(file_path),
    }
    if pre_state['exists']:
        pre_state['content'] = read_file_content(file_path)
        pre_state['sha1'] = get_file_sha1(file_path)
        pre_state['line_count'] = count_lines(file_path)

    state_path = os.path.join(_pre_state_dir, f'{sha1_text(file_path)}.json')
    try:
        with open(state_path, 'w', encoding='utf-8') as f:
            json.dump(pre_state, f, ensure_ascii=False)
        log_debug(f'Pre-state saved: {file_path}')
    except Exception as e:
        log_debug(f'Pre-state write failed: {e}')


# ---------------------------------------------------------------------------
# PostToolUse — enrich payload with pre-state context
# ---------------------------------------------------------------------------
def enrich_post_tool_use(payload: dict, tool_name: str, file_path: str):
    if tool_name not in TRACKED_FILE_TOOLS or not file_path:
        return

    state_path = os.path.join(_pre_state_dir, f'{sha1_text(file_path)}.json')
    if not os.path.exists(state_path):
        return
    try:
        with open(state_path, 'r', encoding='utf-8') as f:
            pre = json.load(f)
        if isinstance(pre, dict):
            payload['aac_pre_file_exists'] = pre.get('exists') is True
            payload['aac_pre_file_content'] = pre.get('content', '')
            payload['aac_pre_file_sha1'] = pre.get('sha1', '')
            payload['aac_pre_file_line_count'] = pre.get('line_count')
            payload['aac_pre_file_captured_at'] = pre.get('captured_at')
            payload['aac_pre_file_path'] = pre.get('file_path', file_path)
        try:
            os.remove(state_path)
        except Exception:
            pass
        log_debug(f'Post enriched: {file_path}')
    except Exception as e:
        log_debug(f'Pre-state read failed: {e}')


# ---------------------------------------------------------------------------
# Write JSONL record (with exclusive file lock)
# ---------------------------------------------------------------------------
def write_jsonl(record: dict, utc_day: str):
    log_file = os.path.join(_history_dir, f'{_agent_id}-{utc_day}.jsonl')
    line = json.dumps(record, ensure_ascii=False) + '\n'
    try:
        with open(log_file, 'a', encoding='utf-8') as f:
            fcntl.flock(f.fileno(), fcntl.LOCK_EX)
            try:
                f.write(line)
            finally:
                fcntl.flock(f.fileno(), fcntl.LOCK_UN)
        log_debug(f'JSONL written: {log_file}')
    except Exception as e:
        log_debug(f'JSONL write failed: {e}')


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main():
    if len(sys.argv) < 2:
        sys.exit(0)

    agent_id = sys.argv[2] if len(sys.argv) >= 3 else 'qoder-cli'
    init_paths(sys.argv[1], agent_id)

    raw = sys.stdin.read().strip()
    if not raw:
        sys.exit(0)

    # Strip markdown code fences if the caller wrapped the JSON
    if raw.startswith('```'):
        lines = raw.split('\n')
        raw = '\n'.join(lines[1:-1]).strip()

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        log_debug('Invalid JSON payload')
        sys.exit(0)

    if not isinstance(payload, dict):
        sys.exit(0)

    # --- gate: only process known hook events ---
    event_name = (
        payload.get('hook_event_name')
        or payload.get('hookEvent')
        or ''
    )
    if event_name not in ('PreToolUse', 'PostToolUse', 'PostToolUseFailure'):
        sys.exit(0)

    tool_name_raw = payload.get('tool_name') or payload.get('toolName') or ''
    tool_name = normalize_tool_name(tool_name_raw)
    if not tool_name:
        sys.exit(0)
    # qoder-cli: only track file/shell tools; other agents: record everything
    if agent_id == 'qoder-cli':
        if tool_name not in TRACKED_FILE_TOOLS and tool_name not in SHELL_TOOLS:
            sys.exit(0)

    tool_input = resolve_tool_input(payload)
    file_path = resolve_file_path(tool_input)

    now = datetime.datetime.utcnow()
    log_time = now.strftime('%Y-%m-%dT%H:%M:%SZ')
    utc_day = now.strftime('%Y-%m-%d')

    # --- dedup ---
    if is_duplicate(event_name, tool_name, file_path, log_time):
        log_debug(f'Skipped duplicate: {event_name}|{tool_name}')
        sys.exit(0)

    # --- PreToolUse: snapshot file state ---
    if event_name == 'PreToolUse':
        handle_pre_tool_use(tool_name, file_path, log_time)

    # --- PostToolUse: enrich with pre-state ---
    if event_name in ('PostToolUse', 'PostToolUseFailure'):
        enrich_post_tool_use(payload, tool_name, file_path)

    # --- stamp common fields ---
    payload['capturedAt'] = payload.get('capturedAt') or log_time
    payload['logTime'] = payload.get('logTime') or log_time
    payload['aac_client_type'] = _agent_id
    payload['aac_tool_name_normalized'] = tool_name

    record = {
        'uuid': str(uuid.uuid4()),
        'logTime': log_time,
        'reported': False,
        'clientType': _agent_id,
        'hookEvent': event_name,
        'hostname': socket.gethostname(),
        'data': payload,
    }

    write_jsonl(record, utc_day)
    send_to_sls(record)

    log_debug(f'Done: {event_name} {tool_name} {file_path}')


if __name__ == '__main__':
    main()
