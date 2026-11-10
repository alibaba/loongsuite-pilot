"""Synthetic native Qoder protocol derived only from public fixtures/publishers.

Writes raw turns, raw token sidecar and SQLite-gated metadata, never canonical
output events. Container-visible paths are part of source identity and must be
used even when this producer runs outside the measured container.
"""
import datetime
import hashlib
import json
from pathlib import Path
import sqlite3
import time
import uuid


def monotonic_ns():
    # Existing Linux validation hosts can still have Python3.6. No interpreter
    # installation is necessary; the fallback preserves the same clock basis.
    return time.monotonic_ns() if hasattr(time, "monotonic_ns") else int(time.monotonic() * 1_000_000_000)


def epoch_ms():
    return time.time_ns() // 1_000_000 if hasattr(time, "time_ns") else int(time.time() * 1000)


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(compact(value).encode("utf-8")).hexdigest()


def atomic_json(path, value, exclusive=False):
    path = Path(path)
    temporary = path.with_name(".%s.tmp" % uuid.uuid4().hex)
    try:
        temporary.write_text(compact(value), encoding="utf-8")
        temporary.chmod(0o600)
        if exclusive:
            # Source descriptors are first-writer owned and never replaced.
            import os
            try:
                os.link(temporary, path)
            except FileExistsError:
                pass
        else:
            temporary.replace(path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


class Fixture:
    def __init__(self, round_directory, container_root="/bench", sessions=64):
        self.root = Path(round_directory)
        self.container_root = container_root
        self.data = self.root / "home/.loongsuite-pilot"
        self.native = self.root / "native"
        self.sources = self.data / "state/qoder-transcripts/qoder/sources"
        self.tokens = self.data / "logs/qodercli-intercept.jsonl"
        for path in (self.native, self.sources, self.tokens.parent,
                     self.root / "home/.qoder", self.data / "logs/qoder/history"):
            path.mkdir(parents=True, exist_ok=True)
        self.tokens.touch()
        self.session_count = sessions
        self.sequence = 0
        self.expected = {}
        for index in range(sessions):
            self.file(index).touch()
            self.notice(index, "UserPromptSubmit")

    def file(self, session):
        return self.native / ("session-%02d.jsonl" % session)

    def container_path(self, session):
        return "%s/native/session-%02d.jsonl" % (self.container_root, session)

    def notice(self, session, event="Stop"):
        file = self.file(session)
        path = self.container_path(session)
        session_id = "ci-native-%02d" % session
        key = digest([session_id, path])
        directory = self.sources / key
        events = directory / "events"
        events.mkdir(parents=True, exist_ok=True)
        status = file.stat()
        value = {"schema": 1, "key": key, "agentId": "qoder", "sessionId": session_id,
                 "transcriptPath": path, "event": event, "observationId": str(uuid.uuid4()),
                 "observedSize": status.st_size, "observedAt": epoch_ms(),
                 "inode": status.st_ino, "cwd": self.container_root + "/native",
                 "resourceAttributes": {}, "spanAttributes": {}}
        context = digest([value.get("cwd"), value.get("desktop"), value.get("userIdentity"),
                          value.get("agentName"), value["resourceAttributes"],
                          value["spanAttributes"], value.get("requestSetId")])[:24]
        destination = events / ("%d-%s-%s.json" % (status.st_size, event, context))
        # Public JS and Rust publishers/ACK use this same SQLite gate. Never
        # delete it: removal would create a second lock domain.
        gate = directory / ".wakeup-gate.sqlite"
        deadline = time.monotonic() + .025
        connection = sqlite3.connect(str(gate), timeout=0, isolation_level=None)
        try:
            while True:
                try:
                    connection.execute("BEGIN IMMEDIATE")
                    break
                except sqlite3.OperationalError as error:
                    if "locked" not in str(error).lower() or time.monotonic() >= deadline:
                        raise
                    time.sleep(.001)
            if not destination.exists() and len(list(events.iterdir())) >= 128:
                raise RuntimeError("public per-source notice capacity reached")
            atomic_json(directory / "source.json", value, exclusive=True)
            atomic_json(destination, value)
            connection.execute("COMMIT")
        finally:
            if connection.in_transaction:
                connection.execute("ROLLBACK")
            connection.close()

    def append_turn(self, session, identifier, measured=True):
        now = datetime.datetime.now(datetime.timezone.utc)
        def stamp(index):
            return (now + datetime.timedelta(microseconds=index)).isoformat(timespec="microseconds").replace("+00:00", "Z")
        def progress(event, index):
            return {"type": "progress", "timestamp": stamp(index), "data": {"hookEvent": event}}
        tool = "ci-tool-" + identifier
        rows = [progress("UserPromptSubmit", 0),
            {"type": "user", "entrypoint": "cli", "uuid": "ci-user-" + identifier, "timestamp": stamp(1),
             "message": {"role": "user", "content": "synthetic " + identifier + " " + "x" * 1024}},
            {"type": "assistant", "timestamp": stamp(2), "message": {
                "id": "ci-response-" + identifier + "-call", "role": "assistant", "model": "synthetic-model",
                "content": [{"type": "tool_use", "id": tool, "name": "Read", "input": {"path": "synthetic.txt"}}],
                "stop_reason": "tool_use"}}, progress("PreToolUse", 3),
            {"type": "user", "timestamp": stamp(4), "message": {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": tool, "content": "synthetic result " + identifier}]}},
            progress("PostToolUse", 5),
            {"type": "assistant", "timestamp": stamp(6), "message": {
                "id": "ci-response-" + identifier + "-final", "role": "assistant", "model": "synthetic-model",
                "content": [{"type": "text", "text": "synthetic answer " + identifier}], "stop_reason": "end_turn"}},
            progress("Stop", 7), {"type": "last-prompt"}]
        token_rows = [{"type": "token", "ts": epoch_ms(),
                       "id": "ci-response-" + identifier + "-" + boundary,
                       "prompt_tokens": 35, "completion_tokens": 11, "total_tokens": 46}
                      for boundary in ("call", "final")]
        # Publish tokens first so a completed response has genuine matching usage.
        with self.tokens.open("a", encoding="utf-8") as stream:
            stream.write("".join(compact(row) + "\n" for row in token_rows))
        published = monotonic_ns()
        with self.file(session).open("a", encoding="utf-8") as stream:
            stream.write("".join(compact(row) + "\n" for row in rows))
        if measured:
            self.expected[identifier] = {"session": "ci-native-%02d" % session,
                "tool_id": tool, "response_ids": [row["id"] for row in token_rows],
                "input_tokens": 35, "output_tokens": 11, "published_monotonic_ns": published}
        self.notice(session)
        return published
