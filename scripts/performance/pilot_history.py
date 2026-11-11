#!/usr/bin/env python3
"""Full public Pilot/native-Qoder benchmark. No SDK ABI/canonical injection.

Linux Docker + host Python stdlib. Container image/package are prepared before
measurement; no package/network installation occurs inside a measured round.
"""
import argparse
import collections
import datetime
import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import platform
import re
import shutil
import socket
import statistics
import subprocess
import sys
import time
import uuid

from native_qoder_fixture import Fixture, compact, monotonic_ns
from legacy_qoder_fixture import LegacyFixture
from prepare_public import QODER_FIXED_30S_DRAIN_SECONDS, QODER_FIXED_30S_METHOD, QODER_FIXED_30S_POLL_MS, QODER_MIXED_METHOD
from linux_cgroup import cpu_usage_ns, locate as locate_cgroup
from runtime_layout import resolve as resolve_layout

METHOD = "github-full-pilot-qoder-native-v1"
STANDARD_METHOD = "github-full-pilot-qoder-native-10s-v1"
LOADS = {"idle": 0, "low": 10, "high": 200}
WINDOW_SECONDS = 30
DRAIN_SECONDS = 15
SESSION_COUNT = 64
SAMPLE_INTERVAL = .1
LEGACY_POLL_MS = 100
STANDARD_POLL_MS = 10_000
COMMON = ("event.id", "time_unix_nano", "user.id", "gen_ai.agent.type", "gen_ai.session.id", "gen_ai.step.id")
REQUIRED = {
    "llm.request": COMMON + ("gen_ai.turn.id", "gen_ai.provider.name", "gen_ai.request.model", "gen_ai.input.messages_delta"),
    "llm.response": COMMON + ("gen_ai.turn.id", "gen_ai.response.id", "gen_ai.response.model", "gen_ai.response.finish_reasons", "gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens", "gen_ai.output.messages"),
    "tool.call": COMMON + ("gen_ai.tool.name", "gen_ai.tool.call.id", "gen_ai.tool.call.arguments"),
    "tool.result": COMMON + ("gen_ai.tool.name", "gen_ai.tool.call.id", "gen_ai.tool.call.result"),
}
EVENT_SHAPE = collections.Counter({"llm.request": 2, "llm.response": 2, "tool.call": 1, "tool.result": 1})
REQUEST_SOURCE = re.compile(r"\b(?:synthetic(?: result)? |ci-tool-)((?:warm|turn)-[0-9]+)\b")



class ProducerRateError(RuntimeError):
    def __init__(self, produced, expected):
        super().__init__("producer wrote %d of %d turns during the fixed window" % (produced, expected))


def run_round_with_retry(run, directory):
    for attempt in range(1, 4):
        try:
            return run(directory)
        except ProducerRateError as error:
            if attempt == 3:
                raise
            print("%s: %s; retrying on a fresh Pilot instance" % (directory.name, error),
                  file=sys.stderr, flush=True)
            directory.rename(directory.with_name("%s-producer-retry-%d" % (directory.name, attempt)))

def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def file_sha(path):
    value = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def command(arguments, timeout=30):
    return subprocess.run(arguments, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          universal_newlines=True, timeout=timeout).stdout


class DockerHTTP(http.client.HTTPConnection):
    def __init__(self):
        super().__init__("localhost", timeout=5)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect("/var/run/docker.sock")


def docker_json(path):
    connection = DockerHTTP()
    try:
        connection.request("GET", path)
        response = connection.getresponse()
        data = response.read(4 * 1024 * 1024)
        if response.status != 200:
            raise RuntimeError("Docker API failed: %s" % response.status)
        return json.loads(data)
    finally:
        connection.close()


def resources(container, cgroup, cpu=False, direct_cpu=False):
    # Old Docker can wait a full stats interval even with one-shot=true. Do not
    # put that API call into the 100ms RSS/producer loop. CPU is cumulative and
    # is requested only at interval boundaries on either cgroup version.
    cpu_ns = None
    cpu_at = None
    if cpu:
        if direct_cpu:
            cpu_ns = cpu_usage_ns(cgroup)
            cpu_at = monotonic_ns()
        else:
            stats = docker_json("/containers/%s/stats?stream=false&one-shot=true" % container)
            cpu_ns = stats["cpu_stats"]["cpu_usage"]["total_usage"]
    pids = [int(value) for value in cgroup["processes"].read_text().split()]
    memory = 0
    for pid in pids:
        try:
            for line in Path("/proc/%d/status" % pid).read_text().splitlines():
                if line.startswith("VmRSS:"):
                    memory += int(line.split()[1]) * 1024
                    break
        except (FileNotFoundError, ProcessLookupError):
            pass  # an owned short-lived process ended during this sample
    if not pids or memory <= 0:
        raise RuntimeError("actual process RSS unavailable")
    usage = cgroup["memory_usage"]
    return {"at_ns": cpu_at if cpu_at is not None else monotonic_ns(), "cpu_ns": cpu_ns,
            "rss_bytes": memory, "processes": len(pids),
            "cgroup_memory_bytes": int(usage.read_text()) if usage and usage.exists() else None}


