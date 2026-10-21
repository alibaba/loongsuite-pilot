/** OpenCode V2 public event adapter. No dependency on the V1 hook state machine. */
import crypto from "node:crypto";
import path from "node:path";

const LIMIT = 100;
const MAX_CONTENT = 64 * 1024;
const MAX_STEPS = 256;
const MAX_PARTS = 512;

function boundedSet(map, key, value, limit = LIMIT) {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value);
  return value;
}

function text(value) {
  if (typeof value !== "string") return undefined;
  return value.length > MAX_CONTENT ? value.slice(0, MAX_CONTENT) + "...[truncated]" : value;
}

function json(value) {
  return text(typeof value === "string" ? value : JSON.stringify(value));
}

function parts(content) {
  if (typeof content === "string") return [{ type: "text", content: text(content) }];
  if (!Array.isArray(content)) return [];
  return content.slice(0, MAX_PARTS).flatMap((part) => {
    if (part.type === "text" || part.type === "reasoning") {
      return [{ type: part.type, content: text(part.text) }];
    }
    if (part.type === "tool-call") return [{
      type: "tool_call", id: part.toolCallId, name: part.toolName, arguments: json(part.input),
    }];
    if (part.type === "tool-result") return [{
      type: "tool_call_response", id: part.toolCallId, response: json(part.output),
    }];
    return [];
  });
}

function inputMessages(context) {
  const messages = [];
  for (const part of context?.system ?? []) {
    if (part.text) messages.push({ role: "system", parts: [{ type: "text", content: text(part.text) }] });
  }
  for (const message of (context?.messages ?? []).slice(-MAX_PARTS)) {
    const content = parts(message.content);
    if (content.length) messages.push({ role: message.role, parts: content });
  }
  return messages;
}

function errorFields(error) {
  if (!error) return {};
  return {
    "error.type": error.name || error.type || "opencode_error",
    "error.message": json(error.message ?? error),
  };
}

