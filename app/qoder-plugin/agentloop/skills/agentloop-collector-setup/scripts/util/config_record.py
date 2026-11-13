"""读写 ~/.loongsuite-pilot/audit/ 下的配置记录和查询历史。"""

from contextlib import contextmanager
import json
import os
import sys
import tempfile
import time

EXIT_NEED_AUTH = 3
EXIT_CHOOSE_AGENT_SPACE = 7
DATA_DIR = os.path.join(os.path.expanduser("~/.loongsuite-pilot"), "audit")
RECORD_PATH = os.path.join(DATA_DIR, "config-record.json")
HISTORY_PATH = os.path.join(DATA_DIR, "query-history.jsonl")
DEFAULT_LOGSTORE = "agent-event"
HISTORY_LIMIT = 50

TARGET_KEYS = ("agentSpace", "regionId", "slsProject", "slsLogstore")


def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)


@contextmanager
def atomic_private_file(path, prefix=".tmp-", suffix="", mode=0o600):
    """Yield a unique sibling file, then atomically publish it with private permissions."""
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=prefix, suffix=suffix, dir=directory)
    os.close(fd)
    try:
        yield tmp
        os.chmod(tmp, mode)
        os.replace(tmp, path)
        tmp = ""
    finally:
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass
    os.chmod(path, mode)


def read_record():
    try:
        with open(RECORD_PATH, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(data, dict):
        return {}
    return data


def write_private_text(path, text):
    """Write text via a temp file in the same directory, then replace the destination. Mode is 0600."""
    with atomic_private_file(path) as tmp:
        with open(tmp, "w", encoding="utf-8") as handle:
            handle.write(text)


def write_record(data):
    write_private_text(RECORD_PATH, json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def load_target():
    data = read_record()
    return {key: str(data.get(key) or "") for key in TARGET_KEYS}


def saved_space():
    target = load_target()
    name = target.get("agentSpace") or ""
    region_id = target.get("regionId") or ""
    if name and region_id:
        return name, region_id
    return "", ""


def save_profile(profile):
    data = read_record()
    if str(data.get("profile") or "") != profile:
        for key in (*TARGET_KEYS, "updatedAt"):
            data.pop(key, None)
    data["profile"] = profile
    write_record(data)


def require_profile():
    from ensure_oauth import saved_profile

    profile = saved_profile()
    if profile:
        return profile
    print("Not authorized.", file=sys.stderr)
    sys.exit(EXIT_NEED_AUTH)


def save_target(agent_space, region_id, project, logstore):
    context = {
        "agentSpace": agent_space or "",
        "regionId": region_id or "",
        "slsProject": project or "",
        "slsLogstore": logstore or DEFAULT_LOGSTORE,
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    profile = str(read_record().get("profile") or "")
    if profile:
        context["profile"] = profile
    write_record(context)
    return context


def load_history():
    rows = []
    try:
        with open(HISTORY_PATH, encoding="utf-8") as handle:
            lines = handle.readlines()
    except OSError:
        return rows
    for line in lines:
        text = line.strip()
        if not text:
            continue
        try:
            item = json.loads(text)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict):
            rows.append(item)
    return rows[-HISTORY_LIMIT:]


def append_history(entry):
    rows = load_history()
    rows.append(entry)
    rows = rows[-HISTORY_LIMIT:]
    payload = "".join(json.dumps(item, ensure_ascii=False) + "\n" for item in rows)
    write_private_text(HISTORY_PATH, payload)