def mapped_library(pid, library):
    expected = Path(library).stat()
    matches = []
    for line in Path("/proc/%s/maps" % pid).read_text().splitlines():
        fields = line.split(None, 5)
        if len(fields) < 5:
            continue
        major, minor = (int(value, 16) for value in fields[3].split(":"))
        if (major, minor, int(fields[4])) == (os.major(expected.st_dev), os.minor(expected.st_dev), expected.st_ino):
            matches.append({"range": fields[0], "permissions": fields[1], "offset": fields[2]})
    return matches


def stop_container(container):
    command(["docker", "stop", "--time", "20", container], timeout=25)
    stopped = docker_json("/containers/%s/json" % container)
    if stopped["State"].get("OOMKilled") or stopped["State"]["ExitCode"] != 0:
        raise RuntimeError("infrastructure: complete Pilot did not stop cleanly")


class Output:
    def __init__(self, directory):
        self.directory, self.offsets, self.records = Path(directory), {}, []
        self.responses = set()

    def bytes_written(self):
        sizes = {}
        for path in self.directory.glob("*.jsonl"):
            try:
                identity = path.stat()
            except FileNotFoundError:
                continue  # a concurrent rename will be counted at its destination
            sizes[(identity.st_dev, identity.st_ino)] = identity.st_size
        return sum(sizes.values())

    def read(self, final=False):
        for path in sorted(self.directory.glob("*.jsonl")):
            try:
                opened = path.open("rb")
            except FileNotFoundError:
                continue  # rotation renamed it; the next scan opens its inode
            with opened as stream:
                identity = os.fstat(stream.fileno())
                key = (identity.st_dev, identity.st_ino)
                offset = self.offsets.get(key, 0)
                if identity.st_size < offset:
                    raise RuntimeError("output truncated during measurement")
                stream.seek(offset)
                while True:
                    line = stream.readline()
                    if not line:
                        break
                    if not line.endswith(b"\n"):
                        if final:
                            raise ValueError("unterminated output JSONL record")
                        break
                    value = json.loads(line)
                    if not isinstance(value, dict):
                        raise ValueError("output JSONL record must be an object")
                    self.records.append((monotonic_ns(), value))
                    if value.get("event.name") == "llm.response" and isinstance(value.get("gen_ai.response.id"), str):
                        self.responses.add(value["gen_ai.response.id"])
                    offset = stream.tell()
            self.offsets[key] = offset
        return self.records


def response_catalog(expected):
    return {response: (identifier, metadata) for identifier, metadata in expected.items()
            for response in metadata["response_ids"]}


def validate_event(row, metadata):
    kind = row["event.name"]
    if row.get("gen_ai.session.id") != metadata["session"]:
        raise ValueError("native session identity mismatch")
    if row.get("gen_ai.agent.type") != "qoder-cli":
        raise ValueError("raw CLI transcript did not retain its qoder-cli label")
    for name in REQUIRED[kind]:
        value = row.get(name)
        if value is None or value == "" or value == "null" or value == []:
            raise ValueError("missing required native field: " + name)
        if name == "time_unix_nano" and int(value) <= 0:
            raise ValueError("invalid event timestamp")
    if kind.startswith("tool.") and row["gen_ai.tool.call.id"] != metadata["tool_id"]:
        raise ValueError("tool linkage mismatch")
    if kind == "llm.response" and (
            row["gen_ai.usage.input_tokens"] != metadata["input_tokens"]
            or row["gen_ai.usage.output_tokens"] != metadata["output_tokens"]):
        raise ValueError("exact native token enrichment failed")


