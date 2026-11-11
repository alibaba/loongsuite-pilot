"""Capacity measurement and publication checks without running Pilot or Docker."""
import copy
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from pilot_history import Output, REQUIRED, capacity_backlog, summarize_workload, validate_delivered_prefix
from prepare_public import select_backfill
from publish_history import OFFICIAL, compact, merge, validate_node
from test_publication import history, node


def turn(identifier, session="ci-native-00"):
    tool_id = "ci-tool-" + identifier
    response_ids = ["ci-response-" + identifier + "-" + part for part in ("call", "final")]
    metadata = {"session": session, "tool_id": tool_id, "response_ids": response_ids,
                "input_tokens": 35, "output_tokens": 11, "published_monotonic_ns": 0}
    rows = []
    for index, kind in enumerate(("llm.request", "llm.response", "tool.call", "tool.result",
                                  "llm.request", "llm.response")):
        row = {key: "fixture" for key in REQUIRED[kind]}
        row.update({"event.name": kind, "event.id": identifier + "-" + str(index),
                    "time_unix_nano": 1, "gen_ai.agent.type": "qoder-cli",
                    "gen_ai.session.id": session, "gen_ai.turn.id": identifier + "-observed"})
        if kind == "llm.request":
            row["gen_ai.input.messages_delta"] = [{"content": "synthetic " + identifier + " example"}]
        elif kind == "llm.response":
            row.update({"gen_ai.response.id": response_ids[0 if index == 1 else 1],
                        "gen_ai.usage.input_tokens": 35, "gen_ai.usage.output_tokens": 11})
        else:
            row["gen_ai.tool.call.id"] = tool_id
        rows.append((1, row))
    return metadata, rows


def overload_round(repeat=1):
    return {"repeat": repeat, "produced_turns": 6000, "completed_turns": 522,
            "missing_responses": 10956,
            "backlog": {"queued": 6064, "started": 594, "completed": 586, "active": 8, "pending": 5470}}


def measured_workload():
    rounds = [{"cpu_percent": value, "rss_mib": 120 + value,
               "quality": {"missing": 10956, "duplicates": 0, "p95_ms": None},
               "capacity": overload_round(index)}
              for index, value in enumerate((100, 101, 102), 1)]
    return summarize_workload(rounds, "high")


