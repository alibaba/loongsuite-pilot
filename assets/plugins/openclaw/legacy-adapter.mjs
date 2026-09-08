import crypto from "node:crypto";
import { boundedMessageFingerprint } from "./legacy-utils.mjs";

/** OpenClaw 2026.3.8 contract:
 * llm_input is run-level; before_message_write owns per-call output/usage.
 * Persistence/agent_end contexts have sessionKey but no runId. Tool hooks have
 * native runId/toolCallId. Do not infer failed retries absent from these hooks.
 * All handlers stay synchronous, return void, and never mutate host messages.
 */
export function createLegacyHandlers(shared) {
  const states = new WeakMap(); // Lifetime bounded by shared MAX_RUNS eviction.
  const active = new Map(); // runId -> run; released by completion/session/eviction.
  const owners = new Map(); // session-only hooks must never guess between runs.
  const nanos = shared.nowNanos;
  const tagged = (emit, hook, extra = {}) => record => emit({
    ...record,
    "agent.openclaw.compatibility": "legacy",
    "agent.openclaw.hook": hook,
    ...extra,
  });

  function context(event, ctx) {
    const owner = owners.get(event?.sessionKey || ctx?.sessionKey);
    if (!event?.runId && !ctx?.runId && owner?.ambiguous) return null;
    const id = event?.runId || ctx?.runId || owner?.ids.values().next().value;
    // Late/unknown events must not recreate an evicted shared run object.
    const run = active.get(id);
    if (run && states.has(run)) states.get(run).updated = Date.now();
    return run && !run.completed ? { run, ctx: { ...ctx, runId: run.runId } } : null;
  }

  function assistant(event, ctx, userId, emit) {
    const match = context(event, ctx);
    const message = event?.message;
    if (!match || message?.role !== "assistant") return;
    const state = states.get(match.run);
    if (!state) return;
    if (!message.content?.length && typeof message.stopReason !== "string" && !message.usage && !message.responseId) return;
    // Native response ID/timestamp + content distinguish repeated identical text
    // across calls, and suppress duplicate persistence of the same message.
    const fingerprint = boundedMessageFingerprint(message);
    if (fingerprint && state.seen.has(fingerprint)) return;
    if (fingerprint) state.seen.add(fingerprint);
    if (state.seen.size > 512) state.seen.delete(state.seen.values().next().value);
    let end = nanos();
    if (!state.boundary || BigInt(end) < BigInt(state.boundary)) return;
    // The current GenAI converter floors nanoseconds to whole milliseconds.
    // Quantize only an otherwise-zero inferred interval, and advance the same
    // logical clock used by tools/parent terminals so children cannot escape.
    const quantized = BigInt(end) / 1_000_000n <= BigInt(state.boundary) / 1_000_000n;
    if (quantized) {
      end = ((BigInt(state.boundary) / 1_000_000n + 1n) * 1_000_000n).toString();
      shared.advanceClockTo(end);
    }
    const timing = quantized ? { "agent.openclaw.timing.quantized_ms": 1 } : {};
    const source = state.boundarySource;
    shared.handleModelCallStarted({ runId: match.run.runId, provider: message.provider, model: message.model },
      match.ctx, userId, record => {
        // Keep shared per-step tool timing/correlation state on the same inferred
        // boundary as the emitted request, rather than the observation time.
        match.run.modelCallStartedAtNanos.set(record["gen_ai.step.id"], state.boundary);
        tagged(emit, "before_message_write", {
          time_unix_nano: state.boundary,
          ...timing,
          "agent.openclaw.timing.inferred": true,
          "agent.openclaw.timing.source": source,
        })(record);
      });
    shared.handleBeforeMessageWrite(event, match.ctx, userId,
      tagged(emit, "before_message_write", {
        time_unix_nano: end,
        ...timing,
        "agent.openclaw.timing.inferred": true,
        "agent.openclaw.timing.source": source,
      }));
    // A subsequent call with no tool boundary can only be bounded by the last
    // observed assistant completion (e.g. automatic continuation/retry).
    state.boundary = end;
    state.boundarySource = "previous_assistant_persist";
  }

  function tool(fn, hook) {
    return (event, ctx, userId, emit) => {
      const match = context(event, ctx);
      if (!match || !states.has(match.run)) return;
      if (!match.run.currentStepCallId) return;
      fn(event, match.ctx, userId, record => {
        const start = match.run.toolStartedAtNanos.get(event?.toolCallId);
        if (record["event.name"] === "tool.result" && start
          && BigInt(record.time_unix_nano) / 1_000_000n <= BigInt(start) / 1_000_000n) {
          record = { ...record,
            time_unix_nano: ((BigInt(start) / 1_000_000n + 1n) * 1_000_000n).toString(),
            "agent.openclaw.timing.inferred": true,
            "agent.openclaw.timing.quantized_ms": 1 };
        }
        shared.advanceClockTo(record.time_unix_nano);
        tagged(emit, hook)(record);
      });
    };
  }

  return {
    llm_input(event, ctx, userId, emit, cfg) {
      if (!event?.runId) return;
      // Lazy bounded expiry is driven by new work, never a live timer keeping
      // Gateway alive. Expiry emits an incomplete terminal, not a fake failure.
      for (const run of active.values()) {
        if (Date.now() - states.get(run).updated > 30 * 60_000) abandon(run, "idle_expired");
      }
      // sessionId belongs to the event in 3.8; the general context may omit it.
      const fullCtx = { ...ctx, runId: event.runId, sessionId: event.sessionId || ctx?.sessionId };
      const previous = shared.resolveContextRun(event, fullCtx);
      if (previous?.completed) {
        // A provider fallback may reuse the native runId after its failed
        // attempt was already flushed. Give the new attempt its own trace and
        // turn identity, while retaining the native run ID for correlation.
        previous.traceId = crypto.randomBytes(16).toString("hex");
        previous.turnId = `${event.runId}:legacy:${crypto.randomUUID()}`;
      }
      shared.handleLlmInput(event, fullCtx, userId, emit, cfg);
      const run = shared.resolveContextRun(event, fullCtx);
      const key = ctx?.sessionKey || event.sessionKey;
      if (key) {
        let owner = owners.get(key);
        if (!owner) owner = { ids: new Set(), ambiguous: false };
        owner.ids.add(run.runId);
        owner.ambiguous ||= owner.ids.size > 1;
        owner.updated = Date.now();
        owners.delete(key);
        owners.set(key, owner);
      }
      active.set(run.runId, run);
      const state = { boundary: null, boundarySource: "llm_input", seen: new Set(), emit, userId, updated: Date.now() };
      states.set(run, state);
      run.onEvict = () => abandon(run, "capacity_evicted");
      shared.handleBeforeAgentRun(event, fullCtx, userId, record => {
        state.boundary = record.time_unix_nano;
        tagged(emit, "llm_input")(record);
      }, cfg);
    },
    before_message_write: assistant,
    before_tool_call: tool(shared.handleBeforeToolCall, "before_tool_call"),
    after_tool_call: tool(shared.handleAfterToolCall, "after_tool_call"),
    tool_result_persist(event, ctx, userId, emit) {
      const match = context(event, ctx);
      if (!match || !states.has(match.run)) return;
      const id = event?.message?.toolCallId || event?.toolCallId;
      const seen = id && match.run.persistedToolCallIds.has(id);
      shared.handleToolResultPersist(event, match.ctx, userId, tagged(emit, "tool_result_persist"));
      if (id && !seen) {
        const state = states.get(match.run);
        state.boundary = nanos();
        state.boundarySource = "tool_result_persist";
      }
    },
    agent_end(event, ctx, userId, emit) {
      const match = context(event, ctx);
      if (!match && event?.success === false) {
        const owner = owners.get(event?.sessionKey || ctx?.sessionKey);
        if (owner?.ambiguous) {
          for (const id of [...owner.ids]) abandon(active.get(id), "ambiguous_agent_end");
        }
      }
      if (!match || !states.has(match.run)) return;
      // Failed attempts may never reach llm_output. End them immediately; a
      // later aggregate must not create a second empty trace after flushing.
      shared.handleAgentEnd(event, match.ctx, userId, tagged(emit, "agent_end",
        event?.success === false ? { "gen_ai.turn.end": true } : {}));
      if (event?.success === false) {
        shared.completeRun(match.run);
        release(match.run);
      }
    },
    llm_output(event, ctx, userId, emit) {
      const match = context(event, ctx);
      if (!match || !states.has(match.run)) return;
      // lastAssistant can contain historic output; it is not a missing-call
      // fallback. Only messages observed during this run become LLM spans.
      const ambiguous = owners.get(match.run.sessionKey)?.ambiguous;
      shared.handleLlmOutput(event, match.ctx, userId, tagged(emit, "llm_output",
        ambiguous ? { "agent.openclaw.correlation.ambiguous": true } : {}));
      release(match.run);
    },
    session_start: shared.handleSessionStart,
    session_end(event, ctx, userId, emit) {
      const key = event?.sessionKey || ctx?.sessionKey;
      const sessionId = event?.sessionId || ctx?.sessionId;
      for (const run of active.values()) {
        if ((key && run.sessionKey === key) || (!key && sessionId && run.sessionId === sessionId)) {
          abandon(run, "session_end");
        }
      }
      shared.handleSessionEnd(event, ctx, userId, emit);
    },
  };

  function abandon(run, reason) {
    const state = run && states.get(run);
    if (!state) return;
    try {
      tagged(state.emit, "legacy_cleanup", {
        "gen_ai.turn.end": true,
        "agent.openclaw.collection.incomplete": true,
        "agent.openclaw.collection.end_reason": reason,
        ...(reason === "ambiguous_agent_end" ? { "agent.openclaw.correlation.ambiguous": true } : {}),
      })({ ...shared.buildCommonFields(run, run.sessionId, state.userId), "event.name": "other" });
    } finally {
      shared.completeRun(run);
      release(run);
    }
  }

  function release(run) {
    states.delete(run);
    active.delete(run.runId);
    delete run.onEvict;
    const owner = owners.get(run.sessionKey);
    if (!owner) return;
    owner.ids.delete(run.runId);
    // Keep ambiguity until all colliding runs end: a late persistence event
    // from the first run must not be attributed to the remaining one.
    if (!owner.ids.size) owners.delete(run.sessionKey);
  }
}
