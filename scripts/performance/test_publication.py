"""Data-only publication regressions; no network, Docker, build or benchmark."""
import copy
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
    def test_invalid_history_and_duplicate_slots_fail_before_cutoff_or_merge(self):
        data = history(); data["nodes"] = [node(), node()]
        with self.assertRaises(ValueError):
            publisher.validate_history(data)
        data = history(); data["compatibility"] = "invalid"
        with self.assertRaises(ValueError):
            publisher.validate_history(data)

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
