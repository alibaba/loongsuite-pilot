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
import shutil
import socket
import statistics
import subprocess
import sys
import time
import uuid

from native_qoder_fixture import Fixture, compact, monotonic_ns
from legacy_qoder_fixture import LegacyFixture
from linux_cgroup import locate as locate_cgroup
from runtime_layout import resolve as resolve_layout

METHOD = "github-full-pilot-qoder-native-v1"
LOADS = {"idle": 0, "low": 10, "high": 200}
COMMON = ("event.id", "time_unix_nano", "user.id", "gen_ai.agent.type", "gen_ai.session.id", "gen_ai.step.id")
REQUIRED = {
    "llm.request": COMMON + ("gen_ai.turn.id", "gen_ai.provider.name", "gen_ai.request.model", "gen_ai.input.messages_delta"),
    "llm.response": COMMON + ("gen_ai.turn.id", "gen_ai.response.id", "gen_ai.response.model", "gen_ai.response.finish_reasons", "gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens", "gen_ai.output.messages"),
    "tool.call": COMMON + ("gen_ai.tool.name", "gen_ai.tool.call.id", "gen_ai.tool.call.arguments"),
    "tool.result": COMMON + ("gen_ai.tool.name", "gen_ai.tool.call.id", "gen_ai.tool.call.result"),
}


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


