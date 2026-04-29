#!/usr/bin/env python3
"""
Qoder stop hook transcript forwarder.

Calculates incremental line range from transcript, appends new rows to local
history JSONL logs for ai-agent-collector, and updates the line record to
prevent duplicate processing.

Usage (CLI mode):
    qoder_hook.py --agent-id <id> --transcript <path> --session-id <id>

Usage (stdin mode — called directly by Qoder Stop hook):
    Reads JSON from stdin with transcript_path and session_id fields.
    Checks stop_hooks_active to avoid infinite recursion.
"""

import sys
import os
import time
import json
import argparse
import fcntl
from typing import Optional, List, Tuple

ENABLE_LOGGING = True

# Paths
HOOKS_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_FILE = os.path.join(HOOKS_DIR, 'qoder_hook.log')
LINE_RECORD_FILE = os.path.join(HOOKS_DIR, '.line_records.json')
AAC_LOGS_BASE_DIR = os.path.expanduser('~/.ai-agent-collector/logs')

def get_transcript_line_count(transcript_path: str) -> int:
    """Get current line count of transcript file."""
    if not os.path.exists(transcript_path):
        return 0
    try:
        with open(transcript_path, 'r', encoding='utf-8') as f:
            return sum(1 for _ in f)
    except IOError as e:
        log_debug(f"Failed to count lines: {e}")
        return 0


def get_line_range(transcript_path: str, session_id: str) -> Optional[Tuple[int, int]]:
    """
    Calculate the incremental line range to upload.
    Returns (start_line, end_line) or None if no new lines.
    """
    records = load_line_records()
    record = records.get(transcript_path, {})
    last_count = record.get("last_line_count", 0)
    recorded_session = record.get("session_id", "")

    current_count = get_transcript_line_count(transcript_path)

    # If session changed, reset to 0 (send all lines in file)
    if recorded_session and recorded_session != session_id:
        log_debug(f"Session changed: {recorded_session} -> {session_id}, reset to 0")
        last_count = 0

    if current_count == 0:
        log_debug("Transcript is empty")
        return None

    if current_count == last_count:
        log_debug(f"No new lines (count: {current_count})")
        return None

    if current_count < last_count:
        log_debug(f"File truncated ({last_count} -> {current_count}), sending all")
        last_count = 0

    log_debug(f"Range: {last_count} -> {current_count}")
    return (last_count, current_count)


def log_debug(message: str):
    """Write debug log to local file with locking."""
    if not ENABLE_LOGGING:
        return
    try:
        timestamp = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime())
        with open(LOG_FILE, 'a', encoding='utf-8') as f:
            fcntl.flock(f.fileno(), fcntl.LOCK_EX)
            try:
                f.write(f"[{timestamp}] {message}\n")
            finally:
                fcntl.flock(f.fileno(), fcntl.LOCK_UN)
    except Exception as e:
        print(f"[data_upload log error] {e}", file=sys.stderr)


def load_line_records() -> dict:
    """Load line number records from file."""
    if not os.path.exists(LINE_RECORD_FILE):
        return {}
    try:
        with open(LINE_RECORD_FILE, 'r', encoding='utf-8') as f:
            fcntl.flock(f.fileno(), fcntl.LOCK_SH)
            try:
                return json.load(f)
            finally:
                fcntl.flock(f.fileno(), fcntl.LOCK_UN)
    except (json.JSONDecodeError, IOError) as e:
        log_debug(f"Failed to load line records: {e}")
        return {}


def save_line_records(records: dict) -> bool:
    """Save line number records to file with locking."""
    try:
        os.makedirs(os.path.dirname(LINE_RECORD_FILE), exist_ok=True)
        with open(LINE_RECORD_FILE, 'w', encoding='utf-8') as f:
            fcntl.flock(f.fileno(), fcntl.LOCK_EX)
            try:
                json.dump(records, f, indent=2)
                return True
            finally:
                fcntl.flock(f.fileno(), fcntl.LOCK_UN)
    except IOError as e:
        log_debug(f"Failed to save line records: {e}")
        return False


def update_line_record(transcript_path: str, session_id: str, end_line: int) -> bool:
    """Update line count record after successful upload."""
    records = load_line_records()
    records[transcript_path] = {
        "session_id": session_id,
        "last_line_count": end_line,
        "updated_at": time.strftime('%Y-%m-%d %H:%M:%S')
    }
    success = save_line_records(records)
    if success:
        log_debug(f"Updated record: {transcript_path} -> {end_line} lines")
    else:
        log_debug("Warning: Failed to save line records")
    return success


def read_transcript_lines(transcript_path: str, start_line: int, end_line: int) -> List[str]:
    """Read lines from transcript file [start_line, end_line)."""
    lines = []
    if not os.path.exists(transcript_path):
        return lines
    try:
        with open(transcript_path, 'r', encoding='utf-8') as f:
            for i, line in enumerate(f):
                if i >= start_line and i < end_line:
                    lines.append(line.strip())
                if i >= end_line:
                    break
    except IOError as e:
        log_debug(f"Failed to read transcript {transcript_path}: {e}")
    return lines


