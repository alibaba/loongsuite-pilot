"""Data-only publication regressions; no network, Docker, build or benchmark."""
from contextlib import redirect_stderr
import copy
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import publish_history as publisher


def node(kind="release", version="1.16.0", commit="a" * 40):
    identity = "v" + version.lstrip("v") if kind == "release" else kind
    value = {"id": identity, "kind": kind, "version": version if kind == "release" else kind,
        "commit": commit, "recorded_at": "2026-11-10T00:00:00Z", "status": "passed",
        "method_id": "test-method", "environment_id": "test-cohort",
        "environment": {"cpu_model": "test CPU", "runner_os": "Linux", "runner_image": "test-image",
                        "cgroup_version": "v2", "kernel": "test-kernel", "node_version": "test-node"},
        "run_url": "https://github.com/alibaba/loongsuite-pilot/actions/runs/1",
        "source": {"repository": publisher.OFFICIAL, "ref": identity}, "workloads": {}}
    for load in publisher.LOADS:
        value["workloads"][load] = {"repeats": 3, "cpu_percent": {"median": 2, "min": 1, "max": 3},
            "rss_mib": {"median": 20, "min": 19, "max": 21},
            "quality": {"passed": True, "missing": 0, "duplicates": 0}}
    return value


def history():
    return {"schema": 1, "repository": publisher.OFFICIAL, "nodes": [], "compatibility": None}


