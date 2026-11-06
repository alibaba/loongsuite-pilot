#!/usr/bin/env python3
"""Replay the actual Hermes host plugin for Rust input/linker regression fixtures.

Development only: run with Python >=3.8, then inspect the fixture diff. The Rust
test verifies both producer and source-fixture SHA-256, so stale replays fail.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "assets/plugins/hermes-agent/loongsuite-pilot/__init__.py"
SOURCE = ROOT / "tests/fixtures/hermes-agent/real-tool-turn-hooks.jsonl"
OUTPUT = ROOT / "tests/fixtures/hermes-agent/upstream-replay.json"
DRIVER = """
import importlib.util, json, pathlib, sys, types
spec = importlib.util.spec_from_file_location('pilot_hermes', sys.argv[1])
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)
hooks = {}
plugin.register(types.SimpleNamespace(register_hook=lambda name, cb: hooks.update({name: cb})))
for event in json.loads(pathlib.Path(sys.argv[2]).read_text()):
    hooks[event['hook']](**event['payload'])
"""


def main():
    if sys.version_info < (3, 8):
        raise SystemExit("Hermes host replay needs Python >=3.8; Rust tests do not need Python.")
    source = [json.loads(line) for line in SOURCE.read_text().splitlines()]
    prompt = next(row["payload"]["user_message"] for row in source if row["hook"] == "pre_llm_call")
    cases = []
    for case in ["normal", "history-only", "late-history", "full-late-history"]:
        events = []
        for turn in ["turn-1", "turn-2"]:
            for envelope in source:
                row = copy.deepcopy(envelope)
                payload, hook = row["payload"], row["hook"]
                payload["session_id"] = "hermes-native-session"
                if "task_id" in payload:
                    payload["task_id"] = turn
                previous = ([{"role": "user", "content": "Previous prompt"},
                             {"role": "assistant", "content": "Previous answer"}]
                            if case == "full-late-history" else [])
                if "user_message" in payload:
                    payload["user_message"] = ("" if case != "normal" and hook == "pre_llm_call" else prompt)
                if "conversation_history" in payload:
                    payload["conversation_history"] = ([] if case in ("late-history", "full-late-history") and hook == "pre_llm_call"
                                                       else previous + payload["conversation_history"])
                if case in ("late-history", "full-late-history") and hook == "pre_api_request" and payload["api_call_count"] == 1:
                    payload["conversation_history"] = previous + [{"role": "user", "content": prompt}]
                events.append(row)
        with tempfile.TemporaryDirectory(prefix="pilot-hermes-replay-") as temporary:
            directory = Path(temporary)
            event_path = directory / "events.json"
            event_path.write_text(json.dumps(events))
            env = os.environ.copy()
            env.update(LOONGSUITE_PILOT_DATA_DIR=temporary, PYTHONDONTWRITEBYTECODE="1",
                       LOONGSUITE_PILOT_SPAN_ATTRIBUTES="", LOONGSUITE_PILOT_USER_ID="fixture-user", LOONGSUITE_USER_ID="")
            subprocess.run([sys.executable, "-c", DRIVER, str(PLUGIN), str(event_path)],
                           env=env, check=True, timeout=20)
            files = list((directory / "logs/hermes-agent").glob("*.jsonl"))
            assert len(files) == 1
            records = [json.loads(line) for line in files[0].read_text().splitlines()]
            cases.append({"name": case, "records": records})
    OUTPUT.write_text(json.dumps({
        "schema": 1,
        "producerSha256": hashlib.sha256(PLUGIN.read_bytes()).hexdigest(),
        "sourceSha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
        "prompt": prompt,
        "cases": cases,
    }, ensure_ascii=False, indent=2) + "\n")
    print("Generated {} Hermes host replay cases".format(len(cases)))


if __name__ == "__main__":
    main()
