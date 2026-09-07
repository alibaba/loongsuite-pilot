import crypto from "node:crypto";

/** OpenClaw 2026.3.8 contract:
 * llm_input is run-level; before_message_write owns per-call output/usage.
 * Persistence/agent_end contexts have sessionKey but no runId. Tool hooks have
 * native runId/toolCallId. Do not infer failed retries absent from these hooks.
 * All handlers stay synchronous, return void, and never mutate host messages.
 */
export function createLegacyHandlers(shared) {
  const states = new WeakMap(); // Lifetime bounded by shared MAX_RUNS eviction.
  const owners = new Map(); // session-only hooks must never guess between runs.
  const nanos = () => `${Date.now()}000000`;
  const tagged = (emit, hook, extra = {}) => record => emit({
    ...record,
    "agent.openclaw.compatibility": "legacy",
    "agent.openclaw.hook": hook,
    ...extra,
  });

  function context(event, ctx) {
    const owner = owners.get(event?.sessionKey || ctx?.sessionKey);
    if (!event?.runId && !ctx?.runId && owner?.ambiguous) return null;
    const run = shared.resolveContextRun(event, ctx);
    return run && !run.completed ? { run, ctx: { ...ctx, runId: run.runId } } : null;
  }

  function assistant(event, ctx, userId, emit) {
    const match = context(event, ctx);
    const message = event?.message;
    if (!match || message?.role !== "assistant") return;
    const state = states.get(match.run);
    if (!state) return;
    const output = shared.buildAssistantOutputMessagesFromOpenClawMessage(message);
    if (!output && typeof message.stopReason !== "string" && !message.usage && !message.responseId) return;
    // Native response ID/timestamp + content distinguish repeated identical text
    // across calls, and suppress duplicate persistence of the same message.
    const fingerprint = crypto.createHash("sha256").update(shared.safeStringify(message)).digest("hex");
    if (state.seen.has(fingerprint)) return;
    state.seen.add(fingerprint);
    if (state.seen.size > 512) state.seen.delete(state.seen.values().next().value);
    const end = nanos();
    if (!state.boundary || BigInt(end) < BigInt(state.boundary)) return;
    const source = state.boundarySource;
    shared.handleModelCallStarted({ runId: match.run.runId, provider: message.provider, model: message.model },
      match.ctx, userId, record => {
        // Keep shared per-step tool timing/correlation state on the same inferred
        // boundary as the emitted request, rather than the observation time.
        match.run.modelCallStartedAtNanos.set(record["gen_ai.step.id"], state.boundary);
        tagged(emit, "before_message_write", {
          time_unix_nano: state.boundary,
          "agent.openclaw.timing.inferred": true,
          "agent.openclaw.timing.source": source,
        })(record);
      });
    shared.handleBeforeMessageWrite(event, match.ctx, userId,
      tagged(emit, "before_message_write", {
        time_unix_nano: end,
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
      fn(event, match.ctx, userId, tagged(emit, hook));
    };
  }

  return {
    llm_input(event, ctx, userId, emit, cfg) {
      if (!event?.runId) return;
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
        if (!owner || Date.now() - owner.updated > 30 * 60_000) owner = { ids: new Set(), ambiguous: false };
        owner.ids.add(run.runId);
        owner.ambiguous ||= owner.ids.size > 1;
        owner.updated = Date.now();
        if (owner.ids.size > 200) owner.ids.delete(owner.ids.values().next().value);
        owners.delete(key);
        owners.set(key, owner);
        if (owners.size > 100) owners.delete(owners.keys().next().value);
      }
      states.set(run, { boundary: nanos(), boundarySource: "llm_input", seen: new Set() });
      shared.handleBeforeAgentRun(event, fullCtx, userId, tagged(emit, "llm_input"), cfg);
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
      if (!match || !states.has(match.run)) return;
      // Failed attempts may never reach llm_output. End them immediately; a
      // later aggregate must not create a second empty trace after flushing.
      shared.handleAgentEnd(event, match.ctx, userId, tagged(emit, "agent_end",
        event?.success === false ? { "gen_ai.turn.end": true } : {}));
      if (event?.success === false) {
        states.delete(match.run);
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
      states.delete(match.run);
      release(match.run);
    },
    session_start: shared.handleSessionStart,
    session_end: shared.handleSessionEnd,
  };

  function release(run) {
    const owner = owners.get(run.sessionKey);
    if (!owner) return;
    owner.ids.delete(run.runId);
    // Keep ambiguity until all colliding runs end: a late persistence event
    // from the first run must not be attributed to the remaining one.
    if (!owner.ids.size) owners.delete(run.sessionKey);
  }
}
