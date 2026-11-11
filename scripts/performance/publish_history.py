#!/usr/bin/env python3
"""Validate and merge one public full-Pilot node; never execute artifact code.

Run only from trusted upstream source in the isolated publication job.
Git authentication/push is owned by that job, not by result JSON or this module.
"""
import argparse
import copy
import datetime
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.parse

from prepare_public import (
    CODEX_MIXED_METHOD, CODEX_STANDARD_METHOD, QODER_FIXED_30S_DRAIN_SECONDS,
    QODER_FIXED_30S_METHOD, QODER_FIXED_30S_POLL_MS, QODER_MIXED_METHOD,
)

LOADS = ("idle", "low", "high")
HIGH_TURNS = 6000
DRAIN_SECONDS = 15
LEGACY_METHOD = "github-full-pilot-qoder-native-v1"
STANDARD_METHOD = "github-full-pilot-qoder-native-10s-v1"
POLL_BY_LOAD = {"idle": 10_000, "low": 10_000, "high": 100}
POLL_BY_METHOD = {
    QODER_MIXED_METHOD: POLL_BY_LOAD,
    CODEX_MIXED_METHOD: POLL_BY_LOAD,
    QODER_FIXED_30S_METHOD: dict.fromkeys(LOADS, QODER_FIXED_30S_POLL_MS),
}
PEAK_METHODS = {STANDARD_METHOD, CODEX_STANDARD_METHOD, *POLL_BY_METHOD}
THROUGHPUT_METRICS = ("raw_input_bytes_per_second", "jsonl_output_bytes_per_second")
METHOD_FILES = {
    STANDARD_METHOD: "pilot-history-method-10s.json",
    CODEX_STANDARD_METHOD: "pilot-history-method-codex-10s.json",
    QODER_MIXED_METHOD: "pilot-history-method-qoder-v2.json",
    QODER_FIXED_30S_METHOD: "pilot-history-method-qoder-30s.json",
    CODEX_MIXED_METHOD: "pilot-history-method-codex-v2.json",
}
SHA = re.compile(r"[0-9a-f]{40}\Z")
VERSION = re.compile(r"v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z")
REPOSITORY = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")
OFFICIAL = "alibaba/loongsuite-pilot"
SITE_WORKFLOW = ".github/workflows/performance-site.yml"
RESULT_FILES = {"history.json", "index.html", ".nojekyll", SITE_WORKFLOW}


def version_key(value):
    if not isinstance(value, str):
        raise ValueError("release version must be text")
    match = VERSION.fullmatch(value)
    if not match:
        raise ValueError("only stable semantic release versions are supported")
    return tuple(int(part) for part in match.groups())


def read_json(path):
    path = Path(path)
    if path.stat().st_size > 4 * 1024 * 1024:
        raise ValueError("compact report input exceeds 4MiB")
    return json.loads(path.read_text(encoding="utf-8"))


def count(value, name):
    if type(value) is not int or value < 0:
        raise ValueError("invalid count: " + name)


def validate_capacity(sample, quality, method_id=LEGACY_METHOD):
    capacity = sample["capacity"]
    drain = QODER_FIXED_30S_DRAIN_SECONDS if method_id == QODER_FIXED_30S_METHOD else DRAIN_SECONDS
    if (not isinstance(capacity, dict) or set(capacity) != {"drain_seconds", "rounds"}
            or capacity["drain_seconds"] != drain):
        raise ValueError("invalid high-load drain evidence")
    rounds = capacity["rounds"]
    if not isinstance(rounds, list) or not 1 <= len(rounds) <= 3:
        raise ValueError("invalid number of high-load capacity rounds")
    repeats, missing = set(), 0
    for round_ in rounds:
        if not isinstance(round_, dict) or set(round_) != {
                "repeat", "produced_turns", "completed_turns", "missing_responses", "backlog"}:
            raise ValueError("invalid capacity round evidence")
        for field in ("repeat", "produced_turns", "completed_turns", "missing_responses"):
            count(round_[field], field)
        repeat, produced = round_["repeat"], round_["produced_turns"]
        completed, absent = round_["completed_turns"], round_["missing_responses"]
        codex = method_id in (CODEX_STANDARD_METHOD, CODEX_MIXED_METHOD)
        pending = produced - completed
        if (repeat not in (1, 2, 3) or repeat in repeats or produced != HIGH_TURNS
                or not 0 <= completed < produced or not (0 if codex else 1) <= absent <= (3 if codex else 2) * pending):
            raise ValueError("invalid high-load round counts")
        repeats.add(repeat)
        missing += absent + (pending if codex else 0)
        backlog = round_["backlog"]
        if not isinstance(backlog, dict):
            raise ValueError("missing high-load backlog")
        for field, value in backlog.items():
            count(value, field)
        if codex:
            if (set(backlog) != {"pending_turns", "late_turns", "unread_bytes"}
                    or backlog["pending_turns"] != pending or not 0 <= backlog["late_turns"] <= pending
                    or (backlog["late_turns"] == pending) != (backlog["unread_bytes"] == 0)):
                raise ValueError("invalid high-load Codex backlog counts")
            continue
        if set(backlog) == {"pending_notices"} and backlog["pending_notices"] > 0:
            continue
        if (set(backlog) != {"queued", "started", "completed", "active", "pending"}
                or backlog["queued"] != produced + 64
                or backlog["queued"] != backlog["started"] + backlog["pending"]
                or backlog["started"] != backlog["completed"] + backlog["active"]
                or backlog["pending"] + backlog["active"] <= 0):
            raise ValueError("invalid high-load backlog counts")
    if (quality.get("passed") is not False or quality.get("validated_prefix") is not True
            or quality["missing"] != missing or quality["duplicates"] or sample.get("p95_ms") is not None):
        raise ValueError("invalid high-load prefix quality evidence")


