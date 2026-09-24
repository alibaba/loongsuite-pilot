"""Compare real Python spans with Pilot's raw callback records.

This does not substitute for validating the installed Pilot's OTLP export.
Timing/token values are deliberately not compared for equality across real calls.
"""
import argparse
import collections
import json
from pathlib import Path


def load(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def compare_raw(args):
    baseline, pilot = Path(args.baseline), Path(args.pilot)
    base_spans = load(baseline / "evidence/spans.jsonl")
    pilot_events = [event for path in (pilot / "home/.loongsuite-pilot/logs/qwenpaw").glob("*.jsonl") for event in load(path)]
    excluded = set(args.exclude_session)
    base_spans = [span for span in base_spans if span["attributes"].get("gen_ai.session.id") not in excluded]
    pilot_events = [event for event in pilot_events if event.get("gen_ai.session.id") not in excluded]
    base_counts, pilot_counts = collections.defaultdict(collections.Counter), collections.defaultdict(collections.Counter)
    base_llms, pilot_llms = collections.defaultdict(list), collections.defaultdict(list)
    for span in base_spans:
        attrs = span["attributes"]
        session = attrs.get("gen_ai.session.id", "background")
        if not session.startswith("parity-"):
            session = "background"
        kind = attrs.get("gen_ai.span.kind")
        base_counts[session][kind] += 1
        if kind == "LLM":
            base_llms[session].append(attrs)
    boundary_kinds = {"entry.end": "ENTRY", "agent.end": "AGENT", "step.end": "STEP"}
    for event in pilot_events:
        session = event.get("gen_ai.session.id", "background")
        if not session.startswith("parity-"):
            session = "background"
        kind = boundary_kinds.get(event.get("agent.qwenpaw.boundary"))
        if event["event.name"] == "llm.response":
            kind = "LLM"
            pilot_llms[session].append(event)
        elif event["event.name"] == "tool.result":
            kind = "TOOL"
        if kind:
            pilot_counts[session][kind] += 1
    results = {"scope": "Python spans vs raw Pilot callback evidence; final OTLP export is a separate gate", "excluded_sessions": sorted(excluded), "sessions": {}}
    failed = False
    for session in sorted(base_counts.keys() | pilot_counts.keys()):
        same = base_counts[session] == pilot_counts[session]
        # Background Dream independently chooses helper iterations/tools.
        if session != "background":
            failed |= not same
        results["sessions"][session] = {"baseline_counts": dict(base_counts[session]),
            "pilot_counts": dict(pilot_counts[session]), "same_counts": same,
            "strict_counts": session != "background",
            "baseline_llm_fields": [sorted(k for k in a if k.startswith("gen_ai.")) for a in base_llms[session]],
            "pilot_llm_fields": [sorted(k for k in a if k.startswith("gen_ai.")) for a in pilot_llms[session]]}
    results["foreground_same_counts"] = not failed
    checks = {}
    checks["nonstream_has_no_llm_ttft"] = all("gen_ai.response.time_to_first_token" not in e for e in pilot_llms.get("parity-nonstream", []))
    checks["normal_tools_not_cancelled"] = all(not e.get("agent.qwenpaw.cancelled") for e in pilot_events if e["event.name"] == "tool.result" and e.get("gen_ai.session.id") != "parity-cancel")
    checks["model_failure_captured"] = any(e.get("error.type") == "NotFoundError" for e in pilot_llms.get("parity-model-failure", [])) if "parity-model-failure" in pilot_llms else None
    checks["token_usage_captured"] = all(e.get("gen_ai.usage.input_tokens", 0) > 0 and e.get("gen_ai.usage.output_tokens", 0) > 0 for session, events in pilot_llms.items() if session.startswith("parity-") and session not in ("parity-cancel", "parity-model-failure") for e in events)
    checks["sessions_preserved"] = all(e.get("gen_ai.conversation.id") == e.get("gen_ai.session.id") for e in pilot_events if e.get("gen_ai.session.id", "").startswith("parity-"))
    results["pilot_invariants"] = checks
    failed |= any(v is False for v in checks.values())
    output = json.dumps(results, indent=2)
    if args.output:
        Path(args.output).write_text(output)
    print(output)
    return int(failed)


def attribute_value(value):
    if "arrayValue" in value:
        return [attribute_value(item) for item in value["arrayValue"].get("values", [])]
    if "kvlistValue" in value:
        return attributes(value["kvlistValue"].get("values", []))
    if "intValue" in value:
        return int(value["intValue"])
    return next(iter(value.values()), None)


def attributes(values):
    return {item["key"]: attribute_value(item["value"]) for item in values}


def read_wire(path):
    text = Path(path).read_text()
    try:
        documents = [json.loads(text)]
    except json.JSONDecodeError:
        documents = [json.loads(line) for line in text.splitlines() if line.strip()]
    spans = []
    for document in documents:
        for resource in document.get("resourceSpans", []):
            resource_attrs = attributes(resource.get("resource", {}).get("attributes", []))
            for scope in resource.get("scopeSpans", []):
                for raw in scope.get("spans", []):
                    spans.append({**raw, "attributes": attributes(raw.get("attributes", [])),
                                  "resource_attributes": resource_attrs})
    return spans


def session_group(span):
    session = span["attributes"].get("gen_ai.session.id", "")
    return session if session.startswith("parity-") else "background"


def present(value):
    if isinstance(value, str):
        return bool(value.strip()) and value.strip() not in ("[]", "{}", "null")
    return value is not None and value != [] and value != {}


def summarize_wire(spans):
    by_id = {(span["traceId"], span["spanId"]): span for span in spans}
    issues = []
    timing_findings = []
    groups = collections.defaultdict(lambda: {"counts": collections.Counter(), "fields": collections.defaultdict(set), "edges": collections.Counter()})
    if len(by_id) != len(spans):
        issues.append("duplicate trace/span IDs")
    for span in spans:
        attrs = span["attributes"]
        kind = attrs.get("gen_ai.span.kind", "UNKNOWN")
        group = session_group(span)
        groups[group]["counts"][kind] += 1
        groups[group]["fields"][kind].update(key for key, value in attrs.items() if present(value))
        start, end = int(span["startTimeUnixNano"]), int(span["endTimeUnixNano"])
        label = f"{group}/{kind}/{span['spanId']}"
        if end < start:
            issues.append(f"{label}: negative duration")
        parent_id = span.get("parentSpanId")
        if parent_id and parent_id != "0000000000000000":
            parent = by_id.get((span["traceId"], parent_id))
            if parent is None:
                issues.append(f"{label}: missing parent")
                continue
            parent_kind = parent["attributes"].get("gen_ai.span.kind", "UNKNOWN")
            groups[group]["edges"][f"{parent_kind}->{kind}"] += 1
            if group != "background" and session_group(parent) != group:
                issues.append(f"{label}: parent crosses business session")
            allowed = {"AGENT": {"ENTRY", "TOOL"}, "STEP": {"AGENT"}, "LLM": {"STEP", "AGENT"}, "TOOL": {"STEP", "AGENT"}}
            if kind in allowed and parent_kind not in allowed[kind]:
                issues.append(f"{label}: unexpected {parent_kind} parent")
            # Millisecond event-time conversion may round a timestamp slightly.
            if start + 1_000_000 < int(parent["startTimeUnixNano"]) or end > int(parent["endTimeUnixNano"]) + 1_000_000:
                timing_findings.append(f"{label}: child interval exceeds parent")
        else:
            groups[group]["edges"][f"ROOT->{kind}"] += 1
            if group != "background" and kind != "ENTRY":
                issues.append(f"{label}: foreground root is not ENTRY")
    semantic_values = {}
    for group in groups:
        selected = [span for span in spans if session_group(span) == group]
        llms = [span["attributes"] for span in selected if span["attributes"].get("gen_ai.span.kind") == "LLM"]
        semantic_values[group] = {
            "providers": sorted({a["gen_ai.provider.name"] for a in llms if a.get("gen_ai.provider.name")}),
            "models": sorted({a["gen_ai.request.model"] for a in llms if a.get("gen_ai.request.model")}),
            "llm_input_tokens": [a.get("gen_ai.usage.input_tokens") for a in llms],
            "llm_output_tokens": [a.get("gen_ai.usage.output_tokens") for a in llms],
            "llm_cache_read_tokens": [a.get("gen_ai.usage.cache_read.input_tokens") for a in llms],
            "llm_ttft_ns": [a.get("gen_ai.response.time_to_first_token") for a in llms],
            "error_types": dict(collections.Counter(span["attributes"]["error.type"] for span in selected if span["attributes"].get("error.type"))),
            "status_codes": dict(collections.Counter(str(span.get("status", {}).get("code", "UNSET")) for span in selected)),
        }
    return {"span_count": len(spans), "trace_count": len({span["traceId"] for span in spans}),
            "semantic_values": semantic_values,
            "services": sorted({s["resource_attributes"].get("service.name", "") for s in spans}),
            "graph_issues": issues, "timing_findings": timing_findings,
            "sessions": {key: {"counts": dict(value["counts"]), "edges": dict(value["edges"]),
                               "fields": {kind: sorted(fields) for kind, fields in value["fields"].items()}}
                         for key, value in sorted(groups.items())}}


def compare_wire(args):
    baseline, pilot = read_wire(args.baseline_wire), read_wire(args.pilot_wire)
    excluded = set(args.exclude_session)
    baseline = [span for span in baseline if span["attributes"].get("gen_ai.session.id") not in excluded]
    pilot = [span for span in pilot if span["attributes"].get("gen_ai.session.id") not in excluded]
    base_summary, pilot_summary = summarize_wire(baseline), summarize_wire(pilot)
    checks, violations, field_gaps = {}, [], {}
    checks["both_exporters_received"] = bool(baseline) and bool(pilot)
    checks["pilot_graph_valid"] = not pilot_summary["graph_issues"]
    checks["pilot_child_intervals_contained"] = not pilot_summary["timing_findings"]
    for session, base in base_summary["sessions"].items():
        other = pilot_summary["sessions"].get(session, {"counts": {}, "fields": {}, "edges": {}})
        if session != "background":
            checks[f"counts:{session}"] = base["counts"] == other["counts"]
            checks[f"edges:{session}"] = base["edges"] == other["edges"]
        else:
            checks["dream_agent_llm_tool_collected"] = all(other["counts"].get(kind, 0) > 0 for kind in ("AGENT", "LLM", "TOOL", "STEP"))
        field_gaps[session] = {kind: sorted(set(keys) - set(other["fields"].get(kind, []))) for kind, keys in base["fields"].items()}
    normal_llm_count = 0
    for span in pilot:
        attrs = span["attributes"]
        kind, session = attrs.get("gen_ai.span.kind"), session_group(span)
        label = f"{session}/{kind}/{span['spanId']}"
        expected_error = session in ("parity-model-failure", "parity-cancel")
        required = {"ENTRY": ["gen_ai.session.id"], "AGENT": ["gen_ai.agent.name"],
                    "STEP": ["gen_ai.react.round"], "LLM": ["gen_ai.request.model", "gen_ai.provider.name", "gen_ai.input.messages"],
                    "TOOL": ["gen_ai.tool.name", "gen_ai.tool.call.id", "gen_ai.tool.call.arguments"]}.get(kind, [])
        if kind == "LLM" and not expected_error:
            normal_llm_count += 1
            required += ["gen_ai.output.messages", "gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens"]
        if kind == "TOOL":
            required += ["gen_ai.tool.call.result"]
            if str(attrs.get("gen_ai.tool.name", "")).lower() == "skill":
                required += ["gen_ai.skill.name", "gen_ai.skill.id", "gen_ai.skill.description", "gen_ai.skill.version"]
        for key in required:
            if not present(attrs.get(key)):
                violations.append(f"{label}: missing {key}")
        if kind == "LLM":
            ttft = attrs.get("gen_ai.response.time_to_first_token")
            duration = int(span["endTimeUnixNano"]) - int(span["startTimeUnixNano"])
            if session == "parity-nonstream" and ttft is not None:
                violations.append(f"{label}: nonstream LLM has TTFT")
            elif not expected_error and session != "parity-nonstream" and (not isinstance(ttft, (int, float)) or not 0 <= ttft <= duration + 1_000_000):
                violations.append(f"{label}: missing or invalid streaming TTFT")
            if not expected_error and any(not isinstance(attrs.get(key), (int, float)) or attrs[key] <= 0 for key in ("gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens")):
                violations.append(f"{label}: invalid token usage")
        if session.startswith("parity-") and kind != "ENTRY" and attrs.get("gen_ai.conversation.id") != session:
            violations.append(f"{label}: conversation identity mismatch")
        if session == "parity-model-failure" and attrs.get("error.type") != "NotFoundError":
            violations.append(f"{label}: model error type missing")
        if session == "parity-cancel" and attrs.get("error.type") != "CancelledError":
            violations.append(f"{label}: cancellation type missing")
        if attrs.get("error.type") and str(span.get("status", {}).get("code")) not in ("2", "STATUS_CODE_ERROR"):
            violations.append(f"{label}: error has no ERROR span status")
        if session == "parity-cancel" and kind == "LLM" and "cancelled" not in attrs.get("gen_ai.response.finish_reasons", []):
            violations.append(f"{label}: cancellation finish reason missing")
        if session == "parity-tool-failure" and kind == "TOOL" and not attrs.get("error.type"):
            violations.append(f"{label}: failed tool not marked as error")
        if session == "background" and kind == "AGENT" and attrs.get("gen_ai.agent.name") != "QwenPaw parity":
            violations.append(f"{label}: Dream owner attribution lost")
    checks["normal_llm_calls_present"] = normal_llm_count > 0
    checks["pilot_required_fields_valid"] = not violations
    # Actual user-visible content is checked independently of token/timing equality.
    for session, marker in (("parity-multiturn", "PARITY_WITNESS_20260920"), ("parity-nonstream", "PARITY_NONSTREAM"), ("parity-a", "PARITY_A"), ("parity-b", "PARITY_B"), ("parity-skill", "PARITY_SKILL_20260920")):
        if session in base_summary["sessions"]:
            checks[f"content:{session}"] = any(marker in str(span["attributes"].get("gen_ai.output.messages", "")) for span in pilot if session_group(span) == session)
    result = {"scope": "Actual OTLP/HTTP protobuf received and decoded from both exporters",
              "excluded_sessions": sorted(excluded),
              "equal_token_values_required": False, "equal_timing_values_required": False,
              "baseline": base_summary, "pilot": pilot_summary,
              "baseline_fields_absent_from_pilot": field_gaps,
              "checks": checks, "required_field_violations": violations,
              "passed": all(checks.values())}
    output = json.dumps(result, indent=2)
    if args.output:
        Path(args.output).write_text(output)
    print(output)
    return int(not result["passed"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline")
    parser.add_argument("--pilot")
    parser.add_argument("--baseline-wire")
    parser.add_argument("--pilot-wire")
    parser.add_argument("--output")
    parser.add_argument("--exclude-session", action="append", default=[], help="Explicitly omit a supplemental session; recorded in the report")
    args = parser.parse_args()
    if args.baseline_wire and args.pilot_wire:
        raise SystemExit(compare_wire(args))
    if not args.baseline or not args.pilot:
        parser.error("supply --baseline/--pilot or --baseline-wire/--pilot-wire")
    raise SystemExit(compare_raw(args))
