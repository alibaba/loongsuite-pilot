// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// Identity only: a collector can finish its durable pending turn if Gateway
// restarts before OpenClaw sends cron_changed(finished). Never store prompts.
export function createCronContexts(dataDir, reportError) {
  const directory = () => path.join(dataDir(), "cron-contexts", "openclaw");
  const filename = jobId => path.join(directory(), crypto.createHash("sha256").update(jobId).digest("hex") + ".json");
  const string = value => typeof value === "string" && value.length > 0 && value.length <= 1024;
  let pruned = false;
  function read(jobId) {
    if (!string(jobId)) return;
    try {
      const file = filename(jobId);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) return;
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (value?.schema !== 1 || value.jobId !== jobId || !Number.isFinite(value.runAtMs)
        || !string(value.sessionKey) || !string(value.runId) || !string(value.sessionId)
        || !string(value.turnId) || !string(value.terminalEventId)
        || !/^[0-9a-f]{32}$/.test(value.traceId || "") || /^0+$/.test(value.traceId)) return;
      return value;
    } catch (err) {
      if (err?.code !== "ENOENT") reportError("cron-context-read", err);
    }
  }
  return {
    read,
    write(jobId, value) {
      let temporary;
      try {
        fs.mkdirSync(directory(), { recursive: true, mode: 0o700 });
        if (!pruned) {
          pruned = true;
          // Keep synchronous work on the host hook path bounded.
          for (const name of fs.readdirSync(directory()).slice(0, 32)) {
            if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
            const file = path.join(directory(), name);
            try {
              const stat = fs.lstatSync(file);
              if (stat.isFile() && !stat.isSymbolicLink() && Date.now() - stat.mtimeMs > RETENTION_MS) fs.unlinkSync(file);
            } catch (err) { if (err?.code !== "ENOENT") reportError("cron-context-prune", err); }
          }
        }
        temporary = filename(jobId) + "." + crypto.randomUUID() + ".tmp";
        fs.writeFileSync(temporary, JSON.stringify({ ...value, schema: 1, jobId }), { mode: 0o600, flag: "wx" });
        fs.renameSync(temporary, filename(jobId));
        return true;
      } catch (err) { reportError("cron-context-write", err); return false; }
      finally { if (temporary) try { fs.unlinkSync(temporary); } catch {} }
    },
    remove(jobId, runAtMs) {
      try {
        if (read(jobId)?.runAtMs === runAtMs) fs.unlinkSync(filename(jobId));
      } catch (err) { if (err?.code !== "ENOENT") reportError("cron-context-remove", err); }
    },
  };
}