def validate_node(node):
    if not isinstance(node, dict) or node.get("kind") not in ("release", "main", "dev"):
        raise ValueError("invalid node kind")
    kind = node["kind"]
    expected_id = "v" + ".".join(map(str, version_key(node.get("version", "")))) if kind == "release" else kind
    if node.get("id") != expected_id:
        raise ValueError("node identity must be stable release tag, main or dev")
    if kind != "release" and node.get("version") != kind:
        raise ValueError("main/dev are mutable labelled slots")
    if not isinstance(node.get("commit"), str) or not SHA.fullmatch(node["commit"]):
        raise ValueError("node requires exact public source commit")
    if node.get("status") not in ("passed", "pending", "failed"):
        raise ValueError("invalid node status")
    for field in ("recorded_at", "method_id", "environment_id"):
        if not isinstance(node.get(field), str) or not node[field]:
            raise ValueError("missing node metadata: " + field)
    if not isinstance(node.get("environment"), dict):
        raise ValueError("missing environment")
    if not isinstance(node.get("run_url", ""), str):
        raise ValueError("invalid run URL")
    if node.get("run_url"):
        run = urllib.parse.urlparse(node["run_url"])
        if run.scheme != "https" or run.netloc != "github.com" or not re.fullmatch(r"/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/actions/runs/[0-9]+", run.path):
            raise ValueError("run URL must identify a public GitHub Actions run")
    source = node.get("source")
    if source is not None:
        if not isinstance(source, dict) or not isinstance(source.get("repository"), str) or not REPOSITORY.fullmatch(source["repository"]):
            raise ValueError("invalid public source identity")
        if not isinstance(source.get("ref"), str) or not source["ref"] or any(c in source["ref"] for c in "\r\n\0"):
            raise ValueError("invalid source ref")
        if kind in ("main", "release") and source["repository"] != OFFICIAL:
            raise ValueError("main and formal releases must come from public upstream")
    if node["status"] != "passed":
        # Failed/missing measurements may be absent or null; never fill zeros.
        return
    for field in ("cpu_model", "runner_os", "runner_image"):
        value = node["environment"].get(field)
        if not isinstance(value, str) or not value.strip() or "unknown" in value.lower():
            raise ValueError("passed node requires known environment: " + field)
    if node["environment"].get("cgroup_version") not in ("v1", "v2"):
        raise ValueError("passed node requires the observed cgroup version")
    workloads = node.get("workloads")
    if not isinstance(workloads, dict) or set(workloads) != set(LOADS):
        raise ValueError("passed node requires exactly three workloads")
    for name in LOADS:
        sample = workloads[name]
        if not isinstance(sample, dict) or type(sample.get("repeats")) is not int or sample["repeats"] != 3:
            raise ValueError("a passed workload requires three rounds")
        quality = sample.get("quality", {})
        if not isinstance(quality, dict):
            raise ValueError("workload quality must be an object")
        for field in ("missing", "duplicates"):
            count(quality.get(field), field)
        if "capacity" in sample:
            if name != "high":
                raise ValueError("capacity results require high load")
            validate_capacity(sample, quality, node["method_id"])
        elif quality.get("passed") is not True or quality["missing"] or quality["duplicates"]:
            raise ValueError("quality failure cannot be a passed node")
        metrics = ["cpu_percent", "rss_mib"]
        if node["method_id"] in PEAK_METHODS or "cpu_peak_percent" in sample:
            metrics.append("cpu_peak_percent")
        if node["method_id"] in PEAK_METHODS or "rss_average_mib" in sample:
            metrics.append("rss_average_mib")
        polling = POLL_BY_METHOD.get(node["method_id"])
        if polling is not None:
            if sample.get("poll_interval_ms") != polling[name]:
                raise ValueError("invalid workload polling interval")
            metrics.extend(THROUGHPUT_METRICS)
        for field in metrics:
            summary = sample.get(field, {})
            if not isinstance(summary, dict):
                raise ValueError("resource statistics must be an object")
            for statistic in ("median", "min", "max"):
                value = summary.get(statistic)
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
                    raise ValueError("invalid finite resource statistic")
            if not summary["min"] <= summary["median"] <= summary["max"]:
                raise ValueError("invalid resource range")
            if field in ("rss_mib", "rss_average_mib") and summary["min"] <= 0:
                raise ValueError("RSS must be measured and positive")
        peak = sample.get("cpu_peak_percent")
        if peak and any(peak[statistic] + 1e-9 < sample["cpu_percent"][statistic]
                        for statistic in ("min", "median", "max")):
            raise ValueError("peak CPU must be at least the average over the same window")
        average_rss = sample.get("rss_average_mib")
        if average_rss and any(sample["rss_mib"][statistic] + 1e-9 < average_rss[statistic]
                               for statistic in ("min", "median", "max")):
            raise ValueError("peak RSS must be at least the average over the same window")


def node_order(node):
    return (0, version_key(node["version"])) if node["kind"] == "release" else (1 if node["kind"] == "main" else 2, ())


def validate_node_slots(nodes, method_id=None):
    if not isinstance(nodes, list) or len(nodes) > 512:
        raise ValueError("unexpected history node count")
    identities = set()
    for node in nodes:
        validate_node(node)
        if node["id"] in identities:
            raise ValueError("duplicate node slot in history")
        if method_id is not None and node["method_id"] != method_id:
            raise ValueError("measurement belongs to another test method")
        identities.add(node["id"])