export async function setupV2(ctx, shared) {
  const sessions = new Map();
  const prompts = new Map();
  const contexts = new Map();
  const seen = new Map();
  const controller = new AbortController();
  const registrations = [];
  let stopped = false;

  function session(id) {
    const existing = sessions.get(id);
    if (existing) return existing;
    return boundedSet(sessions, id, { currentTurn: null, steps: new Map(), inputs: [] });
  }

  function emit(event, state, name, fields = {}, sourceTime = event.created) {
    const record = {
      ...shared.common(event.data.sessionID, state),
      "agent.opencode.collection": "v2",
      "event.id": crypto.createHash("sha256").update(`${event.id}:${name}`).digest("hex"),
      "event.name": name,
      observed_time_unix_nano: String(BigInt(Date.now()) * 1000000n),
      ...fields,
    };
    if (Number.isFinite(sourceTime)) record.time_unix_nano = String(BigInt(Math.round(sourceTime)) * 1000000n);
    if (shared.captureMessageContent === false) {
      for (const key of ["gen_ai.input.messages", "gen_ai.input.messages_delta", "gen_ai.output.messages",
        "gen_ai.system_instructions", "gen_ai.tool.call.arguments", "gen_ai.tool.call.result", "error.message"]) delete record[key];
    }
    shared.writeRecord(record);
  }

  function begin(event, state) {
    if (state.currentTurn) return;
    state.currentTurn = {
      turnId: `${event.data.sessionID}:${event.id}`,
      traceId: crypto.createHash("sha256").update(event.id).digest("hex").slice(0, 32),
    };
    shared.recordUpstreamEnvOnce(event.data.sessionID);
    emit(event, state, "other", { "gen_ai.turn.start": true });
  }

  function finish(event, state, reason) {
    if (!state.currentTurn) return;
    // Interrupted requests may not have emitted step.failed yet. Close only
    // requests actually observed; never manufacture tokens or model output.
    for (const step of state.steps.values()) {
      for (const [id, tool] of step.tools) {
        if (tool.called && !tool.ended) {
          emit(event, state, "tool.result", {
            ...step.fields, "gen_ai.tool.name": tool.name, "gen_ai.tool.call.id": id,
            "tool.result.status": reason === "cancelled" ? "cancelled" : "failure",
            ...errorFields(event.data.error),
          });
          tool.ended = true;
        }
      }
      if (!step.ended) {
        emit(event, state, "llm.response", {
          ...step.fields, "gen_ai.response.finish_reasons": [reason], ...errorFields(event.data.error),
        });
        step.ended = true;
      }
    }
    emit(event, state, "other", {
      "gen_ai.turn.end": true, "gen_ai.response.finish_reasons": [reason], ...errorFields(event.data.error),
    });
    state.currentTurn = null;
    state.steps.clear();
    state.inputs = [];
  }

  function onEvent(event) {
    if (stopped || !event?.data?.sessionID || !event.id) return;
    if (event.location?.directory && path.resolve(event.location.directory) !== path.resolve(ctx.location.directory)) return;
    if (seen.has(event.id)) return;
    boundedSet(seen, event.id, true, 8192);
    const data = event.data;
    const state = session(data.sessionID);
    const type = event.type;
    if (type === "session.inbox.enqueued") {
      if (data.item?.type === "user") boundedSet(prompts, data.inboxID, text(data.item.payload?.text));
      return;
    }
    if (type === "session.inbox.cancelled") { prompts.delete(data.inboxID); return; }
    if (type === "session.execution.started") { begin(event, state); return; }
    if (type === "session.inbox.delivered") {
      const prompt = prompts.get(data.inboxID);
      prompts.delete(data.inboxID);
      begin(event, state);
      if (prompt) {
        const messages = [{ role: "user", parts: [{ type: "text", content: prompt }] }];
        state.inputs = messages;
        emit(event, state, "other", { "gen_ai.input.messages_delta": messages });
      }
      return;
    }
    if (type === "session.execution.succeeded") { finish(event, state, "stop"); return; }
    if (type === "session.execution.failed") { finish(event, state, "error"); return; }
    if (type === "session.execution.interrupted") {
      finish(event, state, "cancelled"); return;
    }
    if (type === "session.deleted") {
      finish(event, state, "cancelled");
      sessions.delete(data.sessionID); contexts.delete(data.sessionID); return;
    }
    if (type === "session.step.started") {
      begin(event, state);
      const step = {
        fields: {
          "gen_ai.step.id": data.assistantMessageID,
          "opencode.message.id": data.assistantMessageID,
          "gen_ai.agent.id": data.agent,
          "gen_ai.provider.name": shared.inferProviderName(data.model?.providerID),
          "gen_ai.request.model": data.model?.id,
        },
        content: new Map(), tools: new Map(), ended: false,
      };
      boundedSet(state.steps, data.assistantMessageID, step, MAX_STEPS);
      const messages = contexts.get(data.sessionID) ?? [];
      const system = messages.filter(m => m.role === "system").flatMap(m => m.parts.map(part => ({ ...part })));
      emit(event, state, "llm.request", {
        ...step.fields,
        ...(messages.length ? { "gen_ai.input.messages": messages } : {}),
        ...(state.inputs.length ? { "gen_ai.input.messages_delta": state.inputs } : {}),
        ...(system.length ? { "gen_ai.system_instructions": system } : {}),
      }, data.started ?? event.created);
      return;
    }
    const step = state.steps.get(data.assistantMessageID);
    if (!step || !state.currentTurn) return;
    if (type === "session.step.streamed") { step.streamedAt = event.created; return; }
    if (type === "session.text.ended" || type === "session.reasoning.ended") {
      boundedSet(step.content, `${type}:${data.ordinal}`, {
        type: type === "session.text.ended" ? "text" : "reasoning", content: text(data.text),
      }, MAX_PARTS);
      return;
    }
    if (type === "session.tool.input.started") {
      boundedSet(step.tools, data.id, { name: data.name }, MAX_PARTS); return;
    }
    if (type === "session.tool.called") {
      const tool = step.tools.get(data.id);
      if (!tool || tool.called) return;
      tool.called = true; tool.input = data.input; tool.started = event.created;
      emit(event, state, "tool.call", {
        ...step.fields, "gen_ai.tool.name": tool.name, "gen_ai.tool.call.id": data.id,
        "gen_ai.tool.call.arguments": data.input,
      });
      return;
    }
    if (type === "session.tool.success" || type === "session.tool.failed") {
      const tool = step.tools.get(data.id);
      if (!tool || tool.ended || !tool.called) return;
      tool.ended = true;
      tool.result = parts(data.content);
      emit(event, state, "tool.result", {
        ...step.fields, "gen_ai.tool.name": tool.name, "gen_ai.tool.call.id": data.id,
        ...(tool.result.length ? { "gen_ai.tool.call.result": tool.result } : {}),
        "tool.result.status": type === "session.tool.success" ? "success" : "failure",
        ...(event.created > tool.started ? { "gen_ai.tool.call.duration": event.created - tool.started } : {}),
        ...errorFields(data.error),
      });
      return;
    }
    if (type === "session.step.ended" || type === "session.step.failed") {
      if (step.ended) return;
      step.ended = true;
      const failed = type === "session.step.failed";
      const reason = failed ? "error" : ({ "tool-calls": "tool_calls", "content-filter": "content_filter" }[data.finish] ?? data.finish);
      const output = [...step.content.values()];
      for (const [id, tool] of step.tools) {
        if (tool.called) output.push({ type: "tool_call", id, name: tool.name, arguments: json(tool.input) });
      }
      const tokens = data.tokens;
      const input = tokens ? tokens.input + tokens.cache.read + tokens.cache.write : undefined;
      // Keep Pilot's established accounting: output excludes separately exposed reasoning.
      emit(event, state, "llm.response", {
        ...step.fields, "gen_ai.response.id": data.assistantMessageID,
        "gen_ai.response.model": step.fields["gen_ai.request.model"],
        ...(reason ? { "gen_ai.response.finish_reasons": [reason] } : {}),
        ...(output.length ? { "gen_ai.output.messages": [{ role: "assistant", parts: output, finish_reason: reason }] } : {}),
        ...(tokens ? {
          "gen_ai.usage.input_tokens": input, "gen_ai.usage.output_tokens": tokens.output,
          "gen_ai.usage.total_tokens": input + tokens.output,
          "gen_ai.usage.cache_read.input_tokens": tokens.cache.read,
          "gen_ai.usage.cache_creation.input_tokens": tokens.cache.write,
          "gen_ai.usage.reasoning_tokens": tokens.reasoning,
        } : {}),
        ...(typeof data.cost === "number" ? { cost_usd: data.cost } : {}),
        ...errorFields(data.error),
      }, step.streamedAt ?? event.created);
      // The next model step sees the actual preceding output and tool results.
      state.inputs = output.length ? [{ role: "assistant", parts: output }] : [];
      for (const [id, tool] of step.tools) {
        if (tool.ended && tool.result?.length) state.inputs.push({ role: "tool", parts: [{ type: "tool_call_response", id, response: json(tool.result) }] });
      }
      step.content.clear(); step.tools.clear();
    }
  }

  try {
    registrations.push(await ctx.session.hook("context", (event) => {
      // Copy bounded content now: OpenCode's context is mutable after the hook.
      try { boundedSet(contexts, event.sessionID, inputMessages(event)); }
      catch (error) { shared.writeError("v2-context", error); }
    }));
  } catch (error) { shared.writeError("v2-context", error); }

  const task = (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try { onEvent(event); } catch (error) { shared.writeError("v2-event", error); }
      }
    } catch (error) { if (!controller.signal.aborted) shared.writeError("v2-subscribe", error); }
  })();
  // The stream is background work. Awaiting it here would block plugin activation.
  return () => {
    stopped = true; controller.abort();
    for (const registration of registrations) {
      try {
        Promise.resolve(registration?.dispose?.()).catch(error => shared.writeError("v2-dispose", error));
      } catch (error) { shared.writeError("v2-dispose", error); }
    }
    sessions.clear(); prompts.clear(); contexts.clear(); seen.clear();
    void task;
  };
}
