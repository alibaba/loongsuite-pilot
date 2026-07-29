# Paired Fixture ID Consistency Proof (response to architect P0 #1)

## Source of truth: same `zcode -p "Reply with exactly one word: hello"` invocation
- Date: 2026-07-13
- Probe wrapper: /tmp/age769-paired/probe-hook-wrapper.sh
- Probe trace: probe-hook-trace.log (single hook.invoked line)
- Stop hook stdin payload: hook-stop-stdin-paired.json
- Rollout JSONL (full): ~/.zcode/cli/rollout/model-io-sess_36734977-...jsonl
- Rollout JSONL (trimmed fixture): rollout-model-io-paired.jsonl

## Three-field comparison

| Field | rollout JSONL line 1 | Stop hook stdin | Match |
|---|---|---|---|
| sessionId | sess_36734977-639d-4424-94ba-8c1957576a5f | sess_36734977-639d-4424-94ba-8c1957576a5f | ✅ |
| turnId    | turn_b8638fe6-b763-4258-9b91-660d2f8edaef | turn_b8638fe6-b763-4258-9b91-660d2f8edaef | ✅ |
| traceId   | e294f5ce-30c2-4817-92be-d035412905a1       | e294f5ce-30c2-4817-92be-d035412905a1       | ✅ |

## Conclusion

V3 §1.2 hybrid 拼接前提 proven: rollout `model_io.traceId` 与 Stop stdin `traceId` 同 session/turn 一致。
hook ENTRY/AGENT envelope 经 traceId 与 rollout LLM/STEP 在 OTLP flusher 端可正确重组 5 层树。
