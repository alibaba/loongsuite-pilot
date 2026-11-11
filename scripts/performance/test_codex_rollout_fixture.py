from copy import deepcopy
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from codex_history import await_turns, capacity_result
from codex_rollout_fixture import CodexRolloutFixture, USAGE, validate_output


def fake_validator_rows(expected):
    """Independent JSONL-shaped rows only for testing the validator itself."""
    for turn in expected:
        base = {
            "user.id": "unit-test",
            "time_unix_nano": "1794384000000000000",
            "gen_ai.agent.type": "codex",
            "gen_ai.session.id": turn["session"],
            "gen_ai.turn.id": "%s:%s" % (turn["session"], turn["turn"]),
            "agent.codex.transcript_turn_id": turn["turn"],
            "gen_ai.provider.name": "openai",
        }
        for step in turn["steps"]:
            step_base = dict(base, **{"gen_ai.step.id": step["id"]})
            rid = step.get("response_id", step["id"])
            yield dict(step_base, **{
                "event.id": step["id"] + ":request", "event.name": "llm.request",
                "gen_ai.request.model": "gpt-5.5", "gen_ai.response.id": rid,
                "gen_ai.input.messages_delta": [{"role": "user", "parts": [{"type": "text", "content": turn["request_text"]}]}],
            })
            yield dict(step_base, **{
                "event.id": step["id"] + ":response", "event.name": "llm.response",
                "gen_ai.response.model": "gpt-5.5", "gen_ai.response.id": rid,
                "gen_ai.output.messages": json.dumps([{"role": "assistant", "parts": [{"type": "text", "content": turn["final_text"]}]}]),
                "gen_ai.response.finish_reasons": [step["finish"]],
                **{"gen_ai.usage." + field: step["usage"][key] for field, key in USAGE.items()},
            })
            if step["tool"]:
                tool = step["tool"]
                tool_base = dict(step_base, **{"gen_ai.tool.name": tool["name"], "gen_ai.tool.call.id": tool["id"]})
                yield dict(tool_base, **{
                    "event.id": step["id"] + ":call", "event.name": "tool.call",
                    "gen_ai.tool.call.arguments": json.dumps({"command": tool["arg"]}),
                })
                yield dict(tool_base, **{
                    "event.id": step["id"] + ":result", "event.name": "tool.result",
                    "gen_ai.tool.call.result": tool["result"],
                })
        yield dict(base, **{
            "event.id": turn["turn"] + ":end", "event.name": "other",
            "gen_ai.turn.end": True, "agent.codex.turn_status": "completed",
        })


class CodexRolloutFixtureTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.fixture = CodexRolloutFixture(self.directory.name, sessions=2)

    def test_raw_rollout_and_wakeup_have_expected_shapes(self):
        session, path, _ = self.fixture.sessions[0]
        header = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
        self.assertEqual([row["type"] for row in header], ["session_meta"])
        self.assertEqual(header[0]["payload"], {"id": session, "model_provider": "openai"})
        self.assertEqual(list(self.fixture.markers.iterdir()), [])
        before = path.stat().st_size
        one = self.fixture.append_turn(0)
        two = self.fixture.append_turn(0)
        self.assertEqual(self.fixture.raw_bytes, path.stat().st_size - before)
        self.assertEqual(len(self.fixture.expected), 2)
        self.assertNotEqual(one["turn"], two["turn"])
        marker = json.loads((self.fixture.markers / (session + ".json")).read_text())
        self.assertEqual(marker["transcript_path"], "/bench/" + str(path.relative_to(Path(self.directory.name))))
        self.assertEqual(marker["turn_id"], two["turn"])
        self.assertEqual(marker["hook_event"], "stop")
        rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
        self.assertFalse(any("event.name" in row for row in rows))
        first = [row["payload"]["info"]["last_token_usage"] for row in rows if row["payload"].get("type") == "token_count"][:3]
        self.assertEqual([(row["input_tokens"], row["output_tokens"], row["total_tokens"]) for row in first],
                         [(100, 10, 110), (120, 12, 132), (130, 13, 143)])

    def test_exact_core_counts_tokens_and_terminal_markers(self):
        self.fixture.append_turn(0)
        self.fixture.append_turn(1)
        expected = self.fixture.expected
        rows = list(fake_validator_rows(expected))
        result = validate_output(reversed(rows), expected)
        self.assertEqual(result, {
            "turns": 2,
            "core_events": {"llm.request": 6, "llm.response": 6, "tool.call": 4, "tool.result": 4},
            "turn_ends": 2,
            "tokens": {"input": 703, "output": 73, "total": 776, "reasoning": 67, "cached": 0},
        })

    def test_rejects_drops_duplicates_wrong_counts_and_broken_joins(self):
        self.fixture.append_turn(0)
        expected = self.fixture.expected
        rows = list(fake_validator_rows(expected))
        bad_rows = {
            "missing result": rows[:3] + rows[4:],
            "duplicate event": rows + [rows[2]],
            "missing turn end": rows[:-1],
        }
        for name, index, key, value in (
            ("token mismatch", 1, "gen_ai.usage.input_tokens", 101),
            ("boolean token count", 1, "gen_ai.usage.cache_read.input_tokens", False),
            ("response ID mismatch", 1, "gen_ai.response.id", "other-response"),
            ("tool ID mismatch", 3, "gen_ai.tool.call.id", "different-call"),
            ("wrong step", 0, "gen_ai.step.id", "not-a-source-step"),
            ("wrong turn", 0, "gen_ai.turn.id", "wrong-turn"),
            ("wrong model", 0, "gen_ai.request.model", "different-model"),
            ("wrong provider", 0, "gen_ai.provider.name", "different-provider"),
            ("empty input", 0, "gen_ai.input.messages_delta", "[]"),
            ("zero timestamp", 0, "time_unix_nano", "0000000000000000"),
            ("wrong tool result", 3, "gen_ai.tool.call.result", ""),
            ("wrong final message", 9, "gen_ai.output.messages", [{"role": "assistant", "parts": []}]),
            ("nonterminal finish", 9, "gen_ai.response.finish_reasons", ["tool_call"]),
        ):
            mutated = deepcopy(rows)
            mutated[index][key] = value
            bad_rows[name] = mutated
        for name, changed in bad_rows.items():
            with self.subTest(name=name), self.assertRaises(ValueError):
                validate_output(changed, expected)

    def test_public_jsonl_uses_normalized_turn_and_step_without_internal_metadata(self):
        self.fixture.append_turn(0)
        expected = self.fixture.expected
        rows = list(fake_validator_rows(expected))
        for row in rows:
            row.pop("agent.codex.transcript_turn_id", None)
            row.pop("agent.codex.turn_status", None)
        self.assertEqual(validate_output(rows, expected)["turn_ends"], 1)
        rows[-1]["gen_ai.turn.id"] = "unknown-source-turn"
        with self.assertRaises(ValueError):
            validate_output(rows, expected)


    def test_high_load_prefix_checks_every_delivered_row_and_source_order(self):
        for session in (0, 1, 0, 0):
            self.fixture.append_turn(session)
        expected = self.fixture.expected
        rows = list(fake_validator_rows(expected))
        prefix = rows[:24]
        result = validate_output(prefix, expected, warm_count=2)
        self.assertEqual(result["turns"], 0)
        self.assertEqual(result["pending"], expected[2:])
        self.assertEqual(result["missing_responses"], 5)

        wrong_token = deepcopy(prefix)
        wrong_token[-1]["gen_ai.usage.output_tokens"] += 1
        unexpected = dict(prefix[-1], **{"event.id": "unrelated", "event.name": "unknown"})
        for name, damaged in (
            ("corrupt partial response", wrong_token),
            ("duplicate partial request", prefix + [prefix[-2]]),
            ("unexpected auxiliary row", prefix + [unexpected]),
            ("missing warm row", prefix[:1] + prefix[2:]),
            ("finalized partial turn", prefix + [rows[32]]),
            ("later source turn after a gap", prefix + rows[33:34]),
            ("later step after a gap", prefix + rows[26:27]),
        ):
            with self.subTest(name=name), self.assertRaises(ValueError):
                validate_output(damaged, expected, warm_count=2)

    def test_high_load_capacity_requires_unread_bytes_or_proven_late_delivery(self):
        warm = [self.fixture.append_turn(session) for session in (0, 1)]
        pending = self.fixture.append_turn(0)
        rows = [(1, row) for row in fake_validator_rows(self.fixture.expected)]
        _, source, _ = self.fixture.sessions[0]
        checkpoint = self.fixture.data / "logs/input-state.json"
        checkpoint.parent.mkdir()
        position = {"inode": source.stat().st_ino, "scanOffset": warm[0]["end_offset"]}
        key = "codex-transcript:" + self.fixture.container_path(source)

        def save():
            checkpoint.write_text(json.dumps({key: {"extra": {"codexTranscript": position}}}))
        save()
        quality, evidence = capacity_result(self.fixture, rows[:22], 22, 2, 1)
        self.assertEqual(quality["missing"], 4)
        self.assertEqual(evidence["backlog"], {"pending_turns": 1, "late_turns": 0,
                                              "unread_bytes": pending["end_offset"] - warm[0]["end_offset"]})

        position["scanOffset"] = pending["end_offset"]
        save()
        with self.assertRaisesRegex(ValueError, "without unread source bytes"):
            capacity_result(self.fixture, rows[:22], 22, 2, 1)

        quality, evidence = capacity_result(self.fixture, rows, len(rows) - 1, 2, 1)
        self.assertEqual(quality["missing"], 1)
        self.assertEqual(evidence["missing_responses"], 0)
        self.assertEqual(evidence["backlog"], {"pending_turns": 1, "late_turns": 1, "unread_bytes": 0})

    def test_drain_timeout_blocks_unless_high_load_allows_capacity(self):
        output = SimpleNamespace(records=[], read=lambda: None)
        with self.assertRaisesRegex(ValueError, "missing terminal delivery"):
            await_turns(output, 0, {"missing-turn"}, deadline=0)
        self.assertTrue(await_turns(output, 0, {"missing-turn"}, deadline=0, allow_capacity=True))
        self.assertFalse(await_turns(output, 0, set(), deadline=0, allow_capacity=True))


if __name__ == "__main__":
    unittest.main()
