"""Focused historical Hook adapter checks using stdlib and the existing Node runtime."""
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

from legacy_qoder_fixture import LegacyFixture
from runtime_layout import resolve
from pilot_history import wait_for_legacy_input


DISPATCHER = Path(__file__).with_name("legacy_hook_dispatcher.cjs")
NODE = shutil.which("node")


class LegacyLayoutTests(unittest.TestCase):
    def package(self, root, processor, bundle="// collector"):
        (root / "dist").mkdir()
        (root / "assets/hooks").mkdir(parents=True)
        (root / "package.json").write_text(json.dumps({
            "name": "loongsuite-pilot", "bin": {"loongsuite-pilot": "dist/index.js"},
        }))
        (root / "dist/index.js").write_text(bundle)
        (root / "assets/hooks/qoder-hook-processor.mjs").write_text(processor)
        (root / "assets/hooks/qoder-loongsuite-pilot-hook.sh").write_text("#!/bin/bash\n")

    def test_original_history_writer_selects_legacy_without_version_guessing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.package(root, "appendRowsToHistory(agentId, logPrefix, rowsToAppend);")
            layout = resolve(root, "js")
            self.assertEqual(layout["collection"], "legacy-stop")
            self.assertEqual(layout["entry"], "dist/index.js")

    def test_wakeup_exporter_and_native_collector_keep_native_mode(self):
        cases = (
            ("appendRowsToHistory(); publishQoderWakeup(payload);", "// collector"),
            ("appendRowsToHistory();", "// state/qoder-transcripts/qoder/sources"),
            ("import {appendRowsToHistory} from './shared/hook-processor-base.mjs';", "// collector"),
        )
        for processor, bundle in cases:
            with self.subTest(processor=processor, bundle=bundle):
                with tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    self.package(root, processor, bundle)
                    self.assertEqual(resolve(root, "js")["collection"], "native")

    def test_legacy_marker_requires_the_packaged_shell_entry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.package(root, "appendRowsToHistory();")
            (root / "assets/hooks/qoder-loongsuite-pilot-hook.sh").unlink()
            self.assertEqual(resolve(root, "js")["collection"], "native")