def validate(records, expected):
    catalog = response_catalog(expected)
    known = {}
    turns = {}
    for observed, record in records:
        response = record.get("gen_ai.response.id")
        if record.get("event.name") == "llm.response" and response in catalog:
            if response in known:
                raise ValueError("duplicate expected response identity")
            known[response] = (observed, record)
            turns[record.get("gen_ai.turn.id")] = catalog[response][0]
    missing = len(set(catalog) - set(known))
    if missing:
        raise ValueError("missing expected native responses: %s" % missing)
    relevant = [(stamp, row) for stamp, row in records if row.get("gen_ai.turn.id") in turns]
    ids = [row.get("event.id") for _, row in relevant]
    duplicates = len(ids) - len(set(ids))
    if duplicates or any(not isinstance(value, str) or not value for value in ids):
        raise ValueError("missing or duplicate event.id")
    counts = collections.defaultdict(collections.Counter)
    fields = {kind: collections.Counter() for kind in REQUIRED}
    for _, row in relevant:
        kind = row.get("event.name")
        if kind not in REQUIRED:
            continue
        identifier = turns[row["gen_ai.turn.id"]]
        metadata = expected[identifier]
        counts[identifier][kind] += 1
        validate_event(row, metadata)
        for name in REQUIRED[kind]:
            fields[kind][name] += 1
    for identifier in expected:
        if counts[identifier] != EVENT_SHAPE:
            raise ValueError("fixed public native event cardinality failed: %s" % identifier)
    latencies = []
    for response, (identifier, metadata) in catalog.items():
        observed, row = known[response]
        if response.endswith("-final"):
            latency = (observed - metadata["published_monotonic_ns"]) / 1e6
            if latency < 0 or not math.isfinite(latency):
                raise ValueError("invalid publication latency")
            latencies.append(latency)
    return {"passed": True, "missing": 0, "duplicates": 0,
            "required_field_counts": fields, "turns": len(expected),
            "p95_ms": sorted(latencies)[math.ceil(.95 * len(latencies)) - 1] if latencies else None}


def validate_delivered_prefix(records, warm, expected):
    """Accept only an intact prefix per source when the high-load drain expires."""
    all_expected = dict(warm, **expected)
    responses = response_catalog(all_expected)
    tools = {metadata["tool_id"]: identifier for identifier, metadata in all_expected.items()}
    turns, source_turns, seen_responses, seen_events = {}, {}, set(), set()
    core = [row for _, row in records if row.get("event.name") in REQUIRED]

    def bind(turn, identifier):
        if (turns.setdefault(turn, identifier) != identifier
                or source_turns.setdefault(identifier, turn) != turn):
            raise ValueError("conflicting native turn identity")

    for row in core:
        event_id, turn = row.get("event.id"), row.get("gen_ai.turn.id")
        if not all(isinstance(value, str) and value and value != "null" for value in (event_id, turn)):
            raise ValueError("missing event.id or turn.id in delivered prefix")
        if event_id in seen_events:
            raise ValueError("duplicate event.id in delivered prefix")
        seen_events.add(event_id)
        kind = row["event.name"]
        if kind == "llm.response":
            response = row.get("gen_ai.response.id")
            if response not in responses or response in seen_responses:
                raise ValueError("unknown or duplicate native response identity")
            seen_responses.add(response)
            bind(turn, responses[response][0])
        elif kind.startswith("tool."):
            tool = row.get("gen_ai.tool.call.id")
            if tool not in tools:
                raise ValueError("unknown native tool identity")
            bind(turn, tools[tool])

    counts = collections.defaultdict(collections.Counter)
    for row in core:
        turn = row["gen_ai.turn.id"]
        if turn not in turns:
            # A request can be the only event from the final in-flight turn.
            # Recover its fixture identity from the raw prompt/tool marker.
            identifiers = set(REQUEST_SOURCE.findall(compact(row.get("gen_ai.input.messages_delta"))))
            if len(identifiers) != 1 or not identifiers.issubset(all_expected):
                raise ValueError("cannot attribute delivered native request")
            bind(turn, next(iter(identifiers)))
        identifier = turns[turn]
        validate_event(row, all_expected[identifier])
        kind = row["event.name"]
        counts[identifier][kind] += 1
        if counts[identifier][kind] > EVENT_SHAPE[kind]:
            raise ValueError("extra native events in delivered prefix")

    incomplete_sources, completed = set(), 0
    for identifier, metadata in all_expected.items():
        observed = counts[identifier]
        session = metadata["session"]
        complete = observed == EVENT_SHAPE
        terminal = metadata["response_ids"][-1] in seen_responses
        if (identifier in warm or terminal) and not complete:
            raise ValueError("incomplete delivered native turn: " + identifier)
        if observed and session in incomplete_sources:
            raise ValueError("gap in delivered native source prefix: " + identifier)
        if complete and identifier in expected:
            completed += 1
        if not complete:
            incomplete_sources.add(session)

    missing = len(set(response_catalog(expected)) - seen_responses)
    return {"passed": missing == 0, "missing": missing, "duplicates": 0,
            "validated_prefix": True, "turns": completed, "p95_ms": None}