def resources(container, cgroup, cpu=False):
    # Old Docker can wait a full stats interval even with one-shot=true. Do not
    # put that API call into the 100ms RSS/producer loop. CPU is cumulative and
    # is requested only at interval boundaries on either cgroup version.
    stats = docker_json("/containers/%s/stats?stream=false&one-shot=true" % container) if cpu else None
    pids = [int(value) for value in cgroup["processes"].read_text().split()]
    memory = 0
    for pid in pids:
        try:
            for line in Path("/proc/%d/status" % pid).read_text().splitlines():
                if line.startswith("VmRSS:"):
                    memory += int(line.split()[1]) * 1024
                    break
        except FileNotFoundError:
            pass  # an owned short-lived process ended during this sample
    if not pids or memory <= 0:
        raise RuntimeError("actual process RSS unavailable")
    usage = cgroup["memory_usage"]
    return {"at_ns": monotonic_ns(), "cpu_ns": stats["cpu_stats"]["cpu_usage"]["total_usage"] if stats else None,
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

    def read(self):
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
                    if not line or not line.endswith(b"\n"):
                        break
                    value = json.loads(line)
                    self.records.append((monotonic_ns(), value))
                    if value.get("event.name") == "llm.response" and isinstance(value.get("gen_ai.response.id"), str):
                        self.responses.add(value["gen_ai.response.id"])
                    offset = stream.tell()
            self.offsets[key] = offset
        return self.records


def response_catalog(expected):
    return {response: (identifier, metadata) for identifier, metadata in expected.items()
            for response in metadata["response_ids"]}


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
        if row.get("gen_ai.session.id") != metadata["session"]:
            raise ValueError("native session identity mismatch")
        if row.get("gen_ai.agent.type") != "qoder-cli":
            raise ValueError("raw CLI transcript did not retain its qoder-cli label")
        for name in REQUIRED[kind]:
            value = row.get(name)
            if value is None or value == "" or value == "null" or value == []:
                raise ValueError("missing required native field: " + name)
            if name == "time_unix_nano" and int(value) == 0:
                raise ValueError("zero event timestamp")
            fields[kind][name] += 1
        if kind.startswith("tool.") and row["gen_ai.tool.call.id"] != metadata["tool_id"]:
            raise ValueError("tool linkage mismatch")
    shape = collections.Counter({"llm.request": 2, "llm.response": 2, "tool.call": 1, "tool.result": 1})
    for identifier in expected:
        if counts[identifier] != shape:
            raise ValueError("fixed public native event cardinality failed: %s" % identifier)
    latencies = []
    for response, (identifier, metadata) in catalog.items():
        observed, row = known[response]
        if row["gen_ai.usage.input_tokens"] != metadata["input_tokens"] or row["gen_ai.usage.output_tokens"] != metadata["output_tokens"]:
            raise ValueError("exact native token enrichment failed")
        if response.endswith("-final"):
            latency = (observed - metadata["published_monotonic_ns"]) / 1e6
            if latency < 0 or not math.isfinite(latency):
                raise ValueError("invalid publication latency")
            latencies.append(latency)
    return {"passed": True, "missing": 0, "duplicates": 0,
            "required_field_counts": fields, "turns": len(expected),
            "p95_ms": sorted(latencies)[math.ceil(.95 * len(latencies)) - 1] if latencies else None}


def configure(fixture, output):
    # Only synthetic HOME/.qoder exists; real Agents/services are never installed.
    listeners = {name: {"enabled": False} for name in (
        "qoder", "qoder-work", "qoder-work-log", "qoder-work-sqlite", "qoder-work-cn-trace",
        "qoder-work-cn-hook", "qoder-work-cn-log", "qoder-work-cn-sqlite", "qwen-work-cn-trace",
        "qwen-work-cn-hook", "qwen-work-cn-sqlite", "cursor-hook", "claude-code-log", "grok-build-log",
        "codex-transcript", "copilot-log", "opencode-log", "pi-coding-agent-log", "workbuddy", "doubao-work", "hermes-agent-log")}
    listeners["qoder-trace"] = {"enabled": True, "pollInterval": 100}
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
    fixture = LegacyFixture(directory) if legacy else Fixture(directory)
    output = Output(directory / "output")
    configure(fixture, output.directory)
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
        warm_deadline = time.monotonic() + 25
        if legacy:
            wait_for_legacy_input(fixture, warm_deadline)
            fixture.start(container)
        # One warm turn per source makes all64 native sessions active before idle.
        warm = {}
        for session in range(64):
            identifier = "warm-%02d" % session
            fixture.append_turn(session, identifier, True)
        warm.update(fixture.expected)
        deadline = warm_deadline if legacy else time.monotonic() + 25
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
            observation = resources(container, cgroup, cpu=True)
            if legacy:
                fixture.finish(timeout=15)
            stop_container(container)
            output.read()
            quality = validate(output.records, warm)
            write_json(directory / "expected.json", warm)
            return {"status": "passed", "smoke_only": True, "report_node": False,
                    "quality": quality, "cgroup_version": cgroup["version"], "resources": observation}
        fixture.expected.clear()
        time.sleep(1)
        first = resources(container, cgroup, cpu=True)
        samples.append(first)
        start = time.monotonic(); end = start + 30
        produced, next_sample = 0, start
        while time.monotonic() < end:
            if legacy:
                fixture.check()
            now = time.monotonic()
            due = min(int((now - start) * rate) + 1, rate * 30) if rate else 0
            while produced < due:
                late.append(max(0, time.monotonic() - (start + produced / rate)) * 1000)
                fixture.append_turn(produced % 64, "turn-%06d" % produced)
                produced += 1
            if now >= next_sample:
                samples.append(resources(container, cgroup)); output.read(); next_sample = now + .1
            time.sleep(.001 if rate else .02)
        active_end = resources(container, cgroup, cpu=True)
        samples.append(active_end)
        if produced != rate * 30:
            raise RuntimeError("producer could not maintain the fixed rate")
        deadline = time.monotonic() + 15
        catalog = response_catalog(fixture.expected)
        while True:
            if legacy:
                fixture.check()
            output.read()
            if set(catalog).issubset(output.responses):
                break
            if time.monotonic() > deadline:
                raise RuntimeError("native input failed to drain")
            samples.append(resources(container, cgroup)); time.sleep(.1)
        if legacy:
            fixture.finish(timeout=max(0, deadline - time.monotonic()))
        drained = resources(container, cgroup, cpu=True)
        samples.append(drained)
        peak_file = cgroup["memory_peak"]
        cgroup_peak = int(peak_file.read_text()) if peak_file and peak_file.exists() else None
        stop_container(container)
        output.read()
        validate(output.records, dict(warm, **fixture.expected))
        quality = validate(output.records, fixture.expected)
        write_json(directory / "expected.json", fixture.expected)
        write_json(directory / "resource-samples.json", samples)
        active_wall = (active_end["at_ns"] - first["at_ns"]) / 1e9
        cpu = (active_end["cpu_ns"] - first["cpu_ns"]) / 1e9
        if active_wall <= 0 or cpu < 0 or not math.isfinite(cpu / active_wall):
            raise RuntimeError("invalid measured CPU interval")
        return {"load": load, "repeat": repeat, "cpu_percent": cpu / active_wall * 100,
                "rss_mib": max(value["rss_bytes"] for value in samples) / 1048576,
                "active_cpu_seconds": cpu, "active_wall_seconds": active_wall,
                "through_drain_cpu_seconds": (drained["cpu_ns"] - first["cpu_ns"]) / 1e9,
                "cgroup_memory_peak_bytes": cgroup_peak,
                "cgroup_version": cgroup["version"],
                "produced_turns": produced, "producer_max_lateness_ms": max(late) if late else None,
                "quality": quality}
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
            "status": "pending", "method_id": METHOD, "environment_id": environment_id, "environment": environment,
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
                result = run_round(args, args.output / ("%s-%s" % (load, repeat)), load, rate, repeat)
                observed = node["environment"].get("cgroup_version")
                if observed and observed != result["cgroup_version"]:
                    raise RuntimeError("infrastructure: cgroup version changed during a node")
                node["environment"]["cgroup_version"] = result["cgroup_version"]
                node["environment_id"] = hashlib.sha256(compact(node["environment"]).encode()).hexdigest()
                node["rounds"].append(result)
                write_json(args.output / "node.json", node)
        for load in LOADS:
            rounds = [value for value in node["rounds"] if value["load"] == load]
            node["workloads"][load] = {"repeats": len(rounds),
                "cpu_percent": summary([value["cpu_percent"] for value in rounds]),
                "rss_mib": summary([value["rss_mib"] for value in rounds]),
                "quality": {"passed": True, "missing": 0, "duplicates": 0},
                "p95_ms": summary([value["quality"]["p95_ms"] for value in rounds]) if load != "idle" else None}
        node["status"] = "passed"
    except Exception as error:
        node["status"] = "failed"; node["error"] = "%s: %s" % (type(error).__name__, error); code = 1
        node["error_category"] = "quality_failure" if isinstance(error, ValueError) else "infrastructure"
    write_json(args.output / "node.json", node)
    return code


if __name__ == "__main__":
    sys.exit(main())
