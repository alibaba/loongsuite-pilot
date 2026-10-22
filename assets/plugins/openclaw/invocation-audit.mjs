import crypto from "node:crypto";

export function invocationId(sessionId, turnId, toolCallId) {
  return crypto.createHash("sha256").update(JSON.stringify([
    "openclaw-delegation", sessionId, turnId, toolCallId,
  ])).digest("hex").slice(0, 32);
}

/** Keep audit delivery facts separate from model/tool execution records. */
export function auditRecord(common, work, kind, messages, peerId) {
  const name = `gen_ai.agent.${kind}`;
  const digest = crypto.createHash("sha256").update(JSON.stringify(messages ?? null)).digest("hex").slice(0, 16);
  const record = {
    ...common,
    "event.name": name,
    "event.id": `${work.invocationId}:${kind}${kind === "result" ? `:${digest}` : ""}`,
    "gen_ai.agent.invocation.id": work.invocationId,
    ...(peerId ? { "gen_ai.agent.peer.id": peerId } : {}),
    ...(messages?.length ? { [kind === "invoke" ? "gen_ai.input.messages" : "gen_ai.output.messages"]: messages } : {}),
    "agent.openclaw.hook": "agent_invocation_audit",
  };
  delete record.span_id;
  delete record["gen_ai.step.id"];
  return record;
}

export function textMessages(text, role) {
  return typeof text === "string" && text.length
    ? [{ role, parts: [{ type: "text", content: text.slice(0, 64 * 1024) }] }]
    : undefined;
}

export function deliveredText(message) {
  const text = typeof message?.content === "string" ? message.content
    : Array.isArray(message?.content) ? message.content
      .filter(p => p?.type === "text" && typeof p.text === "string")
      .map(p => p.text).join("\n") : undefined;
  if (!text) return undefined;
  // Recent hosts keep the result in a separate runtime-context carrier. The
  // persisted user message only wakes the receiver; it is not a child reply.
  // Delivery identity remains observable even when that reply is unavailable.
  const wakeup = /^(?:\[Inter-session message\][^\r\n]*\r?\nThis content was routed by OpenClaw[^\r\n]*\r?\n)?Continue the OpenClaw runtime event\.$/;
  return wakeup.test(text.trim()) ? undefined : text;
}
