#!/usr/bin/env python3
"""Run a separate Codex rollout benchmark with the public Pilot sampler."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import subprocess
import sys
import time
import uuid

from codex_rollout_fixture import CodexRolloutFixture, validate_output
from pilot_history import (
    DRAIN_SECONDS, LOADS, SAMPLE_INTERVAL, WINDOW_SECONDS, Output, command, configure, docker_json,
    file_sha, locate_cgroup, mapped_library, monotonic_ns, resources, stop_container,
    standard_resource_sampling, summarize_workload, write_json,
)
from prepare_public import CODEX_STANDARD_METHOD
from publish_history import compact
from runtime_layout import resolve


SESSIONS = 64
TERMINAL_STATUS = "gen_ai.turn.end"


def configure_codex(fixture, output):
    configure(fixture, output)
    path = fixture.data / "config.json"
    value = json.loads(path.read_text(encoding="utf-8"))
    value["listeners"]["qoder-trace"]["enabled"] = False
    value["listeners"]["codex-transcript"] = {"enabled": True}
    value.pop("agents", None)
    write_json(path, value)


def await_input(fixture, container, deadline):
    input_started = False
    collector_running = False
    while time.monotonic() < deadline:
        for path in (fixture.data / "logs").glob("*.log*"):
            try:
                with path.open(encoding="utf-8") as stream:
                    for line in stream:
                        try:
                            event = json.loads(line)
                        except ValueError:
                            continue
                        if not isinstance(event, dict):
                            continue
                        if event.get("msg") == "input started" and event.get("id") == "codex-transcript":
                            input_started = True
                        if event.get("msg") == "AI Agent Input is running" and event.get("tag") == "Main":
                            collector_running = True
            except FileNotFoundError:
                continue
        if input_started and collector_running:
            return
        if not docker_json("/containers/%s/json" % container)["State"]["Running"]:
            raise RuntimeError("Pilot exited before the Codex input was ready")
        time.sleep(.1)
    raise RuntimeError("Codex input did not become ready within the warmup window")


def await_turns(output, first_record, expected_turns, deadline, sample=None, allow_capacity=False):
    """A completion marker alone does not bypass strict row/token validation."""
    seen = set()
    offset = first_record
    while True:
        output.read()
        for _, row in output.records[offset:]:
            if row.get(TERMINAL_STATUS) is True:
                seen.add(row.get("gen_ai.turn.id"))
        offset = len(output.records)
        pending = expected_turns - seen
        if not pending:
            return False
        if time.monotonic() >= deadline:
            if allow_capacity:
                return True
            raise ValueError("missing terminal delivery for %d of %d Codex turns" %
                             (len(pending), len(expected_turns)))
        if sample:
            sample()
        time.sleep(.1)


def normalized_turn(turn):
    return "%s:%s" % (turn["session"], turn["turn"])


def quality_for(records, expected, produced_at):
    quality = validate_output((row for _, row in records), expected) if expected else {"turns": 0}
    terminal_steps = {turn["steps"][-1]["id"]: normalized_turn(turn) for turn in expected}
    latencies = []
    for observed_at, row in records:
        turn = terminal_steps.get(row.get("gen_ai.step.id"))
        if turn is not None and turn in produced_at and row.get("event.name") == "llm.response":
            latency = (observed_at - produced_at[turn]) / 1e6
            if latency < 0 or not math.isfinite(latency):
                raise ValueError("invalid Codex publication latency")
            latencies.append(latency)
    if len(latencies) != len(produced_at):
        raise ValueError("missing final response latency")
    return dict(quality, passed=True, missing=0, duplicates=0,
                p95_ms=sorted(latencies)[math.ceil(.95 * len(latencies)) - 1] if latencies else None)


def capacity_result(fixture, records, deadline_records, warm_count, repeat):
    """Require a valid deadline prefix, and prove missing suffix bytes or late delivery."""
    expected = fixture.expected
    early = validate_output((row for _, row in records[:deadline_records]), expected, warm_count)
    final = validate_output((row for _, row in records), expected, warm_count)
    if not early["pending"]:
        raise ValueError("Codex capacity requires an incomplete delivery at the drain deadline")
    first_pending = {}
    for turn in final["pending"]:
        first_pending.setdefault(turn["session"], turn["end_offset"])
    unread = 0
    if first_pending:
        complete_offsets = {}
        pending_ids = {normalized_turn(turn) for turn in final["pending"]}
        for turn in expected:
            if normalized_turn(turn) not in pending_ids:
                complete_offsets[turn["session"]] = turn["end_offset"]
        checkpoint = json.loads((fixture.data / "logs/input-state.json").read_text(encoding="utf-8"))
        for session, path, _ in fixture.sessions:
            if session not in first_pending:
                continue
            source = path.stat()
            key = "codex-transcript:" + fixture.container_path(path)
            position = checkpoint.get(key, {}).get("extra", {}).get("codexTranscript", {})
            offset = position.get("scanOffset")
            if (position.get("inode") != source.st_ino or type(offset) is not int
                    or not complete_offsets[session] <= offset < first_pending[session] <= source.st_size):
                raise ValueError("Codex missing delivery without unread source bytes")
            unread += source.st_size - offset
    pending = len(early["pending"])
    missing = early["missing_responses"]
    quality = {"passed": False, "validated_prefix": True, "missing": missing + pending,
               "duplicates": 0, "turns": early["turns"], "p95_ms": None}
    capacity = {"repeat": repeat, "produced_turns": len(expected) - warm_count,
                "completed_turns": early["turns"], "missing_responses": missing,
                "backlog": {"pending_turns": pending, "late_turns": pending - len(final["pending"]),
                            "unread_bytes": unread}}
    return quality, capacity


def run_round(args, directory, load, repeat, smoke=False):
    directory.mkdir()
    fixture = CodexRolloutFixture(directory, sessions=SESSIONS)
    output = Output(directory / "output")
    configure_codex(fixture, output.directory)
    name = "pilot-codex-perf-" + uuid.uuid4().hex
    launch = ["docker", "run", "-d", "--pull=never", "--name", name, "--network", "none",
              "--cpus", "2", "--memory", "1g", "--memory-swap", "1g", "--pids-limit", "256",
              "--user", "%s:%s" % (os.getuid(), os.getgid()),
              "--mount", "type=bind,source=%s,target=/bench" % directory,
              "--mount", "type=bind,source=%s,target=/opt/pilot,readonly" % args.package,
              "-e", "HOME=/bench/home", "-e", "USERPROFILE=/bench/home",
              "-e", "CODEX_HOME=/bench/home/.codex", "-e", "LOONGSUITE_PILOT_DATA_DIR=/bench/home/.loongsuite-pilot",
              "-e", "AGENT_DATA_COLLECTION_CONFIG=/bench/home/.loongsuite-pilot/config.json",
              "-e", "LOONGSUITE_PILOT_RESOURCE_ROOT=/opt/pilot",
              "-e", "LOONGSUITE_PILOT_POLL_INTERVAL_MS=",
              args.image, "/opt/pilot/" + args.layout["entry"]]
    try:
        container = command(launch).strip()
        pid = docker_json("/containers/%s/json" % container)["State"]["Pid"]
        cgroup = locate_cgroup(pid)
        library = args.package / args.layout["library"]
        until = time.monotonic() + 10
        while not mapped_library(pid, library):
            if time.monotonic() >= until:
                raise RuntimeError("native host did not map the exact adjacent SDK")
            time.sleep(.05)

        deadline = time.monotonic() + 25
        await_input(fixture, container, deadline)
        warm_turns = [fixture.append_turn(session) for session in range(SESSIONS)]
        write_json(directory / "expected.json", warm_turns)
        await_turns(output, 0, {normalized_turn(turn) for turn in warm_turns}, deadline)
        validate_output((row for _, row in output.records), warm_turns)
        if smoke:
            observation = resources(container, cgroup, cpu=True, direct_cpu=True)
            stop_container(container)
            output.read(final=True)
            quality = quality_for(output.records, warm_turns, {})
            return {"status": "passed", "smoke_only": True, "report_node": False,
                    "quality": quality, "cgroup_version": cgroup["version"], "resources": observation,
                    "raw_bytes": fixture.raw_bytes}

        time.sleep(1)
        warm_record_count = len(output.records)
        warm_bytes = fixture.raw_bytes
        rate = LOADS[load]
        first = resources(container, cgroup, cpu=True, direct_cpu=True)
        samples = [first]
        start = time.monotonic()
        next_sample = start + SAMPLE_INTERVAL
        produced_at = {}
        produced = 0
        while time.monotonic() < start + WINDOW_SECONDS:
            now = time.monotonic()
            due = min(int((now - start) * rate) + 1, rate * WINDOW_SECONDS) if rate else 0
            while produced < due:
                stamp = monotonic_ns()
                turn = fixture.append_turn(produced % SESSIONS)
                produced_at[normalized_turn(turn)] = stamp
                produced += 1
            if now >= next_sample:
                samples.append(resources(container, cgroup, cpu=True, direct_cpu=True))
                output.read()
                next_sample = now + SAMPLE_INTERVAL
            time.sleep(.001 if rate else .02)
        active_end = resources(container, cgroup, cpu=True, direct_cpu=True)
        samples.append(active_end)
        active_resources = standard_resource_sampling(samples)
        if produced != rate * WINDOW_SECONDS:
            raise RuntimeError("producer could not maintain the fixed rate")

        write_json(directory / "expected.json", fixture.expected)
        exceeded = await_turns(output, warm_record_count, set(produced_at), time.monotonic() + DRAIN_SECONDS,
                               lambda: samples.append(resources(container, cgroup, cpu=True, direct_cpu=True)),
                               allow_capacity=load == "high")
        deadline_records = len(output.records)
        if exceeded:
            state = docker_json("/containers/%s/json" % container)["State"]
            if not state.get("Running") or state.get("OOMKilled"):
                raise RuntimeError("Codex container exited before the high-load drain")
        samples.append(resources(container, cgroup, cpu=True, direct_cpu=True))
        stop_container(container)
        output.read(final=True)
        capacity = None
        if exceeded:
            quality, capacity = capacity_result(fixture, output.records, deadline_records, len(warm_turns), repeat)
        else:
            quality = quality_for(output.records, fixture.expected, produced_at)
        write_json(directory / "resource-samples.json", samples)
        wall = (active_end["at_ns"] - first["at_ns"]) / 1e9
        cpu = (active_end["cpu_ns"] - first["cpu_ns"]) / 1e9
        if wall <= 0 or cpu < 0 or not math.isfinite(cpu / wall):
            raise RuntimeError("invalid CPU sample interval")
        result = {"load": load, "repeat": repeat, "cpu_percent": cpu / wall * 100,
                  "cgroup_version": cgroup["version"], "quality": quality, "produced_turns": produced,
                  "raw_bytes": fixture.raw_bytes - warm_bytes, **active_resources}
        if capacity is not None:
            result["capacity"] = capacity
        return result
    finally:
        try:
            with (directory / "collector.log").open("wb") as log:
                subprocess.run(["docker", "logs", name], stdout=log, stderr=subprocess.STDOUT, timeout=10)
        except (OSError, subprocess.SubprocessError) as error:
            (directory / "collector-log-error.txt").write_text(str(error), encoding="utf-8")
        finally:
            subprocess.run(["docker", "rm", "-f", name], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)


def make_node(args):
    version = args.version if args.kind == "release" else args.kind
    cpu = next((line.partition(":")[2].strip() for line in Path("/proc/cpuinfo").read_text().splitlines()
                if line.startswith("model name")), platform.machine())
    runner_image = os.environ.get("ImageOS")
    runner_version = os.environ.get("ImageVersion")
    run_id = os.environ.get("GITHUB_RUN_ID", "")
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    env = {
        "cpu_model": cpu, "runner_os": platform.system(),
        "runner_image": "%s/%s" % (runner_image, runner_version) if runner_image and runner_version else platform.release(),
        "kernel": platform.release(), "architecture": platform.machine(), "cpus": os.cpu_count(),
        "container_digest": json.loads(command(["docker", "image", "inspect", args.image]))[0]["Id"],
    }
    return {
        "id": "v" + version.lstrip("v") if args.kind == "release" else args.kind,
        "kind": args.kind, "version": version, "commit": args.commit,
        "recorded_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "status": "pending", "method_id": CODEX_STANDARD_METHOD, "environment": env, "environment_id": "pending",
        "source": {"repository": args.source_repository, "ref": args.source_ref},
        "run_url": "https://github.com/%s/actions/runs/%s" % (repository, run_id) if run_id.isdecimal() and repository else "",
        "workloads": {},
        "provenance": {
            "entry_sha256": file_sha(args.package / args.layout["entry"]),
            "library_sha256": file_sha(args.package / args.layout["library"]),
            "fixture_sha256": file_sha(Path(__file__).with_name("codex_rollout_fixture.py")),
            "compiler": os.environ.get("PILOT_BUILD_COMPILER"),
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", type=lambda value: Path(value).resolve(), required=True)
    parser.add_argument("--native-entry")
    parser.add_argument("--image", required=True, help="already present Docker image containing the OS runtime")
    parser.add_argument("--output", type=lambda value: Path(value).resolve(), required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--kind", choices=("release", "main", "dev"), default="dev")
    parser.add_argument("--version", default="2.0.0")
    parser.add_argument("--source-repository", default="alibaba/loongsuite-pilot")
    parser.add_argument("--source-ref", default="dev/v2.0.0")
    parser.add_argument("--smoke-only", action="store_true")
    args = parser.parse_args()
    args.output.mkdir()
    args.layout = resolve(args.package, "rust", args.native_entry)
    args.package = args.layout["package"]
    node = make_node(args)

    if args.smoke_only:
        try:
            smoke = run_round(args, args.output / "smoke", "idle", 0, smoke=True)
            write_json(args.output / "smoke.json", dict(smoke, provenance=node["provenance"]))
            return 0
        except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as error:
            write_json(args.output / "smoke.json", {"status": "failed", "reason": str(error),
                                                    "report_node": False, "provenance": node["provenance"]})
            raise
    rounds = []
    for repeat in range(1, 4):
        for load in LOADS:
            rounds.append(run_round(args, args.output / ("%s-%d" % (load, repeat)), load, repeat))
            write_json(args.output / "rounds.json", rounds)
    versions = {round_["cgroup_version"] for round_ in rounds}
    if len(versions) != 1:
        raise RuntimeError("cgroup version changed between rounds")
    node["environment"]["cgroup_version"] = versions.pop()
    encoded_env = json.dumps(node["environment"], sort_keys=True, separators=(",", ":")).encode()
    node["environment_id"] = hashlib.sha256(encoded_env).hexdigest()
    node["workloads"] = {load: summarize_workload([round_ for round_ in rounds if round_["load"] == load], load)
                         for load in LOADS}
    node["status"] = "passed"
    write_json(args.output / "node.json", compact(node))
    return 0


if __name__ == "__main__":
    sys.exit(main())
