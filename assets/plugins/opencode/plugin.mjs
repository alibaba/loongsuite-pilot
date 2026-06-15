/**
 * loongsuite-pilot OpenCode event_t plugin
 *
 * Runs inside the OpenCode process (Bun runtime).
 * Converts OpenCode EventV2 events into event_t JSONL records
 * for consumption by loongsuite-pilot's BaseHookInput pipeline.
 *
 * Zero external dependencies — only Node/Bun built-in APIs.
 *
 * OpenCode plugin hooks used (requires OpenCode >= 0.1.x):
 *   - chat.message           — turn start, user message capture
 *   - chat.params            — model / provider metadata
 *   - message.part.updated   — step-start, step-finish, tool invocation parts
 *   - message.updated        — LLM response aggregation, token metrics
 *   - tool.execute.before    — tool call arguments capture
 *   - tool.execute.after     — tool result & duration capture
 *   - experimental.chat.system.transform — system instructions capture (experimental API)
 *   - session.idle / session.error       — session lifecycle cleanup
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const AGENT_TYPE = "opencode";
const MAX_SESSIONS = 100;
const MAX_CONTENT_SIZE = 64 * 1024;

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
  return path.join(resolveDataDir(), "logs", "opencode");
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

function writeRecord(record) {
  try {
    if (!_logDirReady) {
      ensureDir(logDir());
      _logDirReady = true;
    }
    const filePath = path.join(logDir(), `opencode-${todayStamp()}.jsonl`);
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
      `opencode-error-${todayStamp()}.log`
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

function getSession(sessionID) {
  if (!sessionID) return null;
  let s = sessions.get(sessionID);
  if (!s) {
    s = {
      turnSeq: 0,
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
    };
    sessions.set(sessionID, s);
    if (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      sessions.delete(oldest);
    }
  }
  return s;
}

function clearSession(sessionID) {
  sessions.delete(sessionID);
}

// ---------------------------------------------------------------------------
// Record builder helpers
// ---------------------------------------------------------------------------

function buildCommonFields(sessionID, session, userId) {
  const turn = session.currentTurn;
  return {
    time_unix_nano: nowNanos(),
    "event.id": crypto.randomUUID(),
    trace_id: turn?.traceId ?? generateTraceId(),
    "gen_ai.session.id": sessionID,
    "gen_ai.turn.id": turn?.turnId,
    "user.id": userId,
    "gen_ai.agent.type": AGENT_TYPE,
    "gen_ai.agent.name": AGENT_TYPE,
    "gen_ai.agent.id": session.agentMeta?.name || undefined,
  };
}

function deriveFinishReasons(info, pendingParts) {
  if (info.error) return ["error"];
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
// Event handlers
// ---------------------------------------------------------------------------

function handleChatMessage(inp, out, userId) {
  const sessionID = inp.sessionID;
  if (!sessionID) return;

  const session = getSession(sessionID);

  session.turnSeq += 1;
  const turnId = `${sessionID}:t${session.turnSeq}`;
  const traceId = generateTraceId();

  session.currentTurn = {
    turnId,
    traceId,
    stepSeq: 0,
    userPromptText: null,
  };
  session.pendingParts = [];
  session.emittedToolCalls = new Set();
  session.stepStartTimeMs = null;
  session.lastStepOutputParts = null;

  const msg = out?.message;
  if (msg) {
    session.agentMeta = {
      name:
        (typeof msg.agent === "string" ? msg.agent : msg.agent?.name) ||
        (typeof inp.agent === "string" ? inp.agent : inp.agent?.name) ||
        AGENT_TYPE,
      id: msg.agent?.id || inp.agent?.id,
    };
    if (msg.model) {
      session.modelInfo = {
        providerID: msg.model.providerID,
        modelID: msg.model.modelID,
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
      if (inputMsgs) record["gen_ai.input.messages"] = inputMsgs;
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
    if (part.tokens) {
      session.stepFinishData = {
        tokens: part.tokens,
        cost: part.cost,
        reason: part.reason,
        time: props.time,
      };
    }
  }
}

function handleMessageUpdated(props, userId) {
  const info = props.info;
  if (!info || info.role !== "assistant") return;

  const sessionID = info.sessionID;
  if (!sessionID) return;

  const session = getSession(sessionID);
  const turn = session.currentTurn;
  if (!turn) return;

  if (!info.time?.completed) return;

  const model = session.modelInfo;
  const stepData = session.stepFinishData;
  const tokens = stepData?.tokens || info.tokens || {};
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

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

export default {
  id: "loongsuite-pilot-opencode",

  server: async (input, _options) => {
    ensureDir(logDir());

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
              if (s && s.pendingParts && s.pendingParts.length > 0) {
                writeError("session-cleanup", `session ${type}: discarding ${s.pendingParts.length} unflushed pending part(s) [${s.pendingParts.map(p => p.kind || "unknown").join(",")}]`);
              }
              clearSession(props.sessionID);
            }
            break;
          }
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
