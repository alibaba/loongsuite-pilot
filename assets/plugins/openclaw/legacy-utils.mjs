import crypto from "node:crypto";

// Wall-clock anchored monotonic observation time, not native transport timing.
// Re-anchor on forward wall-clock jumps (also useful for deterministic tests),
// but never move backwards when the system clock is corrected.
export function createObservationClock() {
  let wall = BigInt(Date.now()) * 1_000_000n;
  let mono = process.hrtime.bigint();
  let last = wall - 1n;
  const observe = () => {
    const current = process.hrtime.bigint();
    let now = wall + current - mono;
    const observed = BigInt(Date.now()) * 1_000_000n;
    if (observed > now) { wall = observed; mono = current; now = observed; }
    return now;
  };
  const clock = () => {
    const now = observe();
    last = now > last ? now : last + 1n;
    return last.toString();
  };
  clock.advanceTo = value => { if (BigInt(value) > last) last = BigInt(value); };
  clock.observed = () => observe().toString();
  return clock;
}

// Never hash a truncated prefix as if it identified the complete message.
// Oversized/deep/accessor payloads decline structural deduplication instead of
// blocking the synchronous host hook or merging distinct model responses.
export function boundedMessageFingerprint(message) {
  let remaining = 64 * 1024;
  let nodes = 1024;
  const seen = new WeakSet();
  const hash = crypto.createHash("sha256");
  function add(text) {
    remaining -= text.length;
    if (remaining < 0) throw new Error("budget");
    hash.update(text);
  }
  function visit(value, depth = 0) {
    if (--nodes < 0 || depth > 16) throw new Error("budget");
    if (typeof value === "string" && value.length > remaining) throw new Error("budget");
    if (value === null || typeof value !== "object") {
      add(JSON.stringify(typeof value === "bigint" ? value.toString() : value) ?? "undefined");
      return;
    }
    if (seen.has(value)) throw new Error("cycle");
    seen.add(value);
    add(Array.isArray(value) ? "[" : "{");
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (key.length > remaining) throw new Error("budget");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) throw new Error("accessor");
      add(JSON.stringify(key)); add(":"); visit(descriptor.value, depth + 1); add(",");
    }
    add(Array.isArray(value) ? "]" : "}");
    seen.delete(value);
  }
  try { visit(message); return hash.digest("hex"); } catch {
    // Completed native responses with an ID and timestamp have a bounded
    // identity even when their content is huge. Never substitute a content
    // prefix when native identity is absent.
    const fields = ["responseId", "timestamp", "stopReason", "provider", "model"];
    const identity = fields.map(key => Object.getOwnPropertyDescriptor(message ?? {}, key)?.value);
    if (typeof identity[0] !== "string" || !identity[0] || typeof identity[1] !== "number"
      || !Number.isFinite(identity[1])) return null;
    if (identity.some(value => value !== undefined && typeof value !== "number"
      && (typeof value !== "string" || value.length > 512))) return null;
    return `native:${crypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
  }
}