def parse_transcript_line(line: str) -> Optional[str]:
    """Validate transcript row and return canonical JSONL line."""
    try:
        payload = json.loads(line)
        return json.dumps(payload, ensure_ascii=False)
    except json.JSONDecodeError:
        log_debug("Skipped invalid JSON transcript line")
        return None


def get_history_log_file(agent_id: str) -> str:
    """Resolve daily history JSONL file path for agent_id."""
    local_day = time.strftime('%Y-%m-%d', time.localtime())
    history_dir = os.path.join(AAC_LOGS_BASE_DIR, agent_id, "history")
    return os.path.join(history_dir, f"{agent_id}-{local_day}.jsonl")


def append_rows_to_history(agent_id: str, rows: List[str]) -> bool:
    """Append JSONL rows into agent history file with file locking."""
    if not rows:
        return True

    log_file = get_history_log_file(agent_id)
    os.makedirs(os.path.dirname(log_file), exist_ok=True)
    try:
        with open(log_file, 'a', encoding='utf-8') as f:
            fcntl.flock(f.fileno(), fcntl.LOCK_EX)
            try:
                for row in rows:
                    f.write(row + "\n")
            finally:
                fcntl.flock(f.fileno(), fcntl.LOCK_UN)
        log_debug(f"Appended {len(rows)} rows to {log_file}")
        return True
    except Exception as e:
        log_debug(f"ERROR appending rows to history: {e}")
        return False


def upload_lines(
    transcript_path: str,
    start_line: int,
    end_line: int,
    session_id: str,
    agent_id: str,
) -> bool:
    """Read and append transcript lines in range [start_line, end_line)."""
    if start_line >= end_line:
        log_debug(f"No lines to append: start_line={start_line}, end_line={end_line}")
        return True

    expected_count = end_line - start_line

    # Read lines
    lines = read_transcript_lines(transcript_path, start_line, end_line)
    actual_count = len(lines)

    log_debug(f"Read {actual_count} lines from {transcript_path} (range: {start_line}-{end_line}, expected: {expected_count})")

    # Warn if actual count doesn't match expected (file may have been modified)
    if actual_count < expected_count:
        log_debug(f"Warning: Expected {expected_count} lines but only read {actual_count}")
    elif actual_count > expected_count:
        log_debug(f"Warning: Read more lines ({actual_count}) than expected ({expected_count})")

    if not lines:
        return True

    # Validate and canonicalize JSONL rows.
    rows_to_append = []
    for line in lines:
        row = parse_transcript_line(line)
        if row:
            rows_to_append.append(row)

    success = append_rows_to_history(agent_id, rows_to_append)

    if success:
        log_debug(f"Successfully appended {len(rows_to_append)} rows from {transcript_path}")
        print(f"Appended {len(rows_to_append)} rows to local history ({agent_id})")
        # Update line record so subsequent stop hooks see the new count
        update_line_record(transcript_path, session_id, end_line)
    else:
        log_debug(f"Failed to append rows from {transcript_path}")
        print("Failed to append rows to local history", file=sys.stderr)

    return success


def _read_stdin_params() -> Tuple[str, str]:
    """Read transcript_path and session_id from stdin JSON (stop hook mode)."""
    try:
        stdin_data = sys.stdin.read().strip()
    except Exception:
        return "", ""

    if not stdin_data:
        return "", ""

    try:
        payload = json.loads(stdin_data)
    except json.JSONDecodeError:
        log_debug("Failed to parse stdin JSON")
        return "", ""

    # Avoid infinite loop: if this stop was triggered by hooks, bail out
    if payload.get("stop_hooks_active", False):
        log_debug("stop_hooks_active=true, exiting to avoid recursion")
        sys.exit(0)

    transcript = payload.get("transcript_path", "")
    session_id = payload.get("session_id") or payload.get("sessionId", "")
    return transcript, session_id


def main():
    parser = argparse.ArgumentParser(
        description="Append transcript lines to ai-agent-collector history logs",
    )
    parser.add_argument(
        "--agent-id",
        required=True,
        help="Agent ID in history path (e.g. qoder(for both qoder ide and cli), qoder-work)",
    )
    parser.add_argument("--transcript", default="",
                        help="Path to transcript file")
    parser.add_argument("--session-id", default="",
                        help="Session ID")
    args = parser.parse_args()

    # log args
    log_debug(f"argv: {sys.argv}")

    agent_id = (args.agent_id or "").strip()
    if not agent_id:
        print("--agent-id is required", file=sys.stderr)
        sys.exit(1)

    transcript_path = args.transcript
    session_id = args.session_id

    # If not provided via CLI, read from stdin (stop hook mode)
    if not transcript_path or not session_id:
        stdin_transcript, stdin_session = _read_stdin_params()
        transcript_path = transcript_path or stdin_transcript
        session_id = session_id or stdin_session

    if not transcript_path or not session_id:
        log_debug("No transcript path or session ID provided")
        sys.exit(0)

    if not os.path.exists(transcript_path):
        log_debug(f"Transcript file not found: {transcript_path}")
        sys.exit(1)

    line_range = get_line_range(transcript_path, session_id)
    if not line_range:
        log_debug("No new lines to append")
        sys.exit(0)

    start_line, end_line = line_range
    success = upload_lines(transcript_path, start_line, end_line, session_id, agent_id)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
