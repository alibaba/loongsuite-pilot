"""Orchestrate published legacy Hooks outside the measured collector container."""
import contextlib
import json
from pathlib import Path
import subprocess
import time

from native_qoder_fixture import Fixture, compact


class LegacyFixture(Fixture):
    def __init__(self, round_directory, container_root="/bench", sessions=64):
        root = Path(round_directory)
        root.mkdir(parents=True, exist_ok=True)
        self.queue = root / "legacy-trigger.jsonl"
        self.status = root / "legacy-dispatcher-status.json"
        self.done = root / "legacy-trigger.done"
        self.queue.touch()
        self.process = None
        self.log = None
        self.closing = False
        self.finished = False
        super().__init__(root, container_root, sessions)
        (root / "workspace").mkdir(exist_ok=True)

    def notice(self, session, event="Stop"):
        if event != "Stop":
            return
        if self.closing:
            raise RuntimeError("legacy Stop queue is already closed")
        payload = {"hook_event_name": "Stop", "session_id": "ci-native-%02d" % session,
                   "transcript_path": self.container_path(session),
                   "cwd": self.container_root + "/workspace"}
        with self.queue.open("a", encoding="utf-8") as stream:
            stream.write(compact(payload) + "\n")

    def start(self, container):
        if self.process is not None:
            raise RuntimeError("legacy Stop dispatcher already started")
        root = self.container_root
        self.log = (self.root / "legacy-dispatcher.log").open("wb")
        arguments = ["node", str(Path(__file__).with_name("legacy_hook_dispatcher.cjs").resolve()),
                     str(self.queue), str(self.status), str(self.done), container,
                     root + "/home/.loongsuite-pilot/hooks/qoder-loongsuite-pilot-hook.sh"]
        self.process = subprocess.Popen(arguments, stdout=self.log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if self.check() is not None:
                return
            time.sleep(.02)
        raise RuntimeError("legacy Stop dispatcher did not become ready")

    def check(self):
        status = json.loads(self.status.read_text(encoding="utf-8")) if self.status.exists() else None
        if status and status.get("state") == "failed":
            raise RuntimeError("legacy Stop dispatcher failed: " + status.get("error", "unknown error"))
        if self.process is not None:
            code = self.process.poll()
            if code is not None and (code != 0 or not self.closing):
                raise RuntimeError("legacy Stop dispatcher exited unexpectedly: %s" % code)
        return status

    def drain(self, timeout=15):
        deadline = time.monotonic() + timeout
        size = self.queue.stat().st_size
        while True:
            status = self.check()
            if (status and status["consumed_bytes"] == size and
                    status["pending"] == 0 and status["active"] == 0 and
                    status["queued"] == status["completed"]):
                return
            if time.monotonic() >= deadline:
                raise RuntimeError("legacy Stop Hook queue did not drain")
            time.sleep(.02)

    def finish(self, timeout=15):
        if self.finished:
            return
        if self.process is None:
            raise RuntimeError("legacy Stop dispatcher was not started")
        self.closing = True
        pending = self.done.with_suffix(".done.tmp")
        pending.write_text(str(self.queue.stat().st_size), encoding="ascii")
        pending.replace(self.done)
        try:
            code = self.process.wait(timeout=timeout)
        except subprocess.TimeoutExpired as error:
            raise RuntimeError("legacy Stop Hook queue did not finish") from error
        status = self.check()
        if (code != 0 or not status or status["state"] != "closed" or
                status["queued"] != status["completed"]):
            raise RuntimeError("legacy Stop dispatcher closed without completing every trigger")
        self.finished = True

    def close(self):
        if self.process is not None and self.process.poll() is None:
            with contextlib.suppress(Exception):
                self.process.terminate()
                self.process.wait(timeout=2)
            if self.process.poll() is None:
                with contextlib.suppress(Exception):
                    self.process.kill()
                    self.process.wait(timeout=2)
        if self.log is not None:
            with contextlib.suppress(Exception):
                self.log.close()