def validate_history(history):
    if not isinstance(history, dict) or history.get("schema") != 1 or history.get("repository") != OFFICIAL:
        raise ValueError("invalid generated history identity")
    methods = history.get("other_methods", {})
    if not isinstance(methods, dict):
        raise ValueError("invalid additional test methods")
    primary = history.get("method") or {}
    if not isinstance(primary, dict):
        raise ValueError("invalid primary test method")
    validate_node_slots(history.get("nodes"), primary.get("id"))
    for method_id, series in methods.items():
        if (not isinstance(method_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", method_id)
                or not isinstance(series, dict) or set(series) != {"method", "nodes", "updated_at"}
                or not isinstance(series["method"], dict) or series["method"].get("id") != method_id
                or method_id == primary.get("id")):
            raise ValueError("invalid additional test method identity")
        method = series["method"]
        if method_id in PEAK_METHODS:
            expected = {"session_count": 64, "window_seconds": 30, "cpu_sample_ms": 100, "rss_sample_ms": 100}
            if method_id not in POLL_BY_METHOD:
                expected["poll_interval_ms"] = 10_000
            if method_id == QODER_FIXED_30S_METHOD:
                expected["drain_seconds"] = QODER_FIXED_30S_DRAIN_SECONDS
            if any(method.get(key) != value for key, value in expected.items()):
                raise ValueError("invalid standard measurement settings")
        if method_id in POLL_BY_METHOD:
            loads = method.get("loads")
            if not isinstance(loads, dict) or any(not isinstance(loads.get(load), dict)
                    or loads[load].get("poll_interval_ms") != interval
                    for load, interval in POLL_BY_METHOD[method_id].items()):
                raise ValueError("invalid workload measurement settings")
        validate_node_slots(series["nodes"], method_id)
    compatibility = history.get("compatibility")
    if compatibility is not None and not isinstance(compatibility, dict):
        raise ValueError("invalid compatibility boundary")
    if compatibility and compatibility.get("excluded_at_or_before"):
        version_key(compatibility["excluded_at_or_before"])
    if history.get("temporary_preview") is not None:
        validate_temporary_preview(history["temporary_preview"])


def validate_temporary_preview(value):
    """Only two numeric node overrides; no private identities or formal CI status."""
    if not isinstance(value, dict) or set(value) != {"schema", "kind", "rows"} or value.get("schema") != 1 or value.get("kind") != "temporary_preview":
        raise ValueError("invalid temporary preview envelope")
    rows = value["rows"]
    if not isinstance(rows, list) or len(rows) != 2:
        raise ValueError("temporary preview requires two numeric overrides")
    identities = set()
    for row in rows:
        if not isinstance(row, dict) or set(row) != {"id", "workloads"} or row.get("id") not in ("v1.15.2", "dev") or row["id"] in identities:
            raise ValueError("invalid temporary preview row")
        identities.add(row["id"])
        if not isinstance(row["workloads"], dict) or set(row["workloads"]) != set(LOADS):
            raise ValueError("temporary preview requires three loads")
        for sample in row["workloads"].values():
            if not isinstance(sample, dict) or set(sample) != {"cpu_percent", "rss_mib"}:
                raise ValueError("temporary preview contains non-numeric metadata")
            for metric, number in sample.items():
                if isinstance(number, bool) or not isinstance(number, (int, float)) or not math.isfinite(number) or number < 0 or (metric == "rss_mib" and number <= 0):
                    raise ValueError("invalid temporary preview measurement")


def contains(source_repo, ancestor, descendant):
    if not SHA.fullmatch(ancestor) or not SHA.fullmatch(descendant):
        raise ValueError("ancestry requires exact commits")
    available = subprocess.run(["git", "-C", str(source_repo), "cat-file", "-e", ancestor + "^{commit}"],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if available.returncode:
        return False  # no proof means preserve dev, never guess it was merged
    result = subprocess.run(["git", "-C", str(source_repo), "merge-base", "--is-ancestor", ancestor, descendant],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode not in (0, 1):
        raise RuntimeError("cannot prove dev ancestry; preserve dev and fetch its public commit")
    return result.returncode == 0


def compact(node, publication=None, asset_sha256=None):
    """Do not commit raw rounds, transcripts, logs or paths to the results branch."""
    validate_node(node)
    fields = ("id", "kind", "version", "commit", "recorded_at", "status", "method_id",
              "environment_id", "environment", "run_url", "workloads", "source")
    result = {key: copy.deepcopy(node[key]) for key in fields if key in node}
    environment_keys = ("cpu_model", "runner_os", "runner_image", "container_image", "container_image_id",
                        "container_digest", "cgroup_version", "cpu_limit", "memory_limit", "runner_arch",
                        "kernel", "architecture", "cpus", "node_version")
    result["environment"] = {key: node["environment"][key] for key in environment_keys if key in node["environment"]}
    if isinstance(result.get("source"), dict):
        result["source"] = {key: result["source"][key] for key in ("repository", "ref")}
    else:
        result.pop("source", None)
    result["workloads"] = {}
    workloads = node.get("workloads") or {}
    if not isinstance(workloads, dict):
        raise ValueError("workloads must be an object")
    for load in LOADS:
        sample = workloads.get(load)
        if not isinstance(sample, dict):
            continue
        kept = {key: sample[key] for key in ("repeats", "p95_ms", "poll_interval_ms") if key in sample}
        metrics = ["cpu_percent", "rss_mib"]
        if "cpu_peak_percent" in sample:
            metrics.append("cpu_peak_percent")
        if "rss_average_mib" in sample:
            metrics.append("rss_average_mib")
        metrics.extend(field for field in THROUGHPUT_METRICS if field in sample)
        for key in metrics:
            summary = sample.get(key)
            kept[key] = {name: summary[name] for name in ("median", "min", "max") if name in summary} if isinstance(summary, dict) else None
        quality = sample.get("quality")
        kept["quality"] = {key: quality[key] for key in ("passed", "missing", "duplicates") if key in quality} if isinstance(quality, dict) else None
        if node["status"] == "passed" and "capacity" in sample:
            kept["capacity"] = copy.deepcopy(sample["capacity"])
            kept["quality"]["validated_prefix"] = True
        result["workloads"][load] = kept
    allowed_provenance = ("collection", "legacy_fixture_sha256", "legacy_dispatcher_sha256",
                          "entry_sha256", "library_sha256", "fixture_sha256", "compiler", "asset_sha256", "release_url",
                          "asset_id", "asset_name", "asset_size_bytes", "asset_url", "checksum_source")
    provenance = node.get("provenance") or {}
    if not isinstance(provenance, dict):
        raise ValueError("provenance must be an object")
    result["provenance"] = {key: provenance[key] for key in allowed_provenance if key in provenance}
    if asset_sha256:
        if not re.fullmatch(r"[0-9a-f]{64}", asset_sha256):
            raise ValueError("invalid release asset SHA256")
        result["provenance"]["asset_sha256"] = asset_sha256
    if node["status"] == "failed":
        # Full diagnostics stay in the short-lived artifact; never copy a raw
        # exception, local path or arbitrary candidate stdout into public history.
        category = node.get("failure_category") or node.get("error_category")
        if category == "quality_failure":
            category = "quality"
        result["failure_category"] = category if category in ("infrastructure", "quality", "measurement_failed") else "measurement_failed"
    if publication:
        if type(publication.get("run_number")) is not int or publication["run_number"] <= 0:
            raise ValueError("publication order requires trusted workflow run number")
        result["publication"] = dict(publication)
    return result


def merge(history, node, current_main=None, current_dev=None, source_repo=None, merged_dev=None, publication=None):
    validate_node(node)
    validate_history(history)
    cutoff = (history.get("compatibility") or {}).get("excluded_at_or_before")
    if node["kind"] == "release" and cutoff and version_key(node["version"]) <= version_key(cutoff):
        return False  # an older in-flight result cannot resurrect excluded history
    old = {value["id"]: value for value in history["nodes"]}
    if node["kind"] == "main" and node["commit"] != current_main:
        return False  # stale main run must not overwrite the current slot
    if node["kind"] == "dev" and node["commit"] != current_dev:
        return False
    existing = old.get(node["id"])
    if existing and node["kind"] != "release":
        old_order = existing.get("publication", {}).get("run_number", 0)
        if publication and old_order > publication["run_number"]:
            return False  # a slower old main/dev run cannot replace a newer request
        if existing["commit"] == node["commit"] and existing["status"] == "passed":
            return False  # a duplicate or failed rerun never destroys a valid same-tip result
        if source_repo and existing["commit"] != node["commit"] and contains(source_repo, node["commit"], existing["commit"]):
            return False  # independently reject an ancestor finishing after its descendant
    if existing and node["kind"] == "release":
        if existing["commit"] != node["commit"]:
            raise ValueError("published release tag changed commit")
        if existing["status"] == "passed":
            return False  # first successful formal release sample is retained
    node = compact(node, publication)
    if node["kind"] == "dev" and source_repo:
        main = old.get("main")
        if main and main["status"] == "passed" and main["commit"] == current_main and contains(source_repo, node["commit"], main["commit"]):
            return False  # do not resurrect an already measured, merged dev slot
    old[node["id"]] = node
    dev = old.get("dev")
    if node["kind"] == "main" and node["status"] == "passed" and dev:
        if source_repo is None:
            raise ValueError("source repository required to decide whether dev was merged")
        if contains(source_repo, dev["commit"], node["commit"]) or merged_dev == dev["commit"]:
            del old["dev"]
    history["nodes"] = sorted(old.values(), key=node_order)
    history["updated_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    return True


def merge_method(history, method, node, *, current_main=None, current_dev=None, source_repo=None,
                 merged_dev=None, publication=None):
    """Merge a measured node into its own method's release/main/dev slots."""
    validate_history(history)
    method_id = method.get("id") if isinstance(method, dict) else None
    if not isinstance(method_id, str) or not isinstance(node, dict) or node.get("method_id") != method_id:
        raise ValueError("measurement method differs from the trusted method")
    arguments = dict(current_main=current_main, current_dev=current_dev, source_repo=source_repo,
                     merged_dev=merged_dev, publication=publication)
    if method_id == (history.get("method") or {}).get("id"):
        return merge(history, node, **arguments)

    methods = history.get("other_methods", {})
    previous = methods.get(method_id)
    if previous and previous["method"] != method:
        raise ValueError("test parameters changed for the existing method ID")
    series = {"schema": 1, "repository": OFFICIAL, "nodes": previous["nodes"] if previous else []}
    if not merge(series, node, **arguments):
        return False
    changed = {"method": copy.deepcopy(method), "nodes": series["nodes"], "updated_at": series["updated_at"]}
    updated = {**methods, method_id: changed}
    validate_history({**history, "other_methods": updated})
    history["other_methods"] = updated
    return True


def retire_legacy_qoder(history, standard_method):
    """Promote the measured Qoder series and discard obsolete polling data."""
    if (history.get("method") or {}).get("id") != LEGACY_METHOD:
        return False
    methods = history.get("other_methods", {})
    standard = methods.pop(STANDARD_METHOD, {})
    history.pop("temporary_preview", None)
    history.update(method=standard_method, nodes=standard.get("nodes", []),
                   updated_at=standard.get("updated_at"), compatibility=None)
    return True


def apply_cutoff(history, event):
    """Only an explicit trusted confirmation with source AND smoke evidence cuts history."""
    validate_history(history)
    if event.get("classification") != "collection_incompatible" or event.get("confirmed") is not True:
        raise ValueError("infrastructure, timeouts and missing assets are not compatibility cutoffs")
    tag = event.get("excluded_at_or_before", "")
    key = version_key(tag)
    if event.get("source_repository") != OFFICIAL or not SHA.fullmatch(event.get("source_commit", "")):
        raise ValueError("cutoff needs exact public upstream source")
    reason = event.get("reason")
    source_url = event.get("source_evidence_url", "")
    smoke_url = event.get("smoke_evidence_url", "")
    prefix = "https://github.com/" + OFFICIAL + "/blob/" + event["source_commit"] + "/"
    if not isinstance(reason, str) or not reason.strip() or len(reason) > 2048 or not source_url.startswith(prefix):
        raise ValueError("cutoff needs a reason and immutable public source evidence")
    if not re.fullmatch(r"https://github\.com/alibaba/loongsuite-pilot/actions/runs/[0-9]+", smoke_url):
        raise ValueError("cutoff needs the actual isolated smoke run evidence")
    previous = history.get("compatibility") or {}
    if previous.get("excluded_at_or_before") and version_key(previous["excluded_at_or_before"]) > key:
        return False  # never silently relax a confirmed boundary
    compatibility = {name: event[name] for name in ("excluded_at_or_before", "reason", "source_repository",
        "source_commit", "source_evidence_url", "smoke_evidence_url", "classification", "confirmed")}
    remaining = [node for node in history["nodes"] if node["kind"] != "release" or version_key(node["version"]) > key]
    changed = compatibility != previous or remaining != history["nodes"]
    history["compatibility"] = compatibility
    history["nodes"] = remaining
    return changed


def ensure_main_slot(history, current_main, method_id):
    if any(node.get("kind") == "main" for node in history["nodes"]):
        return False
    if not isinstance(current_main, str) or not SHA.fullmatch(current_main):
        raise ValueError("initial history requires the actual public main SHA")
    history["nodes"].append({"id": "main", "kind": "main", "version": "main", "commit": current_main,
        "recorded_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
        "status": "pending", "method_id": method_id, "environment_id": "unavailable", "environment": {},
        "run_url": "", "workloads": {}, "source": {"repository": OFFICIAL, "ref": "main"}})
    history["nodes"].sort(key=node_order)
    return True  # identity only; no invented main measurement or borrowed release values


def target_dev_matches(history, node):
    """The latest results-branch configuration is the sole dev publication authority."""
    if node["kind"] != "dev":
        return True
    configuration = history.get("configuration")
    source = node.get("source") or {}
    branch = configuration.get("dev_branch") if isinstance(configuration, dict) else None
    return (isinstance(branch, str) and bool(branch) and source.get("repository") == OFFICIAL
            and source.get("ref") == branch)


def render(template, history):
    # application/json must not permit </script> or HTML to escape the data block.
    encoded = json.dumps(history, ensure_ascii=False, separators=(",", ":"), allow_nan=False).replace("<", "\\u003c")
    marker = "__PILOT_PERFORMANCE_DATA__"
    if template.count(marker) != 1:
        raise ValueError("HTML template requires exactly one data marker")
    return template.replace(marker, encoded)


def stage_site_workflow(destination, trusted):
    """Copy only the fixed workflow from trusted source, never artifact code."""
    source = Path(trusted) / SITE_WORKFLOW
    target = Path(destination) / SITE_WORKFLOW
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(source.read_text(encoding="utf-8"), encoding="utf-8")
    marker = Path(destination) / ".nojekyll"
    if not marker.exists():
        marker.touch()


def release_provenance(release, selection):
    """Recheck the official asset identity; a downloaded hash is not a published hash."""
    checksum = selection.get("asset_sha256", "")
    if not re.fullmatch(r"[0-9a-f]{64}", checksum):
        raise ValueError("release requires its actual downloaded SHA256")
    asset_id = int(selection.get("asset_id", "0"))
    size = int(selection.get("asset_size_bytes", "0"))
    if asset_id <= 0 or size <= 0:
        raise ValueError("release requires its exact public asset identity and size")
    asset = next((item for item in release.get("assets", []) if item.get("id") == asset_id), None)
    if asset is None or asset.get("name") != selection.get("asset_name") or asset.get("size") != size or asset.get("browser_download_url") != selection.get("asset_url"):
        raise ValueError("public release asset changed after selection")
    if not selection["asset_url"].startswith("https://github.com/" + OFFICIAL + "/releases/download/"):
        raise ValueError("release asset origin must be official upstream")
    digest = asset.get("digest")
    source = selection.get("checksum_source")
    if source not in ("download", "github_asset_digest"):
        raise ValueError("unknown checksum provenance")
    if digest and digest != "sha256:" + checksum:
        raise ValueError("release asset SHA256 differs from its published digest")
    if source == "github_asset_digest" and not digest:
        raise ValueError("previously published digest is no longer available")
    return {"asset_sha256": checksum, "asset_id": asset_id, "asset_name": asset["name"],
            "asset_size_bytes": size, "asset_url": asset["browser_download_url"],
            "checksum_source": source, "release_url": release["html_url"]}


def github_publish():
    """Fresh trusted job only: validate data, CAS a generated branch, optionally continue."""
    import base64
    import urllib.error
    import urllib.request
    from prepare_public import api, public_repository, resolve, select_backfill

    if os.environ.get("GITHUB_REPOSITORY") != OFFICIAL or os.environ.get("GITHUB_EVENT_NAME") not in ("push", "release", "workflow_dispatch"):
        raise ValueError("publication is restricted to trusted official events")
    trusted = Path(__file__).resolve().parents[2]
    actual_head = subprocess.check_output(["git", "-C", str(trusted), "rev-parse", "HEAD"]).decode().strip()
    if actual_head != os.environ.get("TRUSTED_WORKFLOW_SHA"):
        raise ValueError("publisher source must be the exact trusted workflow commit")
    expected = json.loads(os.environ["SELECTION_JSON"])
    repository, ref, commit = (expected.get(key, "") for key in ("repository", "ref", "commit"))
    public_repository(repository)
    if not SHA.fullmatch(commit) or expected.get("kind") not in ("release", "main", "dev"):
        raise ValueError("invalid trusted selector identity")
    artifact = Path(os.environ["PUBLICATION_INPUT"])
    method_id = expected.get("method_id")
    if method_id not in METHOD_FILES:
        raise ValueError("unrecognized benchmark method from the trusted selector")
    method_dir = trusted / "tests/performance_native"
    method = read_json(method_dir / METHOD_FILES[method_id])
    if method.get("id") != method_id:
        raise ValueError("trusted benchmark method file has the wrong identity")
    primary = method_id == STANDARD_METHOD
    standard_method = method if primary else read_json(method_dir / METHOD_FILES[STANDARD_METHOD])
    template = (trusted / "scripts/performance/pilot-history.html").read_text(encoding="utf-8")
    number = int(os.environ["GITHUB_RUN_NUMBER"])
    run_id = os.environ["GITHUB_RUN_ID"]
    if number <= 0 or not run_id.isdigit():
        raise ValueError("invalid trusted workflow run identity")
    run_url = "https://github.com/" + OFFICIAL + "/actions/runs/" + run_id
    publication = {"run_number": number, "run_id": run_id}
    node, cutoff = None, None
    confirm_tag = os.environ.get("CONFIRMED_INCOMPATIBLE_TAG", "")
    if confirm_tag:
        if not primary or expected.get("mode") != "backfill" or expected["version"] != confirm_tag:
            raise ValueError("cutoff confirmation must target the selected official backfill release")
        cutoff = {"excluded_at_or_before": confirm_tag, "classification": "collection_incompatible", "confirmed": True,
                  "source_repository": repository, "source_commit": commit,
                  "reason": os.environ.get("INCOMPATIBILITY_REASON", ""),
                  "source_evidence_url": os.environ.get("SOURCE_EVIDENCE_URL", ""),
                  "smoke_evidence_url": os.environ.get("SMOKE_EVIDENCE_URL", "")}
        # Validate the actual historical smoke run exists. The incompatibility
        # judgment is an explicit maintainer confirmation, never inferred from
        # a timeout, a missing archive or a failed configuration.
        smoke_url = cutoff["smoke_evidence_url"]
        if not re.fullmatch(r"https://github\.com/alibaba/loongsuite-pilot/actions/runs/[0-9]+", smoke_url):
            raise ValueError("invalid smoke evidence URL")
        smoke = api("repos/" + OFFICIAL + "/actions/runs/" + smoke_url.rsplit("/", 1)[1])
        if smoke.get("status") != "completed" or smoke.get("conclusion") != "failure" or smoke.get("path", "").split("@", 1)[0] != ".github/workflows/sdk-performance.yml":
            raise ValueError("cutoff must cite an actual completed failed smoke run")
    else:
        node = read_json(artifact / "node.json")
        validate_node(node)
        if any(node.get(key) != expected.get(key) for key in ("commit", "kind", "version")) or node.get("source") != {"repository": repository, "ref": ref}:
            raise ValueError("artifact identity differs from the trusted pre-build selector")
        if node["method_id"] != method["id"]:
            raise ValueError("artifact method differs from the trusted method")
        node["run_url"] = run_url  # artifact data never chooses its provenance link
        node = compact(node, asset_sha256=expected.get("asset_sha256") or None)
    if expected["kind"] == "release":
        if repository != OFFICIAL or resolve(OFFICIAL, ref) != commit:
            raise ValueError("formal release moved after selection")
        release = api("repos/" + OFFICIAL + "/releases/tags/" + urllib.parse.quote(ref, safe=""))
        if release.get("draft") or release.get("prerelease"):
            raise ValueError("only published stable releases may enter history")
        if node is not None:
            node["provenance"].update(release_provenance(release, expected))

    history_root = Path(os.environ["RUNNER_TEMP"]) / "pilot-performance-history"
    history_root.mkdir()
    token = os.environ["GH_TOKEN"]
    git_env = dict(os.environ)
    git_env.update({"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader",
                    "GIT_CONFIG_VALUE_0": "AUTHORIZATION: basic " + base64.b64encode(("x-access-token:" + token).encode()).decode()})

    def git(root, *arguments, check=True):
        result = subprocess.run(["git", "-C", str(root)] + list(arguments), env=git_env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if check and result.returncode:
            raise RuntimeError("git publication operation failed: " + result.stderr.decode(errors="replace")[-1200:])
        return result

    git(history_root, "init", "--quiet")
    git(history_root, "remote", "add", "origin", "https://github.com/" + OFFICIAL + ".git")
    git(history_root, "config", "user.name", "github-actions[bot]")
    git(history_root, "config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com")
    verified = {OFFICIAL}

    def ensure_public_commit(repo, sha):
        if not SHA.fullmatch(sha):
            raise ValueError("invalid public source object")
        if repo not in verified:
            public_repository(repo)
            verified.add(repo)
        if git(trusted, "cat-file", "-e", sha + "^{commit}", check=False).returncode:
            git(trusted, "fetch", "--no-prune", "--no-tags", "--refmap=", "https://github.com/" + repo + ".git", sha)

    changed = False
    published = False
    final_history = None
    ensure_public_commit(repository, commit)
    for attempt in range(8):
        branch_exists = True
        try:
            api("repos/" + OFFICIAL + "/git/ref/heads/sdk-performance-results")
        except urllib.error.HTTPError as error:
            if error.code != 404:
                raise
            branch_exists = False
        if branch_exists:
            git(history_root, "fetch", "--no-prune", "--no-tags", "--refmap=", "origin", "sdk-performance-results")
            git(history_root, "checkout", "-B", "sdk-performance-results", "FETCH_HEAD")
            tracked = git(history_root, "ls-files").stdout.decode().splitlines()
            if any(path not in RESULT_FILES for path in tracked):
                raise ValueError("results branch unexpectedly contains source or raw test files")
        elif not (history_root / ".git/HEAD").read_text().endswith("sdk-performance-results\n"):
            git(history_root, "checkout", "--orphan", "sdk-performance-results")
        history_path = history_root / "history.json"
        history = read_json(history_path) if history_path.exists() else {
            "schema": 1, "repository": OFFICIAL, "updated_at": None,
            "method": standard_method, "compatibility": None, "nodes": []}
        validate_history(history)
        migrated = retire_legacy_qoder(history, standard_method)
        if (history.get("method") or {}).get("id") != STANDARD_METHOD:
            raise ValueError("primary Qoder history has an unexpected method")
        # Check after EVERY fresh fetch. A configuration switch creates a new
        # results commit: an in-flight old branch either fails this gate, or its
        # ordinary push conflicts and the next CAS retry rejects it.
        if node and not target_dev_matches(history, node):
            print("::notice::Dev result retained as artifact only: its public source is not the current designated branch.")
            with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
                output.write("site_updated=false\n")
            return
        # Resolve on EVERY CAS retry, not just once before a slow publication.
        current_main = resolve(OFFICIAL, "main")
        ensure_public_commit(OFFICIAL, current_main)
        initial_main = ensure_main_slot(history, current_main, STANDARD_METHOD)
        try:
            current_dev = resolve(repository, ref) if expected["kind"] == "dev" else None
        except urllib.error.HTTPError as error:
            if error.code != 404:
                raise
            current_dev = ""  # deleted dev ref is stale, never publishable
        series = history if primary else history.get("other_methods", {}).get(method_id, {})
        series_nodes = series.get("nodes", [])
        for old in series_nodes:
            source = old.get("source") or {}
            if old.get("kind") in ("main", "dev") and source.get("repository"):
                ensure_public_commit(source["repository"], old["commit"])
        merged_dev = None
        dev = next((value for value in series_nodes if value["kind"] == "dev"), None)
        if node and node["kind"] == "main" and node["commit"] == current_main and dev:
            ensure_public_commit((dev.get("source") or {}).get("repository", OFFICIAL), dev["commit"])
            # Direct ancestry handles ordinary merges. Exact head + merged PR +
            # merge-commit-in-main additionally handles verified squash merges.
            if not contains(trusted, dev["commit"], current_main):
                try:
                    linked = api("repos/" + OFFICIAL + "/commits/" + dev["commit"] + "/pulls")
                except urllib.error.HTTPError as error:
                    if error.code != 404:
                        raise
                    linked = []
                for item in linked:
                    pull = api("repos/" + OFFICIAL + "/pulls/" + str(item["number"]))
                    merge_sha = pull.get("merge_commit_sha")
                    if pull.get("merged_at") and pull["head"]["sha"] == dev["commit"] and merge_sha:
                        ensure_public_commit(OFFICIAL, merge_sha)
                        if contains(trusted, merge_sha, current_main):
                            merged_dev = dev["commit"]
                            break
        changed = initial_main or migrated
        if node:
            changed = merge_method(history, method, node, current_main=current_main,
                                   current_dev=current_dev, source_repo=trusted,
                                   merged_dev=merged_dev, publication=publication) or changed
        if cutoff:
            changed = apply_cutoff(history, cutoff) or changed
        if changed and (primary or initial_main or migrated):
            history["method"] = standard_method
            history["updated_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
        encoded_html = render(template, history)
        history_path.write_text(json.dumps(history, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        (history_root / "index.html").write_text(encoded_html, encoding="utf-8")
        stage_site_workflow(history_root, trusted)
        git(history_root, "add", "--", "history.json", "index.html", ".nojekyll", SITE_WORKFLOW)
        if git(history_root, "diff", "--cached", "--quiet", check=False).returncode == 0:
            final_history = history
            break
        git(history_root, "commit", "--quiet", "-m", "Update Pilot performance history")
        if git(history_root, "push", "origin", "HEAD:refs/heads/sdk-performance-results", check=False).returncode == 0:
            final_history = history
            published = True
            break
        if attempt == 7:
            raise RuntimeError("publication CAS conflict budget exhausted; measurement artifact preserved")
        time.sleep(min(attempt + 1, 4))
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        output.write("site_updated=" + str(published).lower() + "\n")
    # A continuation always selects the next not-yet-passed release from CURRENT
    # history; release events remain independent and cannot be discarded by a
    # global concurrency slot. Infra/failure/cutoff never auto-retries forever.
    final_series = final_history if primary else final_history.get("other_methods", {}).get(method_id, {})
    accepted = node and any(old["id"] == node["id"] and old["commit"] == node["commit"] and old["status"] == "passed"
                            for old in final_series.get("nodes", []))
    if expected.get("mode") == "backfill" and node and node["status"] == "passed" and accepted and os.environ.get("CONTINUE_BACKFILL") == "true" and select_backfill(OFFICIAL, final_history, method_id):
        workflow_ref = os.environ["GITHUB_WORKFLOW_REF"].split("@", 1)[1]
        ref_name = workflow_ref[len("refs/heads/"):] if workflow_ref.startswith("refs/heads/") else workflow_ref
        body = json.dumps({"ref": ref_name, "inputs": {"mode": "backfill", "public_repository": OFFICIAL,
                           "public_ref": "main", "continue_backfill": "true", "benchmark_method": method_id}}).encode()
        request = urllib.request.Request("https://api.github.com/repos/" + OFFICIAL + "/actions/workflows/sdk-performance.yml/dispatches", data=body,
            headers={"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json", "Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=30):
                pass
        except urllib.error.HTTPError as error:
            if error.code not in (404, 422):
                raise
            print("::warning::Result saved, but continuation is not registered on GitHub yet; complete first-time workflow setup or dispatch backfill again. No history was discarded.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--history", type=Path, required=True)
    parser.add_argument("--node", type=Path)
    parser.add_argument("--cutoff", type=Path)
    parser.add_argument("--template", type=Path, required=True)
    parser.add_argument("--html", type=Path, required=True)
    parser.add_argument("--current-main")
    parser.add_argument("--current-dev")
    parser.add_argument("--source-repo", type=Path)
    parser.add_argument("--merged-dev", help="Exact dev SHA proved merged by trusted upstream PR metadata")
    parser.add_argument("--method", type=Path, required=True)
    parser.add_argument("--repository", default=OFFICIAL)
    parser.add_argument("--expected-repository")
    parser.add_argument("--expected-ref")
    parser.add_argument("--expected-commit")
    parser.add_argument("--expected-kind", choices=("release", "main", "dev"))
    parser.add_argument("--expected-version")
    parser.add_argument("--asset-sha256")
    parser.add_argument("--run-number", type=int)
    parser.add_argument("--run-id")
    parser.add_argument("--summary", type=Path)
    args = parser.parse_args()
    if not args.node and not args.cutoff:
        parser.error("provide a node or explicit confirmed cutoff")
    if args.repository != OFFICIAL:
        raise ValueError("this publisher writes only the official public report")
    method = read_json(args.method)
    history = read_json(args.history) if args.history.exists() else {
        "schema": 1, "repository": OFFICIAL, "updated_at": None, "method": method,
        "compatibility": None, "nodes": []}
    validate_history(history)
    if args.merged_dev and not SHA.fullmatch(args.merged_dev):
        raise ValueError("invalid merged-dev proof")
    publication = {"run_number": args.run_number, "run_id": args.run_id} if args.run_number else None
    primary_method = history.get("method") or method
    alternate = primary_method["id"] != method["id"]
    if alternate and args.cutoff:
        raise ValueError("compatibility cutoff requires the primary history method")
    initial_main = ensure_main_slot(history, args.current_main, primary_method["id"])
    changed = initial_main
    node = None
    if args.node:
        node = read_json(args.node)
        validate_node(node)
        source = node.get("source") or {}
        expected = (("kind", args.expected_kind), ("version", args.expected_version), ("commit", args.expected_commit))
        if any(value is not None and node.get(key) != value for key, value in expected):
            raise ValueError("measurement identity does not match the trusted selector")
        if args.expected_repository and source.get("repository") != args.expected_repository:
            raise ValueError("unexpected measured repository")
        if args.expected_ref and source.get("ref") != args.expected_ref:
            raise ValueError("unexpected measured ref")
        if node["method_id"] != method["id"]:
            raise ValueError("measurement method differs from the trusted method")
        node = compact(node, asset_sha256=args.asset_sha256)
        if alternate:
            changed = merge_method(history, method, node, current_main=args.current_main,
                                   current_dev=args.current_dev, source_repo=args.source_repo,
                                   merged_dev=args.merged_dev, publication=publication) or changed
        else:
            changed = merge(history, node, args.current_main, args.current_dev, args.source_repo,
                            args.merged_dev, publication) or changed
    if args.cutoff:
        changed = apply_cutoff(history, read_json(args.cutoff)) or changed
    if changed and (not alternate or initial_main):
        history["method"] = primary_method
        history["updated_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    # Generate the HTML before replacing either file, so invalid input/template
    # cannot leave a partial in-memory update committed by the publication job.
    html = render(args.template.read_text(encoding="utf-8"), history)
    if changed or not args.html.exists():
        encoded = json.dumps(history, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        args.history.parent.mkdir(parents=True, exist_ok=True)
        history_tmp = args.history.with_suffix(".json.tmp")
        html_tmp = args.html.with_suffix(".html.tmp")
        history_tmp.write_text(encoded, encoding="utf-8")
        html_tmp.write_text(html, encoding="utf-8")
        history_tmp.replace(args.history)
        html_tmp.replace(args.html)
    result = {"changed": changed, "node_kind": node["kind"] if node else None,
              "node_status": node["status"] if node else None,
              "cutoff_updated": bool(args.cutoff and changed)}
    if args.summary:
        args.summary.write_text(json.dumps(result) + "\n", encoding="utf-8")
    print(json.dumps(result))


if __name__ == "__main__":
    if sys.argv[1:] == ["--github-publish"]:
        github_publish()
    else:
        main()