class LegacyInputReadinessTests(unittest.TestCase):
    def test_waits_for_input_start_before_hook_history_is_published(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = LegacyFixture(directory, sessions=0)
            log = fixture.data / "logs/loongsuite-pilot-service.log"
            log.write_text('invalid log line\nnull\n{"id":"qoder-trace","msg":"starting"}\n')
            def started(_seconds):
                with log.open("a") as stream:
                    stream.write('{"id":"qoder-trace","msg":"input started"}\n')
            with patch("pilot_history.time.monotonic", return_value=0), \
                 patch("pilot_history.time.sleep", side_effect=started) as sleep:
                wait_for_legacy_input(fixture, 25)
            sleep.assert_called_once()
            self.assertEqual(fixture.queue.read_text(), "")
            fixture.close()

    def test_missing_input_start_keeps_the_existing_warmup_deadline(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = LegacyFixture(directory, sessions=0)
            with patch("pilot_history.time.monotonic", return_value=25), \
                 patch("pilot_history.time.sleep") as sleep:
                with self.assertRaisesRegex(RuntimeError, "input did not become ready"):
                    wait_for_legacy_input(fixture, 25)
            sleep.assert_not_called()
            fixture.close()


class LegacyRawFixtureTests(unittest.TestCase):
    def test_each_turn_queues_raw_stop_without_writing_normalized_events(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture = LegacyFixture(root, sessions=2)
            try:
                queue = root / "legacy-trigger.jsonl"
                self.assertEqual(queue.read_text(), "")
                fixture.append_turn(0, "first")
                fixture.append_turn(0, "second")
                rows = [json.loads(line) for line in queue.read_text().splitlines()]
                self.assertEqual(len(rows), 2)
                self.assertTrue(all(row == {
                    "hook_event_name": "Stop",
                    "session_id": "ci-native-00",
                    "transcript_path": "/bench/native/session-00.jsonl",
                    "cwd": "/bench/workspace",
                } for row in rows))
                transcript = [json.loads(line) for line in fixture.file(0).read_text().splitlines()]
                tokens = [json.loads(line) for line in fixture.tokens.read_text().splitlines()]
                self.assertEqual(len(transcript), 18)
                self.assertEqual(len(tokens), 4)
                self.assertFalse(any("event.name" in row for row in transcript + tokens))
                self.assertEqual(len(fixture.expected), 2)
                self.assertEqual(list(fixture.sources.iterdir()), [])
                self.assertEqual(list((fixture.data / "logs/qoder/history").iterdir()), [])
            finally:
                fixture.close()

    def test_dispatcher_runs_on_host_and_routes_product_hook_to_collector(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = LegacyFixture(directory, sessions=0)
            fixture.status.write_text(json.dumps({"state": "ready"}))
            with patch("legacy_qoder_fixture.subprocess.Popen") as popen:
                popen.return_value.poll.return_value = None
                try:
                    fixture.start("owned-collector")
                    arguments = popen.call_args[0][0]
                    self.assertEqual(arguments, [
                        "node", str(DISPATCHER.resolve()), str(fixture.queue),
                        str(fixture.status), str(fixture.done), "owned-collector",
                        "/bench/home/.loongsuite-pilot/hooks/qoder-loongsuite-pilot-hook.sh",
                    ])
                    self.assertNotEqual(arguments[0], "docker")
                finally:
                    popen.return_value.poll.return_value = 0
                    fixture.close()

    def test_drain_requires_all_queue_bytes_and_children_completed(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = LegacyFixture(directory, sessions=1)
            try:
                fixture.append_turn(0, "not-drained")
                complete = {"state": "ready", "consumed_bytes": fixture.queue.stat().st_size,
                            "queued": 1, "started": 1, "completed": 1, "active": 0, "pending": 0}
                for changes in ({"consumed_bytes": 0}, {"active": 1}, {"pending": 1}, {"completed": 0}):
                    with self.subTest(changes=changes):
                        fixture.status.write_text(json.dumps(dict(complete, **changes)))
                        with self.assertRaisesRegex(RuntimeError, "did not drain"):
                            fixture.drain(timeout=0)
                fixture.status.write_text(json.dumps(complete))
                fixture.drain(timeout=0)
            finally:
                fixture.close()

    def test_finish_writes_exact_close_boundary_and_propagates_dispatcher_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = LegacyFixture(directory, sessions=1)
            fixture.append_turn(0, "close")
            with patch("legacy_qoder_fixture.subprocess.Popen") as popen:
                process = popen.return_value
                process.poll.return_value = None
                fixture.status.write_text(json.dumps({"state": "ready"}))
                fixture.start("owned-collector")
                fixture.status.write_text(json.dumps({
                    "state": "failed", "error": "original Hook exited code=7",
                }))
                process.wait.return_value = 1
                process.poll.return_value = 1
                try:
                    with self.assertRaisesRegex(RuntimeError, "code=7"):
                        fixture.finish(timeout=0)
                    self.assertEqual(int(fixture.done.read_text()), fixture.queue.stat().st_size)
                finally:
                    fixture.close()


@unittest.skipUnless(NODE, "the existing Node runtime is required for the dispatcher unit test")
class LegacyDispatcherTests(unittest.TestCase):
    def create_inputs(self, directory, payloads):
        root = Path(directory)
        queue, status, done = (root / name for name in ("queue.jsonl", "status.json", "done"))
        queue.write_text("".join(json.dumps(payload) + "\n" for payload in payloads))
        ledger = root / "ledger.jsonl"
        fake = root / "fake-hook.cjs"
        fake.write_text(
            "'use strict';\n"
            "const fs = require('node:fs');\n"
            "const payload = JSON.parse(fs.readFileSync(0, 'utf8'));\n"
            "const append = phase => fs.appendFileSync(process.env.LEGACY_TEST_LEDGER,\n"
            "  JSON.stringify({phase, payload}) + '\\n');\n"
            "append('start');\n"
            "setTimeout(() => { append('end'); process.exit(payload.test_exit || 0); },\n"
            "  payload.test_delay || 10);\n"
        )
        hook = root / "original-hook.sh"
        hook.write_text("#!/usr/bin/env bash\nexec " + shlex.quote(NODE) + " " + shlex.quote(str(fake)) + "\n")
        hook.chmod(0o700)
        docker = root / "docker"
        docker.write_text(
            "#!/usr/bin/env bash\n"
            "set -eu\n"
            'if [[ "$#" -ne 5 || "$1" != exec || "$2" != -i || '
            '"$3" != owned-collector || "$4" != bash || "$5" != "$LEGACY_TEST_HOOK" ]]; then\n'
            "  printf 'unexpected container Hook invocation\\n' >&2\n"
            "  exit 91\n"
            "fi\n"
            'exec bash "$5"\n'
        )
        docker.chmod(0o700)
        return queue, status, done, hook, ledger

    def run_dispatcher(self, queue, status, done, hook, ledger):
        environment = dict(os.environ, LEGACY_TEST_LEDGER=str(ledger),
                           LEGACY_TEST_HOOK=str(hook))
        environment["PATH"] = str(hook.parent) + os.pathsep + environment.get("PATH", "")
        process = subprocess.Popen(
            [NODE, str(DISPATCHER), str(queue), str(status), str(done), "owned-collector", str(hook)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment,
            start_new_session=True,
        )
        try:
            stdout, stderr = process.communicate(timeout=12)
            self.assertTrue(status.is_file(), (stdout, stderr))
            return process.returncode, json.loads(status.read_text()), stderr
        finally:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            if process.poll() is None:
                process.kill()
                process.wait(timeout=2)

    def test_all_stops_preserve_fifo_and_bounded_per_source_concurrency(self):
        payloads = [
            {"hook_event_name": "Stop", "session_id": "one",
             "transcript_path": "/bench/native/one.jsonl", "cwd": "/bench/workspace", "sequence": index, "test_delay": 30}
            for index in range(5)
        ] + [
            {"hook_event_name": "Stop", "session_id": "other-%s" % index,
             "transcript_path": "/bench/native/other-%s.jsonl" % index, "cwd": "/bench/workspace", "sequence": 5 + index, "test_delay": 30}
            for index in range(12)
        ]
        with tempfile.TemporaryDirectory() as directory:
            queue, status, done, hook, ledger = self.create_inputs(directory, payloads)
            done.write_text(str(queue.stat().st_size))
            code, result, stderr = self.run_dispatcher(queue, status, done, hook, ledger)
            self.assertEqual(code, 0, (result, stderr))
            self.assertEqual(result["completed"], len(payloads))
            self.assertEqual(result["started"], len(payloads))
            self.assertEqual(result["consumed_bytes"], queue.stat().st_size)
            self.assertEqual(result["active"], 0)
            self.assertEqual(result["pending"], 0)
            events = [json.loads(line) for line in ledger.read_text().splitlines()]
            starts = [event["payload"] for event in events if event["phase"] == "start"]
            self.assertCountEqual(starts, payloads)
            self.assertEqual([row["sequence"] for row in starts if row["session_id"] == "one"], list(range(5)))
            active = set()
            peak = 0
            for event in events:
                source = event["payload"]["transcript_path"]
                if event["phase"] == "start":
                    self.assertNotIn(source, active)
                    active.add(source)
                    peak = max(peak, len(active))
                else:
                    self.assertIn(source, active)
                    active.remove(source)
            self.assertEqual(active, set())
            self.assertGreater(peak, 1)
            self.assertLessEqual(peak, 8)

    def test_original_hook_nonzero_exit_is_an_explicit_failure(self):
        payload = {"hook_event_name": "Stop", "session_id": "failed",
                   "transcript_path": "/bench/native/failed.jsonl", "cwd": "/bench/workspace", "test_exit": 7}
        with tempfile.TemporaryDirectory() as directory:
            queue, status, done, hook, ledger = self.create_inputs(directory, [payload])
            done.write_text(str(queue.stat().st_size))
            code, result, stderr = self.run_dispatcher(queue, status, done, hook, ledger)
            self.assertNotEqual(code, 0, stderr)
            self.assertTrue(result["error"], result)
            self.assertIn("7", str(result["error"]))

    def test_invalid_or_unfinished_trigger_cannot_be_reported_as_complete(self):
        for tail in ('{"transcript_path":', '{"transcript_path": invalid}\n'):
            with self.subTest(tail=tail):
                with tempfile.TemporaryDirectory() as directory:
                    queue, status, done, hook, ledger = self.create_inputs(directory, [])
                    queue.write_text(tail)
                    done.write_text(str(queue.stat().st_size))
                    code, result, stderr = self.run_dispatcher(queue, status, done, hook, ledger)
                    self.assertNotEqual(code, 0, stderr)
                    self.assertTrue(result["error"], result)


if __name__ == "__main__":
    unittest.main()
