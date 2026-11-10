"""Standard-library, non-runtime checks; no containers or Agent installation."""
import json
import hashlib
import io
from pathlib import Path
import tempfile
import sqlite3
import unittest
from unittest.mock import patch
import urllib.error

from linux_cgroup import locate
from prepare_public import download_release, is_target_dev, load_history, select_backfill, source_runtime, stable_releases
from runtime_layout import resolve
from native_qoder_fixture import Fixture, atomic_json, begin_notice_transaction


class FakeNoticeClock:
    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class FakeNoticeConnection:
    def __init__(self, begin_failures=0):
        self.failures = {"BEGIN IMMEDIATE": begin_failures}
        self.calls = []
        self.in_transaction = False
        self.closed = False

    def execute(self, statement):
        self.calls.append(statement)
        remaining = self.failures.get(statement, 0)
        if remaining:
            self.failures[statement] -= 1
            raise sqlite3.OperationalError("database is locked")
        self.in_transaction = statement == "BEGIN IMMEDIATE"

    def close(self):
        self.closed = True


class Helpers(unittest.TestCase):
    def test_notice_begin_contention_retries_gate_without_rewriting_inputs_and_releases_by_rollback(self):
        clock = FakeNoticeClock()
        connection = FakeNoticeConnection(begin_failures=2)
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(temporary, sessions=0)
            with patch("native_qoder_fixture.sqlite3.connect", return_value=connection), \
                 patch("native_qoder_fixture.time.monotonic", side_effect=clock.monotonic), \
                 patch("native_qoder_fixture.time.sleep", side_effect=clock.sleep), \
                 patch("native_qoder_fixture.atomic_json", wraps=atomic_json) as write_notice:
                fixture.append_turn(0, "begin-contention")
            self.assertEqual(connection.calls, ["BEGIN IMMEDIATE", "BEGIN IMMEDIATE", "BEGIN IMMEDIATE", "ROLLBACK"])
            self.assertEqual(write_notice.call_count, 2)
            self.assertEqual(len(fixture.file(0).read_text().splitlines()), 9)
            self.assertEqual(len(fixture.tokens.read_text().splitlines()), 2)
            self.assertEqual(list(fixture.expected), ["begin-contention"])
            self.assertTrue(connection.closed)
            self.assertLessEqual(clock.now, .025)

    def test_notice_begin_exhaustion_reports_stage_and_total_budget(self):
        clock = FakeNoticeClock(); connection = FakeNoticeConnection(begin_failures=1000)
        with patch("native_qoder_fixture.time.monotonic", side_effect=clock.monotonic), \
             patch("native_qoder_fixture.time.sleep", side_effect=clock.sleep):
            with self.assertRaisesRegex(RuntimeError, r"stage=begin elapsed_ms=25\.000 budget_ms=25"):
                begin_notice_transaction(connection, 0, .025)
        self.assertAlmostEqual(clock.now, .025)
        self.assertEqual(set(connection.calls), {"BEGIN IMMEDIATE"})

    def test_notice_action_error_rolls_back_and_closes_without_repeating_inputs(self):
        clock = FakeNoticeClock()
        connection = FakeNoticeConnection()
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(temporary, sessions=0)
            with patch("native_qoder_fixture.sqlite3.connect", return_value=connection), \
                 patch("native_qoder_fixture.time.monotonic", side_effect=clock.monotonic), \
                 patch("native_qoder_fixture.time.sleep", side_effect=clock.sleep), \
                 patch("native_qoder_fixture.atomic_json", side_effect=OSError("injected notice write failure")) as write_notice:
                with self.assertRaisesRegex(OSError, "injected notice write failure"):
                    fixture.append_turn(0, "action-error")
            self.assertEqual(connection.calls, ["BEGIN IMMEDIATE", "ROLLBACK"])
            self.assertEqual(write_notice.call_count, 1)
            self.assertTrue(connection.closed)
            self.assertEqual(len(fixture.file(0).read_text().splitlines()), 9)
            self.assertEqual(len(fixture.tokens.read_text().splitlines()), 2)

    def test_notice_non_lock_sql_error_is_not_retried(self):
        connection = FakeNoticeConnection()
        with patch.object(connection, "execute", side_effect=sqlite3.OperationalError("disk I/O error")) as execute, \
             patch("native_qoder_fixture.time.sleep") as sleep:
            with self.assertRaisesRegex(sqlite3.OperationalError, "disk I/O"):
                begin_notice_transaction(connection, 0, .025)
        self.assertEqual(execute.call_count, 1)
        sleep.assert_not_called()

    def test_only_the_designated_official_dev_branch_is_publishable(self):
        history = {"configuration": {"dev_branch": "codex/cloudshell-sdk-20261107"}}
        self.assertTrue(is_target_dev("alibaba/loongsuite-pilot", "codex/cloudshell-sdk-20261107", history))
        self.assertFalse(is_target_dev("alibaba/loongsuite-pilot", "dev/v2.0.0", history))
        self.assertFalse(is_target_dev("public-fork/loongsuite-pilot", "codex/cloudshell-sdk-20261107", history))
        self.assertFalse(is_target_dev("alibaba/loongsuite-pilot", "codex/cloudshell-sdk-20261107", {}))

    def test_unified_cgroup_uses_mount_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            proc = root / "proc"
            (proc / "42").mkdir(parents=True)
            (proc / "self").mkdir()
            mount = root / "unified"
            owned = mount / "docker/owned"
            owned.mkdir(parents=True)
            (owned / "cgroup.procs").write_text("42\n")
            (proc / "42/cgroup").write_text("0::/slice/docker/owned\n")
            (proc / "self/mountinfo").write_text(
                "30 20 0:1 /slice %s rw - cgroup2 cgroup rw\n" % mount)
            observed = locate(42, proc)
            self.assertEqual(observed["version"], "v2")
            self.assertEqual(observed["processes"], owned / "cgroup.procs")
            self.assertEqual(observed["memory_peak"], owned / "memory.peak")

    def test_v1_memory_and_combined_cpu_mounts(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            proc = root / "proc"
            (proc / "42").mkdir(parents=True)
            (proc / "self").mkdir()
            memory, cpu = root / "memory", root / "cpu,cpuacct"
            for mount in (memory, cpu):
                (mount / "docker/owned").mkdir(parents=True)
                (mount / "docker/owned/cgroup.procs").write_text("42\n")
            (proc / "42/cgroup").write_text(
                "5:memory:/docker/owned\n4:cpu,cpuacct:/docker/owned\n")
            (proc / "self/mountinfo").write_text(
                "31 20 0:2 / %s rw - cgroup cgroup rw,memory\n"
                "32 20 0:3 / %s rw - cgroup cgroup rw,cpu,cpuacct\n" % (memory, cpu))
            observed = locate(42, proc)
            self.assertEqual(observed["version"], "v1")
            self.assertEqual(observed["processes"], memory / "docker/owned/cgroup.procs")
            self.assertEqual(observed["memory_peak"], memory / "docker/owned/memory.max_usage_in_bytes")

    def test_public_js_declared_entry_nested_archive(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = root / "loongsuite-pilot"
            (package / "dist").mkdir(parents=True)
            (package / "dist/index.js").write_text("// public CLI layout fixture\n")
            (package / "package.json").write_text(json.dumps({"name": "loongsuite-pilot",
                "bin": {"loongsuite-pilot": "dist/index.js"}}))
            actual = resolve(root)
            self.assertEqual(actual["runtime"], "js")
            self.assertEqual(actual["package"], package)
            self.assertEqual(actual["entry"], "dist/index.js")

    def test_native_host_requires_real_adjacent_library(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "bin").mkdir()
            (root / "bin/loongsuite-pilot").write_bytes(b"\x7fELFfixture")
            with self.assertRaisesRegex(RuntimeError, "infrastructure.*matching adjacent SDK"):
                resolve(root, "rust")
            (root / "bin/libloongsuite_pilot.so").write_bytes(b"\x7fELFfixture")
            self.assertEqual(resolve(root, "rust")["library"], "bin/libloongsuite_pilot.so")

    def test_declared_entry_cannot_escape_package(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "package.json").write_text(json.dumps({"name": "loongsuite-pilot",
                "bin": {"loongsuite-pilot": "../other.js"}}))
            with self.assertRaisesRegex(RuntimeError, "escapes package"):
                resolve(root, "js")

    def test_backfill_handles_null_compatibility_and_skips_passed(self):
        releases = [{"tag_name": "v1.16.0", "draft": False, "prerelease": False},
                    {"tag_name": "v1.15.2", "draft": False, "prerelease": False}]
        history = {"compatibility": None, "nodes": [{"id": "v1.16.0",
                   "kind": "release", "status": "passed"}]}
        with patch("prepare_public.api", return_value=releases):
            self.assertEqual(select_backfill("alibaba/loongsuite-pilot", history)["tag_name"], "v1.15.2")

    def test_release_pagination_and_semver(self):
        first = [{"tag_name": "v1.2.0", "draft": False, "prerelease": False}] * 100
        second = [{"tag_name": "v1.10.0", "draft": False, "prerelease": False},
                  {"tag_name": "v2.0.0-rc1", "draft": False, "prerelease": True}]
        with patch("prepare_public.api", side_effect=[first, second]) as api:
            self.assertEqual(stable_releases("alibaba/loongsuite-pilot")[0]["tag_name"], "v1.10.0")
            self.assertTrue(api.call_args_list[1][0][0].endswith("page=2"))

    def test_exact_public_cargo_selects_native_source(self):
        with patch("prepare_public.api", return_value={"type": "file"}):
            self.assertEqual(source_runtime("alibaba/loongsuite-pilot", "a" * 40), "rust")

    def test_history_reads_resolved_immutable_sha(self):
        history = {"schema": 1, "repository": "alibaba/loongsuite-pilot", "nodes": []}
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "history.json"
            with patch("prepare_public.resolve", return_value="a" * 40) as resolve_ref:
                with patch("prepare_public.urllib.request.urlopen", return_value=io.BytesIO(json.dumps(history).encode())) as opened:
                    self.assertEqual(load_history(destination, "alibaba/loongsuite-pilot"), history)
                    self.assertIn("/" + "a" * 40 + "/history.json", opened.call_args[0][0])
                    resolve_ref.assert_called_once_with("alibaba/loongsuite-pilot", "sdk-performance-results")

    def test_history_network_error_does_not_become_empty(self):
        with tempfile.TemporaryDirectory() as temporary:
            error = urllib.error.HTTPError("https://api.github.com/", 503, "unavailable", {}, None)
            with patch("prepare_public.resolve", side_effect=error):
                with self.assertRaises(urllib.error.HTTPError):
                    load_history(Path(temporary) / "history.json", "alibaba/loongsuite-pilot")

    def test_history_missing_branch_is_initial_empty(self):
        with tempfile.TemporaryDirectory() as temporary:
            error = urllib.error.HTTPError("https://api.github.com/", 404, "missing", {}, None)
            with patch("prepare_public.resolve", side_effect=error):
                history = load_history(Path(temporary) / "history.json", "alibaba/loongsuite-pilot")
                self.assertEqual(history, {"schema": 1, "repository": "alibaba/loongsuite-pilot", "nodes": []})

    def test_local_history_wrong_repository_is_not_empty(self):
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "history.json"
            destination.write_text(json.dumps({"schema": 1, "repository": "other/repo", "nodes": []}))
            with self.assertRaisesRegex(RuntimeError, "history identity"):
                load_history(destination, "alibaba/loongsuite-pilot")

    def test_release_without_published_digest_keeps_computed_origin(self):
        payload = b"synthetic public archive fixture"
        asset = {"id": 123, "name": "loongsuite-pilot.tar.gz", "size": len(payload), "digest": None,
                 "browser_download_url": "https://github.com/alibaba/loongsuite-pilot/releases/download/v1.0.2/loongsuite-pilot.tar.gz"}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with patch("prepare_public.urllib.request.urlopen", return_value=io.BytesIO(payload)):
                with patch("prepare_public.tarfile.data_filter", None, create=True):
                    with patch("prepare_public.tarfile.open"):
                        with patch("prepare_public.resolve_layout", return_value={"runtime": "js", "package": root / "package", "entry": "dist/index.js"}):
                            result = download_release("alibaba/loongsuite-pilot", {"assets": [asset]}, root)
            self.assertEqual(result["checksum_source"], "download")
            self.assertEqual(result["asset_sha256"], hashlib.sha256(payload).hexdigest())
            self.assertEqual(result["asset_id"], 123)
            self.assertEqual(result["asset_size_bytes"], len(payload))
            self.assertEqual(result["asset_url"], asset["browser_download_url"])

    def test_published_digest_mismatch_is_rejected(self):
        payload = b"synthetic public archive fixture"
        asset = {"id": 123, "name": "loongsuite-pilot.tar.gz", "size": len(payload),
                 "digest": "sha256:" + "0" * 64,
                 "browser_download_url": "https://github.com/alibaba/loongsuite-pilot/releases/download/v1.0.2/loongsuite-pilot.tar.gz"}
        with tempfile.TemporaryDirectory() as temporary:
            with patch("prepare_public.urllib.request.urlopen", return_value=io.BytesIO(payload)):
                with self.assertRaisesRegex(ValueError, "size/SHA mismatch"):
                    download_release("alibaba/loongsuite-pilot", {"assets": [asset]}, Path(temporary))


if __name__ == "__main__":
    unittest.main()