class CapacityTests(unittest.TestCase):
    def test_partial_last_turn_is_attributed_and_counts_missing_responses(self):
        warm, warm_rows = turn("warm-00")
        first, first_rows = turn("turn-000000")
        tail, tail_rows = turn("turn-000001")
        absent, _ = turn("turn-000002")
        other, other_rows = turn("turn-000003", "ci-native-01")
        quality = validate_delivered_prefix(
            warm_rows + first_rows + tail_rows[:1] + other_rows,
            {"warm-00": warm},
            {"turn-000000": first, "turn-000001": tail,
             "turn-000002": absent, "turn-000003": other})
        self.assertEqual(quality, {"passed": False, "missing": 4, "duplicates": 0,
                                   "validated_prefix": True, "turns": 2, "p95_ms": None})

    def test_corruption_and_holes_do_not_become_capacity_results(self):
        first, first_rows = turn("turn-000000")
        second, second_rows = turn("turn-000001")
        expected = {"turn-000000": first, "turn-000001": second}
        with self.assertRaisesRegex(ValueError, "gap in delivered native source prefix"):
            validate_delivered_prefix(second_rows, {}, expected)
        with self.assertRaisesRegex(ValueError, "incomplete delivered native turn"):
            validate_delivered_prefix(first_rows[1:], {}, expected)
        with self.assertRaisesRegex(ValueError, "duplicate event.id"):
            validate_delivered_prefix(first_rows + first_rows[:1], {}, expected)
        malformed = copy.deepcopy(first_rows[:2])
        malformed[1][1]["gen_ai.usage.output_tokens"] = 1
        with self.assertRaisesRegex(ValueError, "exact native token"):
            validate_delivered_prefix(malformed, {}, expected)
        malformed[1][1]["gen_ai.response.id"] = "unknown"
        with self.assertRaisesRegex(ValueError, "unknown or duplicate native response"):
            validate_delivered_prefix(malformed, {}, expected)

    def test_torn_final_output_record_is_a_quality_error(self):
        with TemporaryDirectory() as temp:
            path = Path(temp) / "output.jsonl"
            path.write_text('{"event.name":')
            output = Output(temp)
            self.assertEqual(output.read(), [])
            with self.assertRaisesRegex(ValueError, "unterminated output JSONL"):
                output.read(final=True)

    def test_high_load_timeout_requires_proof_of_pending_work(self):
        class Fixture:
            def check(self):
                return overload_round()["backlog"]

        self.assertEqual(capacity_backlog(Fixture(), True, 6064)["pending"], 5470)
        with self.assertRaisesRegex(RuntimeError, "did not receive every trigger"):
            capacity_backlog(Fixture(), True, 6065)
        with TemporaryDirectory() as temp:
            fixture = Fixture()
            fixture.sources = Path(temp)
            with self.assertRaisesRegex(RuntimeError, "no pending source notices"):
                capacity_backlog(fixture, False, 6064)
            pending = fixture.sources / "source/events/notice.json"
            pending.parent.mkdir(parents=True)
            pending.write_text("{}")
            self.assertEqual(capacity_backlog(fixture, False, 6064), {"pending_notices": 1})

    def test_capacity_measurement_publishes_real_resources_and_advances_backfill(self):
        value = node("release", "1.15.1")
        value["workloads"]["high"] = measured_workload()
        validate_node(value)
        published = compact(value)
        high = published["workloads"]["high"]
        self.assertEqual(high["cpu_percent"], {"min": 100, "median": 101, "max": 102})
        self.assertEqual(high["rss_mib"]["median"], 221)
        self.assertEqual(high["quality"], {"passed": False, "missing": 32868,
                                           "duplicates": 0, "validated_prefix": True})
        self.assertEqual(high["capacity"]["rounds"][0]["backlog"]["pending"], 5470)
        data = history()
        self.assertTrue(merge(data, value))
        with patch("prepare_public.stable_releases", return_value=[
                {"tag_name": "v1.15.1"}, {"tag_name": "v1.15.0"}]):
            self.assertEqual(select_backfill(OFFICIAL, data)["tag_name"], "v1.15.0")

    def test_validated_warmup_with_zero_measured_turns_can_reach_capacity(self):
        warm, rows = turn("warm-00")
        measured, _ = turn("turn-000000")
        prefix = validate_delivered_prefix(rows, {"warm-00": warm}, {"turn-000000": measured})
        self.assertEqual((prefix["turns"], prefix["missing"]), (0, 2))
        self.assertTrue(prefix["validated_prefix"])
        value = node("release", "1.15.1")
        high = measured_workload()
        for round_ in high["capacity"]["rounds"]:
            round_.update(completed_turns=0, missing_responses=12000,
                          backlog={"queued": 6064, "started": 72, "completed": 64, "active": 8, "pending": 5992})
        high["quality"]["missing"] = 36000
        value["workloads"]["high"] = high
        validate_node(value)
        self.assertEqual(compact(value)["workloads"]["high"]["capacity"]["rounds"][0]["completed_turns"], 0)

    def test_only_valid_high_load_capacity_evidence_is_accepted(self):
        for invalid in (
                lambda value: value["workloads"].update(low=measured_workload()),
                lambda value: value["workloads"]["high"].update(repeats=2),
                lambda value: value["workloads"]["high"]["quality"].update(passed=True),
                lambda value: value["workloads"]["high"]["quality"].update(duplicates=1),
                lambda value: value["workloads"]["high"]["capacity"]["rounds"][0].update(produced_turns=5999),
                lambda value: value["workloads"]["high"]["capacity"]["rounds"][0]["backlog"].update(pending=0),
                lambda value: value["workloads"]["high"]["cpu_percent"].update(min=float("nan"))):
            value = node()
            value["workloads"]["high"] = measured_workload()
            invalid(value)
            with self.assertRaises(ValueError):
                validate_node(value)


if __name__ == "__main__":
    unittest.main()