def capacity_backlog(fixture, legacy, expected_turns):
    if legacy:
        status = fixture.check()
        if not status or status["queued"] != expected_turns:
            raise RuntimeError("legacy Stop queue did not receive every trigger")
        backlog = {key: status[key] for key in ("queued", "started", "completed", "active", "pending")}
        if (backlog["queued"] != backlog["started"] + backlog["pending"]
                or backlog["started"] != backlog["completed"] + backlog["active"]
                or backlog["pending"] + backlog["active"] <= 0):
            raise RuntimeError("legacy Stop drain timeout has no consistent backlog")
        return backlog
    pending = sum(1 for _ in fixture.sources.glob("*/events/*.json"))
    if not pending:
        raise RuntimeError("native drain timeout has no pending source notices")
    return {"pending_notices": pending}


def configure(fixture, output, poll_ms=LEGACY_POLL_MS):
    # Only synthetic HOME/.qoder exists; real Agents/services are never installed.
    listeners = {name: {"enabled": False} for name in (
        "qoder", "qoder-work", "qoder-work-log", "qoder-work-sqlite", "qoder-work-cn-trace",
        "qoder-work-cn-hook", "qoder-work-cn-log", "qoder-work-cn-sqlite", "qwen-work-cn-trace",
        "qwen-work-cn-hook", "qwen-work-cn-sqlite", "cursor-hook", "claude-code-log", "grok-build-log",
        "codex-transcript", "copilot-log", "opencode-log", "pi-coding-agent-log", "workbuddy", "doubao-work", "hermes-agent-log")}
    listeners["qoder-trace"] = {"enabled": True, "pollInterval": poll_ms}
    config = {"enabled": True, "dataDir": "/bench/home/.loongsuite-pilot", "userId": "ci-native-benchmark",
              "collectLog": False, "collectTrace": False, "listeners": listeners,
              "jsonl": {"enabled": True, "outputDir": "/bench/output", "rotateDaily": False, "maxFileSizeMb": 100},
              "dashboard": {"enabled": False}, "statusBar": {"enabled": False}, "autoUpdate": {"enabled": False},
              "interceptor": {"mode": "none"}, "agents": {"qoder": {"captureMessageContent": True,
                  "multimodal": {"enabled": False}}}}
    output.mkdir()
    write_json(fixture.data / "config.json", config)


def wait_for_legacy_input(fixture, deadline):
    while True:
        for path in (fixture.data / "logs").glob("loongsuite-pilot-service.log*"):
            try:
                with path.open(encoding="utf-8") as log:
                    for line in log:
                        try:
                            event = json.loads(line)
                        except ValueError:
                            continue
                        if (isinstance(event, dict) and event.get("id") == "qoder-trace"
                                and event.get("msg") == "input started"):
                            return
            except FileNotFoundError:
                continue
        if time.monotonic() >= deadline:
            raise RuntimeError("legacy qoder-trace input did not become ready before warmup")
        time.sleep(.05)


