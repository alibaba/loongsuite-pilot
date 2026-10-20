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
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return undefined;
  return message.content.filter(p => p?.type === "text" && typeof p.text === "string")
    .map(p => p.text).join("\n") || undefined;
}