class PublicationTests(unittest.TestCase):
    def test_generated_site_workflow_is_copied_only_from_trusted_source_and_data_is_unchanged(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); trusted = root / "trusted"; destination = root / "results"
            source = trusted / publisher.SITE_WORKFLOW; source.parent.mkdir(parents=True)
            source.write_text("name: trusted static site\n")
            destination.mkdir(); (destination / "history.json").write_text("original history")
            (destination / "index.html").write_text("original page")
            (destination / ".nojekyll").write_text("preserved marker")
            publisher.stage_site_workflow(destination, trusted)
            self.assertEqual((destination / publisher.SITE_WORKFLOW).read_text(), source.read_text())
            self.assertEqual((destination / "history.json").read_text(), "original history")
            self.assertEqual((destination / "index.html").read_text(), "original page")
            self.assertEqual((destination / ".nojekyll").read_text(), "preserved marker")
            self.assertEqual(publisher.RESULT_FILES, {"history.json", "index.html", ".nojekyll", publisher.SITE_WORKFLOW})

    def test_missing_trusted_site_workflow_cannot_replace_generated_workflow(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); destination = root / "results"
            workflow = destination / publisher.SITE_WORKFLOW; workflow.parent.mkdir(parents=True)
            workflow.write_text("previous trusted workflow")
            with self.assertRaises(FileNotFoundError):
                publisher.stage_site_workflow(destination, root / "missing-source")
            self.assertEqual(workflow.read_text(), "previous trusted workflow")

    def test_temporary_preview_is_preserved_without_becoming_a_ci_node(self):
        data = history()
        reference = {"schema": 1, "kind": "temporary_preview", "rows": [
            {"id": identity, "workloads": {load: {"cpu_percent": 1, "rss_mib": 20} for load in publisher.LOADS}}
            for identity in ("v1.15.2", "dev")]}
        data["temporary_preview"] = copy.deepcopy(reference)
        publisher.merge(data, node("release", "1.16.0"))
        self.assertEqual(data["temporary_preview"], reference)
        self.assertEqual([item["id"] for item in data["nodes"]], ["v1.16.0"])
        from prepare_public import select_backfill
        with patch("prepare_public.stable_releases", return_value=[{"tag_name": "v1.15.2"}]):
            self.assertEqual(select_backfill(publisher.OFFICIAL, data)["tag_name"], "v1.15.2")
        data["temporary_preview"]["rows"][0]["workloads"]["idle"]["cpu_percent"] = float("nan")
        with self.assertRaises(ValueError):
            publisher.validate_history(data)
        data["temporary_preview"] = copy.deepcopy(reference)
        data["temporary_preview"]["rows"][0]["commit"] = "private identity must not enter preview"
        with self.assertRaises(ValueError):
            publisher.validate_history(data)

    def test_live_results_configuration_rejects_old_branch_after_switch_without_affecting_main_release(self):
        data = history(); data["configuration"] = {"dev_branch": "codex/first"}
        old = node("dev"); old["source"]["ref"] = "codex/first"
        self.assertTrue(publisher.target_dev_matches(data, old))
        data["configuration"]["dev_branch"] = "codex/second"
        self.assertFalse(publisher.target_dev_matches(data, old))
        new = node("dev"); new["source"]["ref"] = "codex/second"
        self.assertTrue(publisher.target_dev_matches(data, new))
        new["source"]["repository"] = "public-fork/loongsuite-pilot"
        self.assertFalse(publisher.target_dev_matches(data, new))
        self.assertTrue(publisher.target_dev_matches({}, node("main")))
        self.assertTrue(publisher.target_dev_matches({}, node("release")))
        self.assertFalse(publisher.target_dev_matches({}, old))

    def test_retire_legacy_qoder_promotes_verified_standard_slots_only(self):
        from prepare_public import history_for_method
        standard_id = publisher.STANDARD_METHOD
        codex_id = publisher.CODEX_STANDARD_METHOD
        data = history()
        data.update(method={"id": publisher.LEGACY_METHOD}, nodes=[{"old": "100 ms"}],
                    temporary_preview={"old": True}, compatibility={"excluded_at_or_before": "v1.14.0"})
        standard = {"id": standard_id}
        new_node = {"id": "v1.15.2"}
        codex = {"method": {"id": codex_id}, "nodes": [], "updated_at": None}
        data["other_methods"] = {standard_id: {"method": standard, "nodes": [new_node],
                                              "updated_at": "2026-11-11T00:00:00Z"},
                                 codex_id: codex}
        self.assertTrue(publisher.retire_legacy_qoder(data, standard))
        self.assertFalse(publisher.retire_legacy_qoder(data, standard))
        self.assertIs(history_for_method(data, standard_id), data)
        self.assertEqual(data["nodes"], [new_node])
        self.assertEqual(data["other_methods"], {codex_id: codex})
        self.assertEqual(data["updated_at"], "2026-11-11T00:00:00Z")
        self.assertIsNone(data["compatibility"])
        self.assertNotIn("temporary_preview", data)

    def test_invalid_history_and_duplicate_slots_fail_before_cutoff_or_merge(self):
        data = history(); data["nodes"] = [node(), node()]
        with self.assertRaises(ValueError):
            publisher.validate_history(data)
        data = history(); data["compatibility"] = "invalid"
        with self.assertRaises(ValueError):
            publisher.validate_history(data)

    def test_additional_method_uses_independent_release_and_dev_slots(self):
        data = history()
        data["method"] = {"id": "test-method"}
        primary = node("dev", commit="a" * 40)
        self.assertTrue(publisher.merge(data, primary, current_dev=primary["commit"]))
        original = copy.deepcopy(data["nodes"])
        method = {"id": "codex-method", "display_name": "Codex"}
        alternate = node("dev", commit="b" * 40)
        alternate["method_id"] = method["id"]
        self.assertFalse(publisher.merge_method(data, method, alternate, current_dev="c" * 40))
        self.assertNotIn("other_methods", data)
        self.assertTrue(publisher.merge_method(data, method, alternate, current_dev=alternate["commit"]))
        release = node("release", commit="d" * 40)
        release["method_id"] = method["id"]
        self.assertTrue(publisher.merge_method(data, method, release))
        self.assertEqual(data["nodes"], original)
        series = data["other_methods"][method["id"]]
        self.assertEqual(series["method"], method)
        self.assertEqual([item["id"] for item in series["nodes"]], ["v1.16.0", "dev"])
        publisher.validate_history(data)

    def test_codex_selector_requires_a_rust_runtime_and_never_enters_backfill(self):
        import prepare_public as selector

        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "selection"
            args = ["prepare_public.py", "--output", str(output),
                    "--benchmark-method", selector.CODEX_MIXED_METHOD]
            with patch("sys.argv", args + ["--mode", "backfill"]), patch.object(selector, "public_repository") as query:
                with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
                    selector.main()
                self.assertEqual(error.exception.code, 2)
                query.assert_not_called()
                self.assertFalse(output.exists())
            with patch("sys.argv", args + ["--mode", "dev", "--ref", "dev/v2.0.0"]), \
                    patch.object(selector, "public_repository"), patch.object(selector, "load_history", return_value=history()), \
                    patch.object(selector, "resolve", return_value="a" * 40), \
                    patch.object(selector, "source_runtime", return_value="js") as runtime:
                with self.assertRaisesRegex(ValueError, "requires a public Rust host"):
                    selector.main()
                selection = output / "selection.json"
                self.assertFalse(selection.exists())
                runtime.return_value = "rust"
                selector.main()
                actual = json.loads(selection.read_text(encoding="utf-8"))
                self.assertEqual(actual["method_id"], selector.CODEX_MIXED_METHOD)
                self.assertEqual(actual["runtime"], "rust")

    def test_codex_high_capacity_has_three_waves_and_requires_source_evidence(self):
        method = publisher.CODEX_STANDARD_METHOD
        round_ = {"repeat": 1, "produced_turns": 6000, "completed_turns": 5998, "missing_responses": 6,
                  "backlog": {"pending_turns": 2, "late_turns": 0, "unread_bytes": 4131}}
        sample = {"capacity": {"drain_seconds": 15, "rounds": [round_]}}
        quality = {"passed": False, "validated_prefix": True, "missing": 8, "duplicates": 0}
        publisher.validate_capacity(sample, quality, method)
        with self.assertRaises(ValueError):
            publisher.validate_capacity(sample, quality)
        round_["backlog"]["unread_bytes"] = 0
        with self.assertRaisesRegex(ValueError, "Codex backlog"):
            publisher.validate_capacity(sample, quality, method)
        round_["backlog"]["late_turns"] = 2
        publisher.validate_capacity(sample, quality, method)
        round_["missing_responses"] = 7
        with self.assertRaisesRegex(ValueError, "round counts"):
            publisher.validate_capacity(sample, quality, method)

    def test_mixed_workload_requires_throughput_and_the_exact_cadence(self):
        directory = Path(__file__).resolve().parents[2] / "tests/performance_native"
        method_id = publisher.QODER_MIXED_METHOD
        method = json.loads((directory / publisher.METHOD_FILES[method_id]).read_text())
        value = node()
        value["method_id"] = method_id
        for load, sample in value["workloads"].items():
            rate = 0 if load == "idle" else 2
            sample.update(poll_interval_ms=method["loads"][load]["poll_interval_ms"],
                          cpu_peak_percent={"median": 4, "min": 3, "max": 5},
                          rss_average_mib={"median": 19, "min": 18, "max": 20},
                          raw_input_bytes_per_second={"median": rate, "min": rate, "max": rate},
                          jsonl_output_bytes_per_second={"median": rate, "min": rate, "max": rate})
        data = history()
        self.assertTrue(publisher.merge_method(data, method, value))
        value["workloads"]["high"]["poll_interval_ms"] = 10_000
        with self.assertRaisesRegex(ValueError, "workload polling interval"):
            publisher.validate_node(value)
        value["workloads"]["high"]["poll_interval_ms"] = 100
        del value["workloads"]["high"]["jsonl_output_bytes_per_second"]
        with self.assertRaisesRegex(ValueError, "statistic"):
            publisher.validate_node(value)

    def test_fixed_qoder_cadence_and_drain_are_preserved(self):
        directory = Path(__file__).resolve().parents[2] / "tests/performance_native"
        method_id = publisher.QODER_FIXED_30S_METHOD
        method = json.loads((directory / publisher.METHOD_FILES[method_id]).read_text())
        value = node(version="v1.14.0")
        value["method_id"] = method_id
        for sample in value["workloads"].values():
            sample.update(poll_interval_ms=30_000,
                          cpu_peak_percent={"median": 4, "min": 3, "max": 5},
                          rss_average_mib={"median": 19, "min": 18, "max": 20},
                          raw_input_bytes_per_second=dict.fromkeys(("median", "min", "max"), 0),
                          jsonl_output_bytes_per_second=dict.fromkeys(("median", "min", "max"), 0))
        high = value["workloads"]["high"]
        high["quality"] = {"passed": False, "validated_prefix": True, "missing": 20, "duplicates": 0}
        high["capacity"] = {"drain_seconds": 45, "rounds": [{
            "repeat": 1, "produced_turns": 6000, "completed_turns": 5990,
            "missing_responses": 20, "backlog": {"pending_notices": 10},
        }]}
        data = history()
        self.assertTrue(publisher.merge_method(data, method, value))
        self.assertEqual(data["other_methods"][method_id]["nodes"][0]["workloads"]["high"]["poll_interval_ms"], 30_000)
        high["capacity"]["drain_seconds"] = 15
        with self.assertRaisesRegex(ValueError, "high-load drain evidence"):
            publisher.validate_node(value)

    def test_trusted_codex_method_keeps_both_metrics_in_its_own_series(self):
        descriptor = Path(__file__).resolve().parents[2] / "tests/performance_native"
        method_id = publisher.CODEX_STANDARD_METHOD
        method = json.loads((descriptor / publisher.METHOD_FILES[method_id]).read_text(encoding="utf-8"))
        data = history()
        data["method"] = {"id": publisher.LEGACY_METHOD}
        value = node()
        value["method_id"] = method_id
        with self.assertRaisesRegex(ValueError, "resource statistic"):
            publisher.merge_method(data, method, value)
        for sample in value["workloads"].values():
            sample["cpu_peak_percent"] = {"median": 4, "min": 3, "max": 5}
            sample["rss_average_mib"] = {"median": 19, "min": 18, "max": 20}
        self.assertTrue(publisher.merge_method(data, method, value))
        self.assertEqual(data["nodes"], [])
        actual = data["other_methods"][method_id]["nodes"][0]["workloads"]["idle"]
        self.assertEqual(actual["cpu_peak_percent"]["median"], 4)
        self.assertEqual(actual["rss_average_mib"]["median"], 19)
        invalid_method = copy.deepcopy(data)
        invalid_method["other_methods"][method_id]["method"]["poll_interval_ms"] = 100
        with self.assertRaisesRegex(ValueError, "measurement settings"):
            publisher.validate_history(invalid_method)

    def test_additional_method_rejects_cross_method_nodes_and_changed_parameters(self):
        data = history()
        data["method"] = {"id": "test-method"}
        method = {"id": "codex-method", "window_seconds": 30}
        value = node()
        with self.assertRaisesRegex(ValueError, "differs from the trusted method"):
            publisher.merge_method(data, method, value)
        value["method_id"] = method["id"]
        self.assertTrue(publisher.merge_method(data, method, value))
        with self.assertRaisesRegex(ValueError, "test parameters changed"):
            publisher.merge_method(data, {**method, "window_seconds": 60}, value)
        data["other_methods"][method["id"]]["nodes"][0]["method_id"] = data["method"]["id"]
        with self.assertRaisesRegex(ValueError, "another test method"):
            publisher.validate_history(data)

    def test_standard_method_requires_average_and_peak_without_changing_legacy_nodes(self):
        legacy = node("dev")
        old_sample = publisher.compact(legacy)["workloads"]["idle"]
        self.assertNotIn("cpu_peak_percent", old_sample)
        self.assertNotIn("rss_average_mib", old_sample)
        value = node("dev")
        value["method_id"] = publisher.STANDARD_METHOD
        with self.assertRaisesRegex(ValueError, "finite resource statistic"):
            publisher.validate_node(value)
        for sample in value["workloads"].values():
            sample["cpu_peak_percent"] = {"median": 5, "min": 4, "max": 6}
            sample["rss_average_mib"] = {"median": 16, "min": 15, "max": 17}
        publisher.validate_node(value)
        self.assertEqual(publisher.compact(value)["workloads"]["idle"]["cpu_peak_percent"],
                         {"median": 5, "min": 4, "max": 6})
        self.assertEqual(publisher.compact(value)["workloads"]["idle"]["rss_average_mib"],
                         {"median": 16, "min": 15, "max": 17})
        value["workloads"]["low"]["cpu_peak_percent"] = {"median": 1, "min": .5, "max": 2}
        with self.assertRaisesRegex(ValueError, "peak CPU"):
            publisher.validate_node(value)
        value["workloads"]["low"]["cpu_peak_percent"] = {"median": 5, "min": 4, "max": 6}
        value["workloads"]["low"]["rss_average_mib"] = {"median": 25, "min": 24, "max": 26}
        with self.assertRaisesRegex(ValueError, "peak RSS"):
            publisher.validate_node(value)

    def test_first_release_success_is_immutable_and_releases_sort_before_mutable_slots(self):
        data = history()
        publisher.merge(data, node("release", "1.16.0"))
        publisher.merge(data, node("release", "1.15.2", "b" * 40))
        self.assertEqual([n["id"] for n in data["nodes"]], ["v1.15.2", "v1.16.0"])
        before = copy.deepcopy(data)
        failed = node(); failed["status"] = "failed"; failed["workloads"] = {}
        self.assertFalse(publisher.merge(data, failed))
        self.assertEqual(data, before)
        moved = node(commit="c" * 40)
        with self.assertRaises(ValueError):
            publisher.merge(data, moved)

    def test_stale_main_and_slow_older_dev_request_cannot_overwrite_newer_slots(self):
        data = history()
        self.assertFalse(publisher.merge(data, node("main"), current_main="b" * 40))
        newer = node("dev", commit="c" * 40)
        self.assertTrue(publisher.merge(data, newer, current_dev=newer["commit"], publication={"run_number": 10}))
        before = copy.deepcopy(data)
        older = node("dev", commit="d" * 40)
        self.assertFalse(publisher.merge(data, older, current_dev=older["commit"], publication={"run_number": 9}))
        self.assertEqual(data, before)

    def test_main_clears_only_proven_merged_dev_and_preserves_unrelated_dev(self):
        for proof in (False, True):
            data = history(); dev = node("dev", commit="d" * 40); data["nodes"].append(dev)
            main = node("main", commit="a" * 40)
            with patch.object(publisher, "contains", return_value=proof):
                publisher.merge(data, main, current_main=main["commit"], source_repo="unused")
            self.assertEqual(any(n["id"] == "dev" for n in data["nodes"]), not proof)
        data = history(); data["nodes"].append(node("dev", commit="d" * 40))
        with patch.object(publisher, "contains", return_value=False):
            publisher.merge(data, node("main"), current_main="a" * 40, source_repo="unused", merged_dev="d" * 40)
        self.assertEqual([n["id"] for n in data["nodes"]], ["main"])

    def test_initial_main_is_pending_identity_not_an_invented_measurement(self):
        data = history()
        self.assertTrue(publisher.ensure_main_slot(data, "a" * 40, "method"))
        main = data["nodes"][0]
        self.assertEqual((main["id"], main["status"], main["workloads"]), ("main", "pending", {}))
        before = copy.deepcopy(main)
        self.assertFalse(publisher.ensure_main_slot(data, "b" * 40, "method"))
        self.assertEqual(data["nodes"][0], before)

    def test_cutoff_requires_explicit_source_and_smoke_proof_and_blocks_inflight_old_result(self):
        data = history()
        publisher.merge(data, node("release", "1.16.0"))
        publisher.merge(data, node("release", "1.15.2", "b" * 40))
        event = {"classification": "infrastructure", "confirmed": False}
        with self.assertRaises(ValueError):
            publisher.apply_cutoff(data, event)
        event = {"classification": "collection_incompatible", "confirmed": True,
            "excluded_at_or_before": "v1.15.2", "reason": "explicit test contract confirmation",
            "source_repository": publisher.OFFICIAL, "source_commit": "b" * 40,
            "source_evidence_url": "https://github.com/" + publisher.OFFICIAL + "/blob/" + "b" * 40 + "/public-source",
            "smoke_evidence_url": "https://github.com/" + publisher.OFFICIAL + "/actions/runs/2"}
        self.assertTrue(publisher.apply_cutoff(data, event))
        self.assertEqual([n["id"] for n in data["nodes"]], ["v1.16.0"])
        self.assertFalse(publisher.merge(data, node("release", "1.15.1", "c" * 40)))

    def test_compaction_excludes_raw_evidence_and_preserves_cohort_facts_and_failure_class(self):
        value = node(); value["rounds"] = [{"frame": "do not persist"}]
        value["logs"] = "do not persist"
        value["provenance"] = {"entry_sha256": "a" * 64, "asset_sha256": "b" * 64, "raw": "do not persist"}
        compact = publisher.compact(value)
        self.assertNotIn("rounds", compact); self.assertNotIn("logs", compact)
        self.assertNotIn("raw", compact["provenance"])
        self.assertEqual(compact["environment"]["kernel"], "test-kernel")
        self.assertEqual(compact["environment"]["node_version"], "test-node")
        value["status"] = "failed"; value["error_category"] = "quality_failure"
        value["error"] = "raw exception and local paths are not public history"
        compact = publisher.compact(value)
        self.assertEqual(compact["failure_category"], "quality")
        self.assertNotIn("error", compact)

    def test_passed_gate_rejects_missing_rounds_quality_bad_rss_and_unknown_environment(self):
        for alter in (lambda n: n["workloads"]["low"].update(repeats=2),
                      lambda n: n["workloads"]["low"]["quality"].update(missing=1),
                      lambda n: n["workloads"]["low"]["rss_mib"].update(min=0),
                      lambda n: n["environment"].update(cpu_model="unknown")):
            value = node(); alter(value)
            with self.assertRaises(ValueError):
                publisher.validate_node(value)

    def test_embedded_json_cannot_close_its_script_and_marker_is_unique(self):
        value = {"schema": 1, "nodes": [], "note": "</script><script>bad()</script>"}
        result = publisher.render("<script type=application/json>__PILOT_PERFORMANCE_DATA__</script>", value)
        self.assertNotIn("</script><script>", result)
        self.assertIn("\\u003c/script>", result)
        with self.assertRaises(ValueError):
            publisher.render("__PILOT_PERFORMANCE_DATA____PILOT_PERFORMANCE_DATA__", value)

    def test_historical_download_hash_is_not_misrepresented_as_a_published_digest(self):
        url = "https://github.com/" + publisher.OFFICIAL + "/releases/download/v1.16.0/loongsuite-pilot.tar.gz"
        asset = {"id": 123, "name": "loongsuite-pilot.tar.gz", "size": 456, "browser_download_url": url, "digest": None}
        release = {"html_url": "https://github.com/" + publisher.OFFICIAL + "/releases/tag/v1.16.0", "assets": [asset]}
        selection = {"asset_id": "123", "asset_name": asset["name"], "asset_size_bytes": "456", "asset_url": url,
                     "asset_sha256": "a" * 64, "checksum_source": "download"}
        value = publisher.release_provenance(release, selection)
        self.assertEqual(value["checksum_source"], "download")
        asset["digest"] = "sha256:" + "a" * 64
        selection["checksum_source"] = "github_asset_digest"
        self.assertEqual(publisher.release_provenance(release, selection)["checksum_source"], "github_asset_digest")
        asset["digest"] = "sha256:" + "b" * 64
        with self.assertRaises(ValueError):
            publisher.release_provenance(release, selection)
        asset["digest"] = None; selection["checksum_source"] = "download"; asset["size"] = 457
        with self.assertRaises(ValueError):
            publisher.release_provenance(release, selection)


if __name__ == "__main__":
    unittest.main()