def run_round(args, directory, load, rate, repeat, smoke=False):
    directory.mkdir(parents=True)
    legacy = args.layout.get("collection") == "legacy-stop"
    fixed_cadence = args.benchmark_method == QODER_FIXED_30S_METHOD
    if fixed_cadence and (args.runtime != "js" or not legacy):
        raise RuntimeError("fixed 30s Qoder measurement requires the shipped legacy Stop Hook")
    measured_throughput = args.benchmark_method in (QODER_MIXED_METHOD, QODER_FIXED_30S_METHOD)
    standard = measured_throughput or args.benchmark_method == STANDARD_METHOD
    poll_ms = LEGACY_POLL_MS if not standard or (measured_throughput and load == "high") else STANDARD_POLL_MS
    if fixed_cadence:
        poll_ms = QODER_FIXED_30S_POLL_MS
    warm_seconds = QODER_FIXED_30S_DRAIN_SECONDS if fixed_cadence else 25
    drain_seconds = QODER_FIXED_30S_DRAIN_SECONDS if fixed_cadence else DRAIN_SECONDS
    fixture = (LegacyFixture if legacy else Fixture)(directory, sessions=SESSION_COUNT)
    output = Output(directory / "output")
    configure(fixture, output.directory, poll_ms)
    if legacy:
        shutil.copytree(str(args.package / "assets/hooks"), str(fixture.data / "hooks"))
    name = "pilot-native-perf-" + uuid.uuid4().hex
    entry = (["node"] if args.runtime == "js" else []) + ["/opt/pilot/" + args.layout["entry"]]
    launch = ["docker", "run", "-d", "--name", name, "--network", "none", "--cpus", "2", "--memory", "1g",
              "--memory-swap", "1g", "--pids-limit", "256", "--user", "%s:%s" % (os.getuid(), os.getgid()),
              "--mount", "type=bind,source=%s,target=/bench" % directory,
              "--mount", "type=bind,source=%s,target=/opt/pilot,readonly" % args.package,
              "-e", "HOME=/bench/home", "-e", "USERPROFILE=/bench/home", "-e", "LOONGSUITE_PILOT_DATA_DIR=/bench/home/.loongsuite-pilot",
              "-e", "AGENT_DATA_COLLECTION_CONFIG=/bench/home/.loongsuite-pilot/config.json",
              "-e", "LOONGSUITE_PILOT_RESOURCE_ROOT=/opt/pilot", args.image] + entry
    if legacy:
        launch.insert(3, "--init")
    samples, late, container = [], [], None
    try:
        container = command(launch).strip()
        info = docker_json("/containers/%s/json" % container)
        pid = info["State"]["Pid"]
        cgroup = locate_cgroup(pid)
        if args.runtime == "rust":
            library = args.package / args.layout["library"]
            mapping = mapped_library(pid, library)
            until = time.monotonic() + 10
            while not mapping and time.monotonic() < until:
                time.sleep(.05); mapping = mapped_library(pid, library)
            if not mapping:
                raise RuntimeError("infrastructure: native shell did not map the exact staged SDK inode")
            write_json(directory / "mapped-sdk.json", {"sha256": file_sha(library), "mappings": mapping})
        warm_deadline = time.monotonic() + warm_seconds
        if legacy:
            wait_for_legacy_input(fixture, warm_deadline)
            fixture.start(container)
        # One warm turn per source makes all64 native sessions active before idle.
        warm = {}
        for session in range(SESSION_COUNT):
            identifier = "warm-%02d" % session
            fixture.append_turn(session, identifier, True)
        warm.update(fixture.expected)
        deadline = warm_deadline if legacy else time.monotonic() + warm_seconds
        warm_responses = set(response_catalog(warm))
        while True:
            if legacy:
                fixture.check()
            output.read()
            if warm_responses.issubset(output.responses):
                break
            if time.monotonic() > deadline:
                raise RuntimeError("public full-runtime native smoke did not deliver all64 sources")
            time.sleep(.1)
        if legacy:
            fixture.drain(timeout=max(0, deadline - time.monotonic()))
        validate(output.records, warm)
        if smoke:
            observation = resources(container, cgroup, cpu=True, direct_cpu=standard)
            if legacy:
                fixture.finish(timeout=15)
            stop_container(container)
            output.read(final=True)
            quality = validate(output.records, warm)
            write_json(directory / "expected.json", warm)
            return {"status": "passed", "smoke_only": True, "report_node": False,
                    "quality": quality, "cgroup_version": cgroup["version"], "resources": observation}
        fixture.expected.clear()
        time.sleep(1)
        first = resources(container, cgroup, cpu=True, direct_cpu=standard)
        samples.append(first)
        raw_start = fixture.raw_bytes
        output_start = output.bytes_written() if measured_throughput else 0
        start = time.monotonic(); end = start + WINDOW_SECONDS
        produced, next_sample = 0, start + SAMPLE_INTERVAL if standard else start
        while time.monotonic() < end:
            if legacy:
                fixture.check()
            now = time.monotonic()
            due = min(int((now - start) * rate) + 1, rate * WINDOW_SECONDS) if rate else 0
            while produced < due:
                late.append(max(0, time.monotonic() - (start + produced / rate)) * 1000)
                fixture.append_turn(produced % SESSION_COUNT, "turn-%06d" % produced)
                produced += 1
            if now >= next_sample:
                samples.append(resources(container, cgroup, cpu=standard, direct_cpu=standard))
                output.read()
                next_sample = now + SAMPLE_INTERVAL
            time.sleep(.001 if rate else .02)
        output_end = output.bytes_written() if measured_throughput else 0
        active_end = resources(container, cgroup, cpu=True, direct_cpu=standard)
        samples.append(active_end)
        active_sampling = standard_resource_sampling(samples) if standard else {}
        if produced != rate * WINDOW_SECONDS:
            raise ProducerRateError(produced, rate * WINDOW_SECONDS)
        if len(fixture.expected) != produced:
            raise RuntimeError("producer catalog does not match the written turns")
        deadline = time.monotonic() + drain_seconds
        catalog = set(response_catalog(fixture.expected))
        capacity = None
        while True:
            if legacy:
                fixture.check()
            output.read()
            if catalog.issubset(output.responses):
                break
            if time.monotonic() > deadline:
                if load != "high":
                    raise RuntimeError("native input failed to drain")
                state = docker_json("/containers/%s/json" % container)["State"]
                if not state.get("Running") or state.get("OOMKilled"):
                    raise RuntimeError("container exited before the high-load drain")
                quality = validate_delivered_prefix(output.records, warm, fixture.expected)
                if not 0 <= quality["turns"] < produced or not quality["missing"]:
                    raise RuntimeError("high-load drain requires incomplete delivery")
                capacity = {"repeat": repeat, "produced_turns": produced,
                            "completed_turns": quality["turns"], "missing_responses": quality["missing"],
                            "backlog": capacity_backlog(fixture, legacy, len(warm) + produced)}
                break
            samples.append(resources(container, cgroup, cpu=standard, direct_cpu=standard))
            time.sleep(SAMPLE_INTERVAL)
        if legacy and capacity is None:
            fixture.finish(timeout=max(0, deadline - time.monotonic()))
        drained = resources(container, cgroup, cpu=True, direct_cpu=standard)
        samples.append(drained)
        peak_file = cgroup["memory_peak"]
        cgroup_peak = int(peak_file.read_text()) if peak_file and peak_file.exists() else None
        if legacy and capacity:
            fixture.close()
        stop_container(container)
        output.read(final=True)
        if capacity:
            validate_delivered_prefix(output.records, warm, fixture.expected)
        else:
            validate(output.records, dict(warm, **fixture.expected))
            quality = validate(output.records, fixture.expected)
        write_json(directory / "expected.json", fixture.expected)
        write_json(directory / "resource-samples.json", samples)
        active_wall = (active_end["at_ns"] - first["at_ns"]) / 1e9
        cpu = (active_end["cpu_ns"] - first["cpu_ns"]) / 1e9
        if active_wall <= 0 or cpu < 0 or not math.isfinite(cpu / active_wall):
            raise RuntimeError("invalid measured CPU interval")
        result = {"load": load, "repeat": repeat, "cpu_percent": cpu / active_wall * 100,
                "rss_mib": max(value["rss_bytes"] for value in samples) / 1048576,
                "active_cpu_seconds": cpu, "active_wall_seconds": active_wall,
                "through_drain_cpu_seconds": (drained["cpu_ns"] - first["cpu_ns"]) / 1e9,
                "cgroup_memory_peak_bytes": cgroup_peak,
                "cgroup_version": cgroup["version"],
                "produced_turns": produced, "producer_max_lateness_ms": max(late) if late else None,
                "quality": quality}
        if capacity:
            result["capacity"] = capacity
        if standard:
            result.update(active_sampling, prewarmed_sessions=len(warm))
        if measured_throughput:
            result.update(throughput(fixture.raw_bytes - raw_start, output_end - output_start,
                                     active_wall, poll_ms))
        return result
    finally:
        if legacy:
            fixture.close()
        if container:
            try:
                with (directory / "collector.log").open("wb") as log:
                    subprocess.run(["docker", "logs", container], stdout=log, stderr=subprocess.STDOUT, timeout=15)
            except Exception as error:
                (directory / "collector-log-error.txt").write_text(str(error), encoding="utf-8")
            subprocess.run(["docker", "rm", "-f", container], stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def summary(values):
    return {"median": statistics.median(values), "min": min(values), "max": max(values)}


def standard_resource_sampling(samples):
    if len(samples) < 3 or any(type(sample["cpu_ns"]) is not int
                               or type(sample["rss_bytes"]) is not int
                               or sample["rss_bytes"] <= 0 for sample in samples):
        raise RuntimeError("infrastructure: standard benchmark resource sample series is incomplete")
    intervals = []
    usage = []
    rss_bytes_twice = 0
    for before, after in zip(samples, samples[1:]):
        wall = after["at_ns"] - before["at_ns"]
        cpu = after["cpu_ns"] - before["cpu_ns"]
        if wall <= 0 or cpu < 0:
            raise RuntimeError("infrastructure: standard benchmark CPU samples are not monotonic")
        intervals.append(wall)
        usage.append(cpu * 100.0 / wall)
        rss_bytes_twice += (before["rss_bytes"] + after["rss_bytes"]) * wall
    return {"cpu_peak_percent": max(usage), "active_sample_count": len(samples),
            "active_sample_median_ms": statistics.median(intervals) / 1_000_000,
            "rss_average_mib": rss_bytes_twice / (2 * sum(intervals) * 1_048_576),
            "rss_mib": max(sample["rss_bytes"] for sample in samples) / 1_048_576}


def throughput(raw_bytes, output_bytes, active_wall, poll_ms):
    if raw_bytes < 0 or output_bytes < 0 or not math.isfinite(active_wall) or active_wall <= 0:
        raise RuntimeError("invalid active-window throughput measurement")
    return {"raw_input_bytes": raw_bytes, "jsonl_output_bytes": output_bytes,
            "raw_input_bytes_per_second": raw_bytes / active_wall,
            "jsonl_output_bytes_per_second": output_bytes / active_wall, "poll_interval_ms": poll_ms}


def summarize_workload(rounds, load, drain_seconds=DRAIN_SECONDS):
    capacity_rounds = [round_["capacity"] for round_ in rounds if "capacity" in round_]
    quality = {"passed": not capacity_rounds,
               "missing": sum(round_["quality"]["missing"] for round_ in rounds),
               "duplicates": sum(round_["quality"]["duplicates"] for round_ in rounds)}
    result = {"repeats": len(rounds),
              "cpu_percent": summary([round_["cpu_percent"] for round_ in rounds]),
              "rss_mib": summary([round_["rss_mib"] for round_ in rounds]),
              "quality": quality,
              "p95_ms": None if load == "idle" or capacity_rounds else
                        summary([round_["quality"]["p95_ms"] for round_ in rounds])}
    if capacity_rounds:
        quality["validated_prefix"] = True
        result["capacity"] = {"drain_seconds": drain_seconds, "rounds": capacity_rounds}
    if rounds and all("cpu_peak_percent" in round_ for round_ in rounds):
        result["cpu_peak_percent"] = summary([round_["cpu_peak_percent"] for round_ in rounds])
    if rounds and all("rss_average_mib" in round_ for round_ in rounds):
        result["rss_average_mib"] = summary([round_["rss_average_mib"] for round_ in rounds])
    if rounds and "poll_interval_ms" in rounds[0]:
        cadence = {round_["poll_interval_ms"] for round_ in rounds}
        if len(cadence) != 1:
            raise RuntimeError("workload polling cadence changed between rounds")
        result["poll_interval_ms"] = cadence.pop()
        for field in ("raw_input_bytes_per_second", "jsonl_output_bytes_per_second"):
            result[field] = summary([round_[field] for round_ in rounds])
    return result


def environment_facts(args):
    cpu = next((line.split(":", 1)[1].strip() for line in Path("/proc/cpuinfo").read_text().splitlines()
                if line.startswith("model name")), "unknown")
    environment = {"cpu_model": cpu, "runner_os": os.environ.get("RUNNER_OS", platform.system()),
                   "runner_image": os.environ.get("ImageOS", "unknown") + "/" + os.environ.get("ImageVersion", "unknown"),
                   "kernel": platform.release(), "architecture": platform.machine(), "cpus": os.cpu_count(),
                   "container_digest": json.loads(command(["docker", "image", "inspect", args.image]))[0]["Id"]}
    environment["node_version"] = command(["docker", "run", "--rm", "--network", "none", args.image,
                                           "node", "--version"]).strip()
    return environment


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", type=lambda value: Path(value).resolve(), required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--runtime", choices=("js", "rust"), required=True)
    parser.add_argument("--native-entry")
    parser.add_argument("--output", type=lambda value: Path(value).resolve(), required=True)
    parser.add_argument("--kind", choices=("release", "main", "dev"), required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--source-repository", default="alibaba/loongsuite-pilot")
    parser.add_argument("--source-ref", default="main")
    parser.add_argument("--benchmark-method", choices=(METHOD, STANDARD_METHOD, QODER_MIXED_METHOD, QODER_FIXED_30S_METHOD), default=QODER_MIXED_METHOD)
    parser.add_argument("--smoke-only", action="store_true", help="Functional64-source check only; never emits node.json")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    try:
        args.layout = resolve_layout(args.package, args.runtime, args.native_entry)
        args.package = args.layout["package"]
    except Exception as error:
        receipt = {"status": "failed", "classification": "infrastructure", "confirmed": False,
                   "reason": "%s: %s" % (type(error).__name__, error),
                   "fixture_sha256": file_sha(Path(__file__).with_name("native_qoder_fixture.py")),
                   "smoke_only": args.smoke_only, "report_node": False}
        write_json(args.output / ("smoke.json" if args.smoke_only else "startup-error.json"), receipt)
        return 1
    if args.smoke_only:
        receipt = {"status": "failed", "classification": "infrastructure", "confirmed": False,
                   "fixture_sha256": file_sha(Path(__file__).with_name("native_qoder_fixture.py")),
                   "smoke_only": True, "report_node": False}
        code = 0
        try:
            receipt.update(run_round(args, args.output / "smoke", "smoke", 0, 0, smoke=True))
            receipt.update(classification="compatible", confirmed=True,
                           reason="All 64 raw native sources, exact tokens and four event types passed")
        except Exception as error:
            # A timeout or incomplete output cannot prove that an old release
            # lacks the contract. Cutoff requires separately reviewed evidence.
            receipt["error_category"] = "infrastructure_or_unconfirmed_collection_contract"
            receipt["reason"] = "%s: %s" % (type(error).__name__, error)
            code = 1
        write_json(args.output / "smoke.json", receipt)
        return code
    try:
        environment = environment_facts(args)
    except Exception as error:
        write_json(args.output / "startup-error.json", {"status": "failed", "classification": "infrastructure",
                   "confirmed": False, "report_node": False,
                   "reason": "%s: %s" % (type(error).__name__, error)})
        return 1
    environment_id = hashlib.sha256(compact(environment).encode()).hexdigest()
    node = {"id": "v" + args.version.lstrip("v") if args.kind == "release" else args.kind,
            "kind": args.kind, "version": args.version if args.kind == "release" else args.kind,
            "commit": args.commit, "recorded_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
            "status": "pending", "method_id": args.benchmark_method, "environment_id": environment_id, "environment": environment,
            "source": {"repository": args.source_repository, "ref": args.source_ref},
            "run_url": "%s/%s/actions/runs/%s" % (os.environ.get("GITHUB_SERVER_URL", "https://github.com"),
                os.environ.get("GITHUB_REPOSITORY", "local"), os.environ.get("GITHUB_RUN_ID", "local")),
            "workloads": {}, "rounds": []}
    entry = args.package / args.layout["entry"]
    node["provenance"] = {"entry_sha256": file_sha(entry),
        "compiler": os.environ.get("PILOT_BUILD_COMPILER"),
        "fixture_sha256": file_sha(Path(__file__).with_name("native_qoder_fixture.py"))}
    if args.layout.get("collection") == "legacy-stop":
        node["provenance"].update(collection="legacy-stop",
            legacy_fixture_sha256=file_sha(Path(__file__).with_name("legacy_qoder_fixture.py")),
            legacy_dispatcher_sha256=file_sha(Path(__file__).with_name("legacy_hook_dispatcher.cjs")))
    if args.runtime == "rust":
        node["provenance"]["library_sha256"] = file_sha(args.package / args.layout["library"])
    code = 0
    try:
        for repeat in range(1, 4):
            for load, rate in LOADS.items():
                directory = args.output / ("%s-%s" % (load, repeat))
                result = run_round_with_retry(lambda path: run_round(args, path, load, rate, repeat), directory)
                observed = node["environment"].get("cgroup_version")
                if observed and observed != result["cgroup_version"]:
                    raise RuntimeError("infrastructure: cgroup version changed during a node")
                node["environment"]["cgroup_version"] = result["cgroup_version"]
                node["environment_id"] = hashlib.sha256(compact(node["environment"]).encode()).hexdigest()
                node["rounds"].append(result)
                write_json(args.output / "node.json", node)
        for load in LOADS:
            rounds = [value for value in node["rounds"] if value["load"] == load]
            drain = QODER_FIXED_30S_DRAIN_SECONDS if args.benchmark_method == QODER_FIXED_30S_METHOD else DRAIN_SECONDS
            node["workloads"][load] = summarize_workload(rounds, load, drain)
        node["status"] = "passed"
    except Exception as error:
        node["status"] = "failed"; node["error"] = "%s: %s" % (type(error).__name__, error); code = 1
        node["error_category"] = "quality_failure" if isinstance(error, ValueError) else "infrastructure"
    write_json(args.output / "node.json", node)
    return code


if __name__ == "__main__":
    sys.exit(main())
