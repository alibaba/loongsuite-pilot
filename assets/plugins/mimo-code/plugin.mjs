/**
 * loongsuite-pilot MiMo Code event_t plugin
 *
 * Runs inside the MiMo Code process (Node/Bun runtime).
 * Converts MiMo Code EventV2 events into event_t JSONL records
 * for consumption by loongsuite-pilot's BaseHookInput pipeline.
 *
 * Zero external dependencies — only Node/Bun built-in APIs.
 *
 * MiMo Code plugin hooks used (requires @mimo-ai/plugin >= 0.1.5):
 *   - Hooks.event              — message.part.updated / message.updated / session.idle / metrics.*
 *   - chat.message             — turn start, user message capture
 *   - chat.params              — model / provider metadata
 *   - message.part.updated     — step-start, step-finish, tool invocation parts
 *   - message.updated          — LLM response aggregation, token metrics
 *   - tool.execute.before      — tool call arguments capture
 *   - tool.execute.after       — tool result & duration capture
 *   - experimental.chat.system.transform — system instructions capture (experimental API)
 *   - session.idle / session.error       — session lifecycle cleanup
 *
 * MiMo Code is a downstream fork of opencode; the SDK shape is almost identical
 * to opencode's. Differences (v1 vs v2 Event union): in MiMo v2 the metrics.*
 * events (metrics.model_call / metrics.tool_call / metrics.agent_request) are
 * part of the Event union, but at runtime the SDK type-erases them into the v1
 * Hooks.event stream. This plugin therefore handles them inside the `event`
 * switch (currently as no-ops; ttft_ms / latency_ms are not required by ARMS
 * GenAI semantics and would only be span-attribute enhancements).
 *
 * Robustness fallback: when the chat.message hook is not invoked (e.g. when
 * the user starts MiMo with `--pure` or a SDK regression skips the hook), turn
 * creation is derived from `message.updated(info.role=user)` events so the
 * 5-layer span tree still builds correctly. When chat.message does fire, its
 * turn is reused (dedup by user messageID).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  agentBaseFieldPatch,
  collectResourceAttributesFromEnv,
} from "../shared/resource-context.mjs";

const AGENT_TYPE = "mimo-code";
const MAX_SESSIONS = 100;
const MAX_CONTENT_SIZE = 64 * 1024;

const RESOURCE_ATTRIBUTES = collectResourceAttributesFromEnv(process.env, { agentId: AGENT_TYPE });
const RESOURCE_BASE_FIELD_PATCH = agentBaseFieldPatch(RESOURCE_ATTRIBUTES);
const RESOURCE_ATTRIBUTE_FIELDS = Object.keys(RESOURCE_ATTRIBUTES).length > 0
  ? { resourceAttributes: RESOURCE_ATTRIBUTES }
  : {};

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function resolveDataDir() {
  return (
    process.env.LOONGSUITE_PILOT_DATA_DIR ||
    path.join(os.homedir(), ".loongsuite-pilot")
  );
}

function logDir() {
  return path.join(resolveDataDir(), "logs", "mimo-code");
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
}

function todayStamp() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}

// ---------------------------------------------------------------------------
// ID generators
// ---------------------------------------------------------------------------

function generateTraceId() {
  return crypto.randomBytes(16).toString("hex");
}

function generateSpanId() {
  return crypto.randomBytes(8).toString("hex");
}

function nowNanos() {
  return String(Date.now() * 1_000_000);
}

function msToNanos(ms) {
  return typeof ms === "number" && Number.isFinite(ms)
    ? String(Math.round(ms * 1_000_000))
    : undefined;
}

// ---------------------------------------------------------------------------
// Safe JSON serialization
// ---------------------------------------------------------------------------

function safeStringify(obj) {
  const seen = new WeakSet();
  return JSON.stringify(obj, function (_key, value) {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }
    if (typeof value === "function") return undefined;
    if (typeof value === "bigint") return value.toString();
    return value;
  });
}

function truncate(str, max) {
  if (typeof str !== "string") return str;
  return str.length > max ? str.slice(0, max) + "...[truncated]" : str;
}

function truncateContent(val) {
  if (typeof val === "string") return truncate(val, MAX_CONTENT_SIZE);
  if (Array.isArray(val)) {
    return val.map((item) => {
      if (typeof item !== "object" || !item) return item;
      const out = { ...item };
      if (out.parts && Array.isArray(out.parts)) {
        out.parts = out.parts.map((p) => {
          if (typeof p?.content === "string")
            return { ...p, content: truncate(p.content, MAX_CONTENT_SIZE) };
          if (typeof p?.response === "string")
            return { ...p, response: truncate(p.response, MAX_CONTENT_SIZE) };
          return p;
        });
      }
      return out;
    });
  }
  return val;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function loadPilotConfig() {
  try {
    const cfgPath = path.join(resolveDataDir(), "config.json");
    const raw = fs.readFileSync(cfgPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function resolveUserId(cfg) {
  return (
    process.env.LOONGSUITE_USER_ID ||
    cfg.userId ||
    os.hostname() ||
    "unknown"
  );
}

// ---------------------------------------------------------------------------
// JSONL writer
// ---------------------------------------------------------------------------

let _logDirReady = false;
// MiMo passes the project directory at server initialization. Individual
// message.updated events can provide a more precise per-session path.
let agentCwd;

function writeRecord(record) {
  try {
    if (!_logDirReady) {
      ensureDir(logDir());
      _logDirReady = true;
    }
    const filePath = path.join(logDir(), `mimo-code-${todayStamp()}.jsonl`);
    fs.appendFileSync(filePath, safeStringify(record) + "\n");
  } catch (err) {
    writeError("writeRecord", err);
  }
}

function writeError(source, err) {
  try {
    ensureDir(logDir());
    const errPath = path.join(
      logDir(),
      `mimo-code-error-${todayStamp()}.log`
    );
    fs.appendFileSync(
      errPath,
      `${new Date().toISOString()} [${source}] ${err?.stack || err}\n`
    );
  } catch {}
}

// ---------------------------------------------------------------------------
// Session state (LRU-bounded Map)
// ---------------------------------------------------------------------------

const sessions = new Map();
const sessionTurnSeqs = new Map();

function getSession(sessionID) {
  if (!sessionID) return null;
  let s = sessions.get(sessionID);
  if (!s) {
    s = {
      turnSeq: sessionTurnSeqs.get(sessionID) ?? 0,
      currentTurn: null,
      systemPrompt: null,
      systemInstructionsParts: null,
      agentMeta: null,
      modelInfo: null,
      llmParams: null,
      pendingParts: [],
      emittedToolCalls: new Set(),
      stepStartTimeMs: null,
      stepFinishData: null,
      stepEmittedResponse: false,
      cwd: agentCwd,
    };
    sessions.set(sessionID, s);
    if (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      clearSession(oldest);
    }
  }
  return s;
}

function clearSession(sessionID) {
  const s = sessions.get(sessionID);
  if (s) {
    sessionTurnSeqs.delete(sessionID);
    sessionTurnSeqs.set(sessionID, s.turnSeq);
    if (sessionTurnSeqs.size > MAX_SESSIONS) {
      const oldest = sessionTurnSeqs.keys().next().value;
      sessionTurnSeqs.delete(oldest);
    }
  }
  sessions.delete(sessionID);
}

// ---------------------------------------------------------------------------
// Record builder helpers
// ---------------------------------------------------------------------------

function buildCommonFields(sessionID, session, userId) {
  const turn = session.currentTurn;
  const cwd = session.cwd || agentCwd;
  return {
    time_unix_nano: nowNanos(),
    "event.id": crypto.randomUUID(),
    trace_id: turn?.traceId ?? generateTraceId(),
    "gen_ai.session.id": sessionID,
    "gen_ai.turn.id": turn?.turnId,
    "user.id": userId,
    "gen_ai.agent.type": AGENT_TYPE,
    "gen_ai.agent.name": session.agentMeta?.name || AGENT_TYPE,
    "gen_ai.agent.id": session.agentMeta?.id || undefined,
    ...(cwd ? { [`agent.${AGENT_TYPE}.cwd`]: cwd } : {}),
    // ARMS GenAI semconv: every span should carry gen_ai.framework so CMS can
    // route the trace to the right pipeline. The OTLP trace flusher also sets
    // it as a resource attribute, but mirroring it here on every record keeps
    // the event log self-describing for downstream tooling.
    "gen_ai.framework": AGENT_TYPE,
    ...RESOURCE_BASE_FIELD_PATCH,
    ...RESOURCE_ATTRIBUTE_FIELDS,
  };
}

function mapFinishReason(reason) {
  if (!reason) return "error";
  const r = String(reason).toLowerCase();
  if (r === "stop") return "stop";
  if (r === "tool-calls" || r === "tool_calls") return "tool_call";
  if (r === "length") return "length";
  if (r === "cancelled" || r === "canceled") return "cancelled";
  if (r === "error") return "error";
  return "error";
}

function deriveFinishReasons(info, pendingParts) {
  if (info.error) return ["error"];
  if (info.finish) return [mapFinishReason(info.finish)];
  if (pendingParts && pendingParts.some((p) => p.kind === "tool_call")) {
    return ["tool_call"];
  }
  const parts = info.parts || [];
  if (parts.some((p) => p.type === "tool" || p.type === "tool-invocation")) {
    return ["tool_call"];
  }
  return ["stop"];
}

function inferProviderName(providerID) {
  if (!providerID) return undefined;
  const id = String(providerID).toLowerCase();
  if (id.includes("mimo")) return "mimo";
  if (id.includes("anthropic")) return "anthropic";
  if (id.includes("openai")) return "openai";
  if (id.includes("alibaba") || id.includes("dashscope")) return "alibaba";
  if (id.includes("google") || id.includes("gemini")) return "google";
  return providerID;
}

// ---------------------------------------------------------------------------
// Message format helpers (ARMS nested parts structure)
// ---------------------------------------------------------------------------

function buildUserInputMessages(systemPrompt, userPromptText) {
  const messages = [];
  if (systemPrompt) {
    messages.push({
      role: "system",
      parts: [{ type: "text", content: truncate(systemPrompt, MAX_CONTENT_SIZE) }],
    });
  }
  if (userPromptText) {
    messages.push({
      role: "user",
      parts: [{ type: "text", content: truncate(userPromptText, MAX_CONTENT_SIZE) }],
    });
  }
  return messages.length > 0 ? messages : undefined;
}

function buildInputMessagesDelta(lastOutputParts) {
  const messages = [];
  const assistantParts = [];
  const toolResultParts = [];

  for (const p of lastOutputParts) {
    if (p.kind === "tool_call") {
      assistantParts.push({
        type: "tool_call",
        id: p.callID,
        name: p.toolName,
        arguments: p.arguments
          ? typeof p.arguments === "string"
            ? p.arguments
            : safeStringify(p.arguments)
          : undefined,
      });
      if (p.result !== undefined) {
        toolResultParts.push({
          type: "tool_call_response",
          id: p.callID,
          response: typeof p.result === "string"
            ? truncate(p.result, MAX_CONTENT_SIZE)
            : truncate(safeStringify(p.result), MAX_CONTENT_SIZE),
        });
      }
    } else if (p.kind === "text" && p.content) {
      assistantParts.push({ type: "text", content: truncate(p.content, MAX_CONTENT_SIZE) });
    }
  }

  if (assistantParts.length > 0) {
    messages.push({ role: "assistant", parts: assistantParts });
  }
  if (toolResultParts.length > 0) {
    messages.push({ role: "tool", parts: toolResultParts });
  }

  return messages.length > 0 ? messages : undefined;
}

function buildOutputMessages(pendingParts, finishReason) {
  const parts = [];

  for (const p of pendingParts) {
    if (p.kind === "reasoning" && p.content) {
      parts.push({ type: "reasoning", content: truncate(p.content, MAX_CONTENT_SIZE) });
    } else if (p.kind === "text" && p.content) {
      parts.push({ type: "text", content: truncate(p.content, MAX_CONTENT_SIZE) });
    } else if (p.kind === "tool_call") {
      const args = p.arguments
        ? typeof p.arguments === "string"
          ? truncate(p.arguments, MAX_CONTENT_SIZE)
          : truncate(safeStringify(p.arguments), MAX_CONTENT_SIZE)
        : undefined;
      parts.push({
        type: "tool_call",
        id: p.callID,
        name: p.toolName,
        arguments: args,
      });
    }
  }

  if (parts.length === 0) return undefined;

  return [
    {
      role: "assistant",
      parts,
      finish_reason: finishReason || "stop",
    },
  ];
}

// ---------------------------------------------------------------------------
// Turn creation (shared by chat.message hook and message.updated(role=user) fallback)
// ---------------------------------------------------------------------------

function startNewTurn(session, sessionID, userMessageID) {
  session.turnSeq += 1;
  const turnId = `${sessionID}:t${session.turnSeq}`;
  const traceId = generateTraceId();
  session.currentTurn = {
    turnId,
    traceId,
    stepSeq: 0,
    userPromptText: null,
    userMessageID: userMessageID || null,
  };
  session.pendingParts = [];
  session.emittedToolCalls = new Set();
  session.stepStartTimeMs = null;
  session.lastStepOutputParts = null;
  session.stepFinishData = null;
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function handleChatMessage(inp, out, userId) {
  const sessionID = inp.sessionID;
  if (!sessionID) return;

  const session = getSession(sessionID);
  session.cwd = selectCwd(
    out?.message?.path?.cwd,
    inp?.directory,
    inp?.cwd,
    session.cwd,
    agentCwd,
  );

  const msg = out?.message;
  const userMessageID = msg?.id || inp.messageID;

  // Dedup: if a turn already exists for this user message (e.g. created by
  // the message.updated(role=user) fallback), reuse it.
  if (
    session.currentTurn &&
    userMessageID &&
    session.currentTurn.userMessageID === userMessageID
  ) {
    // Still enrich userPromptText if the hook provided parts.
    if (!session.currentTurn.userPromptText && out?.parts && Array.isArray(out.parts)) {
      const textParts = out.parts
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text);
      if (textParts.length > 0) {
        session.currentTurn.userPromptText = textParts.join("\n");
      }
    }
    return;
  }

  startNewTurn(session, sessionID, userMessageID);

  if (msg) {
    session.agentMeta = {
      name:
        (typeof msg.agent === "string" ? msg.agent : msg.agent?.name) ||
        (typeof inp.agent === "string" ? inp.agent : inp.agent?.name) ||
        AGENT_TYPE,
      id:
        msg.agentID ||
        inp.agentID ||
        (typeof msg.agent === "string" ? msg.agent : msg.agent?.id) ||
        (typeof inp.agent === "string" ? inp.agent : inp.agent?.id),
    };
    if (msg.model) {
      session.modelInfo = {
        providerID: msg.model.providerID,
        modelID: msg.model.modelID,
      };
    }
  } else if (inp.agent || inp.model) {
    if (inp.agent) {
      session.agentMeta = {
        name:
          (typeof inp.agent === "string" ? inp.agent : inp.agent?.name) ||
          AGENT_TYPE,
        id:
          inp.agentID ||
          (typeof inp.agent === "string" ? inp.agent : inp.agent?.id),
      };
    }
    if (inp.model) {
      session.modelInfo = {
        providerID: inp.model.providerID,
        modelID: inp.model.modelID,
      };
    }
  }

  let userPromptText = null;
  if (out?.parts && Array.isArray(out.parts)) {
    const textParts = out.parts
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text);
    if (textParts.length > 0) {
      userPromptText = textParts.join("\n");
    }
  }
  session.currentTurn.userPromptText = userPromptText;

  const record = {
    ...buildCommonFields(sessionID, session, userId),
    "event.name": "other",
  };
  if (userPromptText) {
    record["gen_ai.input.messages_delta"] = [
      {
        role: "user",
        parts: [{ type: "text", content: truncate(userPromptText, MAX_CONTENT_SIZE) }],
      },
    ];
  }

  writeRecord(record);
}

function handleSystemTransform(_inp, out, sessionID) {
  if (!sessionID || !out?.system) return;
  const session = getSession(sessionID);
  const systemArr = out.system;
  if (Array.isArray(systemArr)) {
    session.systemPrompt = systemArr
      .filter((s) => typeof s === "string")
      .join("\n\n");
    session.systemInstructionsParts = systemArr
      .filter((s) => typeof s === "string" && s.length > 0)
      .map((s) => ({ type: "text", content: truncate(s, MAX_CONTENT_SIZE) }));
  }
}

function handleChatParams(inp, _out, sessionID) {
  if (!sessionID) return;
  const session = getSession(sessionID);

  if (inp.model) {
    session.modelInfo = {
      providerID: inp.model.providerID || inp.provider?.id,
      modelID: inp.model.id || inp.model.modelID,
    };
  }
}

function handleMessagePartUpdated(props, userId) {
  const sessionID = props.sessionID;
  const part = props.part;
  if (!sessionID || !part) return;

  const session = getSession(sessionID);
  const turn = session.currentTurn;
  if (!turn) return;

  const partType = part.type;

  if (partType === "step-start") {
    session.pendingParts = [];
    turn.stepSeq += 1;
    turn.currentStepId = `${turn.turnId}:s${turn.stepSeq}`;
    session.stepStartTimeMs = props.time || Date.now();
    session.stepEmittedResponse = false;

    const model = session.modelInfo;
    const record = {
      ...buildCommonFields(sessionID, session, userId),
      "event.name": "llm.request",
      "gen_ai.step.id": turn.currentStepId,
      "gen_ai.provider.name": inferProviderName(model?.providerID),
      "gen_ai.request.model": model?.modelID,
    };
    record.time_unix_nano = msToNanos(session.stepStartTimeMs) || nowNanos();

    if (turn.stepSeq === 1) {
      const inputMsgs = buildUserInputMessages(
        session.systemPrompt,
        turn.userPromptText
      );
      if (inputMsgs) {
        record["gen_ai.input.messages"] = inputMsgs;
        record["gen_ai.input.messages_delta"] = inputMsgs.map((message) => ({
          ...message,
          parts: message.parts.map((part) => ({ ...part })),
        }));
      }
      if (session.systemInstructionsParts && session.systemInstructionsParts.length > 0) {
        record["gen_ai.system_instructions"] = session.systemInstructionsParts;
      } else if (session.systemPrompt) {
        record["gen_ai.system_instructions"] = [
          { type: "text", content: truncate(session.systemPrompt, MAX_CONTENT_SIZE) },
        ];
      }
    } else if (session.lastStepOutputParts) {
      const delta = buildInputMessagesDelta(session.lastStepOutputParts);
      if (delta) record["gen_ai.input.messages_delta"] = delta;
    }

    writeRecord(record);
  } else if (partType === "reasoning") {
    session.pendingParts.push({
      kind: "reasoning",
      content: part.text || "",
      timeStart: part.time?.start,
      timeEnd: part.time?.end,
    });
  } else if (partType === "text" && part.messageID) {
    // User message text part: capture as userPromptText (fallback when
    // chat.message hook didn't fire, or hook parts were empty).
    if (
      turn.userMessageID &&
      part.messageID === turn.userMessageID
    ) {
      if (!turn.userPromptText) {
        turn.userPromptText = part.text || "";
      }
      return;
    }

    const isUserMessage =
      !turn.currentStepId &&
      session.pendingParts.length === 0;
    if (isUserMessage) return;

    session.pendingParts.push({
      kind: "text",
      content: part.text || "",
      timeStart: part.time?.start,
      timeEnd: part.time?.end,
    });
  } else if (partType === "tool" || partType === "tool-invocation") {
    const callID = part.callID || part.id;
    const toolName = part.tool || part.name;
    const state = part.state;

    const rawInput = state?.input;
    const hasRealInput = rawInput && typeof rawInput === "object"
      ? Object.keys(rawInput).length > 0
      : !!rawInput;
    const argsStr = hasRealInput
      ? typeof rawInput === "string" ? rawInput : safeStringify(rawInput)
      : undefined;

    if (state?.status === "running" && callID) {
      const existingPart = session.pendingParts.find(
        (pp) => pp.kind === "tool_call" && pp.callID === callID
      );
      if (existingPart && state.time?.start) {
        existingPart.startTimeMs = state.time.start;
      }

      if (session.emittedToolCalls.has(`call:${callID}`)) {
        if (argsStr && existingPart && !existingPart.arguments) {
          existingPart.arguments = argsStr;
        }
        return;
      }

      session.emittedToolCalls.add(`call:${callID}`);

      if (!existingPart) {
        session.pendingParts.push({
          kind: "tool_call",
          callID,
          toolName,
          arguments: argsStr,
          startTimeMs: state.time?.start || Date.now(),
        });
      }

      const toolCallRecord = {
        ...buildCommonFields(sessionID, session, userId),
        "event.name": "tool.call",
        "gen_ai.step.id": turn.currentStepId,
        "gen_ai.tool.name": toolName,
        // ARMS GenAI semconv: tool spans should carry gen_ai.tool.description.
        // MiMo Code SDK doesn't expose a per-call description, so we fall back
        // to the tool name (matches what CMS expects when no description is
        // available).
        "gen_ai.tool.description": toolName,
        "gen_ai.tool.call.id": callID,
        "gen_ai.tool.call.arguments": argsStr
          ? truncateContent(argsStr)
          : undefined,
      };
      if (state.time?.start) {
        toolCallRecord.time_unix_nano = msToNanos(state.time.start);
      }
      writeRecord(toolCallRecord);
    } else if (
      (state?.status === "completed" || state?.status === "error") &&
      callID &&
      !session.emittedToolCalls.has(`result:${callID}`)
    ) {
      session.emittedToolCalls.add(`result:${callID}`);

      const resultPayload = state.output ?? state.error ?? "";
      const matchingPart = session.pendingParts.find(
        (pp) => pp.kind === "tool_call" && pp.callID === callID
      );
      if (matchingPart) {
        matchingPart.result = resultPayload;
        if (!matchingPart.arguments && argsStr) {
          matchingPart.arguments = argsStr;
        }
      }

      const toolResultRecord = {
        ...buildCommonFields(sessionID, session, userId),
        "event.name": "tool.result",
        "gen_ai.step.id": turn.currentStepId,
        "gen_ai.tool.name": toolName,
        "gen_ai.tool.call.id": callID,
        "gen_ai.tool.call.result": truncateContent(
          typeof resultPayload === "string"
            ? resultPayload
            : safeStringify(resultPayload)
        ),
        "tool.result.status": state?.status === "error" ? "error" : "success",
      };
      if (state.time?.end) {
        toolResultRecord.time_unix_nano = msToNanos(state.time.end);
      }
      if (state.time?.start && state.time?.end) {
        toolResultRecord["gen_ai.tool.call.duration"] =
          Math.round(state.time.end - state.time.start);
      }
      writeRecord(toolResultRecord);
    }
  } else if (partType === "step-finish") {
    // Per plan §4.4: step-finish caches cost only; tokens come from
    // message.updated(info.time.completed) to avoid double-counting.
    if (part.cost != null || part.reason) {
      session.stepFinishData = {
        cost: part.cost,
        reason: part.reason,
        time: props.time,
      };
    }
  }
}

function handleMessageUpdated(props, userId) {
  const info = props.info;
  if (!info) return;

  const sessionID = info.sessionID;
  if (!sessionID) return;

  const session = getSession(sessionID);
  session.cwd = selectCwd(info.path?.cwd, session.cwd, agentCwd);

  // User message: turn boundary. This is the fallback path when the
  // chat.message hook did not fire (e.g. --pure mode). When chat.message
  // already created a turn for this user message, dedup and return.
  if (info.role === "user") {
    if (
      session.currentTurn &&
      info.id &&
      session.currentTurn.userMessageID === info.id
    ) {
      return;
    }

    startNewTurn(session, sessionID, info.id);

    session.agentMeta = {
      name: info.agent || AGENT_TYPE,
      id: info.agentID,
    };
    if (info.model || info.modelID || info.providerID) {
      session.modelInfo = {
        providerID: info.model?.providerID || info.providerID,
        modelID: info.model?.modelID || info.modelID,
      };
    }

    const record = {
      ...buildCommonFields(sessionID, session, userId),
      "event.name": "other",
    };
    writeRecord(record);
    return;
  }

  if (info.role !== "assistant") return;

  const turn = session.currentTurn;
  if (!turn) return;

  if (!info.time?.completed) return;

  const model = session.modelInfo;
  const stepData = session.stepFinishData;
  // Per plan §4.4: tokens come from info.tokens (step-finish only caches cost).
  const tokens = info.tokens || {};
  const finishReasons = deriveFinishReasons(info, session.pendingParts);
  const outputMessages = buildOutputMessages(
    session.pendingParts,
    finishReasons[0]
  );

  const record = {
    ...buildCommonFields(sessionID, session, userId),
    "event.name": "llm.response",
    "gen_ai.step.id": turn.currentStepId,
    "gen_ai.provider.name": inferProviderName(
      info.providerID || model?.providerID
    ),
    "gen_ai.request.model": info.modelID || model?.modelID,
    "gen_ai.response.model": info.modelID || model?.modelID,
    "gen_ai.response.id": info.id,
    "gen_ai.response.finish_reasons": finishReasons,
    "gen_ai.usage.input_tokens": tokens.input || 0,
    "gen_ai.usage.output_tokens": tokens.output || 0,
    "gen_ai.usage.cache_read.input_tokens": tokens.cache?.read || 0,
    "gen_ai.usage.cache_creation.input_tokens": tokens.cache?.write || 0,
  };
  if (tokens.reasoning) {
    record["gen_ai.usage.reasoning_tokens"] = tokens.reasoning;
  }

  record.time_unix_nano = msToNanos(info.time.completed) || nowNanos();

  if (outputMessages) {
    record["gen_ai.output.messages"] = truncateContent(outputMessages);
  }
  // Per plan §4.4: cost comes from step-finish (cached) or info.cost.
  const cost = stepData?.cost ?? info.cost;
  if (cost != null) {
    record["cost_usd"] = cost;
  }
  if (info.error) {
    record["error.type"] = "llm_error";
    record["error.message"] = truncate(
      typeof info.error === "string" ? info.error : safeStringify(info.error),
      1024
    );
  }

  writeRecord(record);
  session.stepEmittedResponse = true;

  session.lastStepOutputParts = [...session.pendingParts];
  session.pendingParts = [];
  session.stepFinishData = null;
}

function handleToolExecuteBefore(inp, out, userId) {
  const sessionID = inp?.sessionID;
  if (!sessionID) return;

  const session = getSession(sessionID);
  const turn = session.currentTurn;
  if (!turn) return;

  const callID = inp.callID || inp.id;
  const toolName = inp.tool || inp.name;
  if (!callID) return;

  const toolArgs = out?.args;
  const argsStr = toolArgs
    ? typeof toolArgs === "string"
      ? toolArgs
      : safeStringify(toolArgs)
    : undefined;

  if (session.emittedToolCalls.has(`call:${callID}`)) {
    if (argsStr) {
      const existing = session.pendingParts.find(
        (pp) => pp.kind === "tool_call" && pp.callID === callID && !pp.arguments
      );
      if (existing) existing.arguments = argsStr;
    }
    return;
  }

  session.emittedToolCalls.add(`call:${callID}`);

  session.pendingParts.push({
    kind: "tool_call",
    callID,
    toolName,
    arguments: argsStr,
    startTimeMs: Date.now(),
  });

  writeRecord({
    ...buildCommonFields(sessionID, session, userId),
    "event.name": "tool.call",
    "gen_ai.step.id": turn.currentStepId,
    "gen_ai.tool.name": toolName,
    "gen_ai.tool.description": toolName,
    "gen_ai.tool.call.id": callID,
    "gen_ai.tool.call.arguments": argsStr
      ? truncateContent(argsStr)
      : undefined,
  });
}

function handleToolExecuteAfter(inp, out, userId) {
  const sessionID = inp?.sessionID;
  if (!sessionID) return;

  const session = getSession(sessionID);
  const turn = session.currentTurn;
  if (!turn) return;

  const callID = inp.callID || inp.id;
  const toolName = inp.tool || inp.name;
  if (!callID || session.emittedToolCalls.has(`result:${callID}`)) return;

  const resultPayload = out?.output ?? out?.result ?? "";
  const matchingPart = session.pendingParts.find(
    (pp) => pp.kind === "tool_call" && pp.callID === callID
  );
  if (matchingPart) {
    matchingPart.result = resultPayload;
    if (!matchingPart.arguments && inp.args) {
      matchingPart.arguments = typeof inp.args === "string"
        ? inp.args
        : safeStringify(inp.args);
    }
  }

  session.emittedToolCalls.add(`result:${callID}`);

  const toolResultRecord = {
    ...buildCommonFields(sessionID, session, userId),
    "event.name": "tool.result",
    "gen_ai.step.id": turn.currentStepId,
    "gen_ai.tool.name": toolName,
    "gen_ai.tool.call.id": callID,
    "gen_ai.tool.call.result": truncateContent(
      typeof resultPayload === "string"
        ? resultPayload
        : safeStringify(resultPayload)
    ),
    "tool.result.status": out?.error ? "error" : "success",
  };
  if (matchingPart?.startTimeMs) {
    const endMs = Date.now();
    toolResultRecord.time_unix_nano = msToNanos(endMs);
    toolResultRecord["gen_ai.tool.call.duration"] =
      Math.round(endMs - matchingPart.startTimeMs);
  }
  writeRecord(toolResultRecord);
}

// ---------------------------------------------------------------------------
// Synthetic terminal-event emitter for interrupted turns
// ---------------------------------------------------------------------------

// Called on session.idle / session.error to close out a turn that has pending
// parts but never received info.time.completed. Emits:
//   - tool.result(success=false) for each pending tool_call part
//   - llm.response(finish_reason=stop) for the current step
// This gives the OTLP trace converter complete request/response + call/result
// pairs so spans have non-zero duration, output.messages, and tool.call.result.
function flushPendingPartsAsTerminal(session, sessionID, userId, reason) {
  const turn = session.currentTurn;
  if (!turn) return;

  const emittedToolCallIds = new Set();
  for (const p of session.pendingParts || []) {
    if (p.kind !== "tool_call") continue;
    if (!p.callID || emittedToolCallIds.has(p.callID)) continue;
    emittedToolCallIds.add(p.callID);

    if (session.emittedToolCalls.has(`result:${p.callID}`)) continue;

    session.emittedToolCalls.add(`result:${p.callID}`);
    const toolResultRecord = {
      ...buildCommonFields(sessionID, session, userId),
      "event.name": "tool.result",
      "gen_ai.step.id": turn.currentStepId,
      "gen_ai.tool.name": p.toolName,
      "gen_ai.tool.description": p.toolName,
      "gen_ai.tool.call.id": p.callID,
      "gen_ai.tool.call.result": "",
      "tool.result.status": "error",
    };
    if (p.startTimeMs) {
      const endMs = Date.now();
      toolResultRecord.time_unix_nano = msToNanos(endMs);
      toolResultRecord["gen_ai.tool.call.duration"] = Math.max(
        0,
        Math.round(endMs - p.startTimeMs)
      );
    }
    writeRecord(toolResultRecord);
  }

  // Emit a synthetic llm.response for the open step so the converter pairs it
  // with the step's llm.request. Skip if the step never had an llm.request
  // (currentStepId is null when only the user-message chat.message hook fired
  // and no step-start followed), OR if the step already emitted a real
  // llm.response (the turn completed normally — no need to synthesize).
  if (!turn.currentStepId || session.stepEmittedResponse) return;

  // Always emit "cancelled" as the synthetic finish_reason. The OTLP trace
  // flusher only treats stop/end_turn/cancelled as terminal, so using
  // "tool_call" (the original choice when pendingParts had a tool_call) would
  // leave the turn's buffer open until the next turn / non-zero idle timeout /
  // shutdown — and turnIdleTimeoutMs defaults to 0, so the interrupted turn
  // would never export. "cancelled" closes the turn immediately via Signal A.
  // The synthesized tool.result records (status=error) already capture that a
  // tool call was pending; the finish_reason only needs to be terminal here.
  const finishReasons = ["cancelled"];
  const outputMessages = buildOutputMessages(session.pendingParts, finishReasons[0]);

  // Ensure the synthetic llm.response timestamp is strictly later than the
  // step's llm.request timestamp. The converter computes LLM span duration as
  // readNanoMs(response.time) - readNanoMs(request.time) with millisecond
  // precision; if step-start and session.idle land in the same millisecond
  // (observed when MiMo aborts mid-LLM-call), the LLM/STEP spans come out as
  // duration=0. Bump the response time to request_time + 1ms when needed.
  const requestTimeMs = session.stepStartTimeMs ?? Date.now();
  const responseTimeMs = Math.max(Date.now(), requestTimeMs + 1);

  const llmResponseRecord = {
    ...buildCommonFields(sessionID, session, userId),
    "event.name": "llm.response",
    "gen_ai.step.id": turn.currentStepId,
    "gen_ai.provider.name": inferProviderName(session.modelInfo?.providerID),
    "gen_ai.request.model": session.modelInfo?.modelID,
    "gen_ai.response.model": session.modelInfo?.modelID,
    "gen_ai.response.finish_reasons": finishReasons,
    "gen_ai.usage.input_tokens": 0,
    "gen_ai.usage.output_tokens": 0,
    "gen_ai.usage.cache_read.input_tokens": 0,
    "gen_ai.usage.cache_creation.input_tokens": 0,
    "error.type": reason === "session.error" ? "session_error" : "session_idle",
    "error.message": `turn closed by ${reason} before info.time.completed`,
  };
  llmResponseRecord.time_unix_nano = msToNanos(responseTimeMs);
  if (outputMessages) {
    llmResponseRecord["gen_ai.output.messages"] = truncateContent(outputMessages);
  }
  writeRecord(llmResponseRecord);
}

// ---------------------------------------------------------------------------
// Safe wrapper
// ---------------------------------------------------------------------------

function safe(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      writeError(fn.name || "unknown", err);
    }
  };
}

function selectCwd(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

export default {
  id: "loongsuite-pilot-mimo-code",

  server: async (input, _options) => {
    ensureDir(logDir());

    agentCwd = selectCwd(input?.directory, input?.cwd, process.cwd());

    const cfg = loadPilotConfig();
    const userId = resolveUserId(cfg);

    return {
      event: safe(async function handleEvent({ event }) {
        const type = event.type;
        const props = event.properties || {};

        switch (type) {
          case "message.part.updated":
            handleMessagePartUpdated(props, userId);
            break;
          case "message.updated":
            handleMessageUpdated(props, userId);
            break;
          case "session.idle":
          case "session.error": {
            if (props.sessionID) {
              const s = sessions.get(props.sessionID);
              if (s) {
                // Close out an open turn that never saw info.time.completed
                // (interrupted / errored / SDK-skipped message.updated). Without
                // this synthetic terminal event, the OTLP trace flusher keeps
                // the turn's buffer open until idle timeout, and the converter
                // would emit orphan LLM/TOOL spans with duration=0 and no
                // output.messages / tool.call.result. Emitting a synthetic
                // llm.response(finish_reason=stop) and tool.result events for
                // any pending tool_call parts lets the flusher's Signal A
                // close the buffer cleanly with proper pairing.
                flushPendingPartsAsTerminal(s, props.sessionID, userId, type);
                clearSession(props.sessionID);
              }
            }
            break;
          }
          // metrics.* events are part of the v2 Event union but not required
          // by ARMS GenAI semantics. ttft_ms / latency_ms / input_bytes /
          // output_bytes would be span-attribute enhancements only.
          case "metrics.model_call":
          case "metrics.tool_call":
          case "metrics.agent_request":
          case "session.created":
          case "session.updated":
          case "session.status":
          case "session.diff":
          case "command.executed":
          case "file.edited":
          case "todo.updated":
          case "message.part.delta":
            // Intentionally no-op — keep the switch explicit so future
            // schema additions surface as a default-case log entry below.
            break;
          default:
            writeError("unknown-event", `type=${type}`);
            break;
        }
      }),

      "chat.message": safe(async function handleChatMsg(inp, out) {
        handleChatMessage(inp, out, userId);
      }),

      "chat.params": safe(async function handleParams(inp, out) {
        const sessionID = inp?.sessionID;
        if (sessionID) handleChatParams(inp, out, sessionID);
      }),

      "experimental.chat.system.transform": safe(
        async function handleSystemXform(inp, out) {
          const sessionID = inp?.sessionID;
          handleSystemTransform(inp, out, sessionID);
        }
      ),

      "tool.execute.before": safe(async function handleToolBefore(inp, out) {
        handleToolExecuteBefore(inp, out, userId);
      }),

      "tool.execute.after": safe(async function handleToolAfter(inp, out) {
        handleToolExecuteAfter(inp, out, userId);
      }),

      dispose: safe(async function handleDispose() {}),
    };
  },
};
