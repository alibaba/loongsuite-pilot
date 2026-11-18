// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import * as fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export const MAX_CRON_CONTEXTS = 512;
// Identity only: a collector can finish its durable pending turn if Gateway
// restarts before OpenClaw sends cron_changed(finished). Never store prompts.
export function createCronContexts(dataDir, reportError) {
  const directory = () => path.join(dataDir(), "cron-contexts", "openclaw");
  const filename = jobId => path.join(directory(), crypto.createHash("sha256").update(jobId).digest("hex") + ".json");
  const string = value => typeof value === "string" && value.length > 0 && value.length <= 1024;
  let scan;
  let scanErrorReported = false;
  function reportScanError(err) {
    if (scanErrorReported) return;
    scanErrorReported = true;
    reportError("cron-context-scan", err);
  }
  function valid(value, jobId) {
    return value?.schema === 1 && value.jobId === jobId && Number.isFinite(value.runAtMs)
      && string(value.sessionKey) && string(value.runId) && string(value.sessionId)
      && string(value.turnId) && string(value.terminalEventId)
      && (value.lastObservedNanos === undefined
        || (typeof value.lastObservedNanos === "string" && /^\d{1,24}$/.test(value.lastObservedNanos)))
      && /^[0-9a-f]{32}$/.test(value.traceId || "") && !/^0+$/.test(value.traceId);
  }
  function hasCapacity() {
    const dir = fs.opendirSync(directory());
    let count = 0;
    let visited = 0;
    try {
      for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
        // Also bound the work if unrelated or interrupted temporary files
        // accumulate in this private directory.
        if (++visited > MAX_CRON_CONTEXTS * 2) return false;
        if (/^[a-f0-9]{64}\.json$/.test(entry.name) && ++count >= MAX_CRON_CONTEXTS) return false;
      }
      return true;
    } finally { dir.closeSync(); }
  }
  function read(jobId) {
    if (!string(jobId)) return;
    try {
      const file = filename(jobId);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) return;
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!valid(value, jobId)) return;
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
        const target = filename(jobId);
        // Never discard a pending context by age: even a very old job may
        // still be running. At capacity leave existing contexts intact and
        // let the caller fall back to the pre-cron producer behavior.
        if (!fs.existsSync(target) && !hasCapacity()) throw new Error("OpenClaw cron context capacity reached");
        const contents = JSON.stringify({ ...value, schema: 1, jobId });
        if (Buffer.byteLength(contents) > 16 * 1024) throw new Error("OpenClaw cron context exceeds size limit");
        temporary = target + "." + crypto.randomUUID() + ".tmp";
        fs.writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" });
        fs.renameSync(temporary, target);
        return true;
      } catch (err) { reportError("cron-context-write", err); return false; }
      finally { if (temporary) try { fs.unlinkSync(temporary); } catch {} }
    },
    remove(jobId, runAtMs) {
      try {
        if (read(jobId)?.runAtMs === runAtMs) fs.unlinkSync(filename(jobId));
      } catch (err) { if (err?.code !== "ENOENT") reportError("cron-context-remove", err); }
    },
    async listBatch(limit = 32) {
      const items = [];
      try {
        scan ??= await fsp.opendir(directory());
        for (let i = 0; i < limit; i++) {
          const entry = await scan.read();
          if (!entry) {
            await scan.close();
            scan = undefined;
            return { items, more: false };
          }
          if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
          const file = path.join(directory(), entry.name);
          try {
            const stat = await fsp.lstat(file);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) continue;
            const value = JSON.parse(await fsp.readFile(file, "utf8"));
            if (string(value?.jobId) && valid(value, value.jobId)
              && path.basename(filename(value.jobId)) === entry.name) items.push(value);
          } catch (err) { if (err?.code !== "ENOENT") reportScanError(err); }
        }
        return { items, more: true };
      } catch (err) {
        if (scan) { try { await scan.close(); } catch {} scan = undefined; }
        if (err?.code === "ENOENT") return { items, more: false };
        reportScanError(err);
        return { items, more: true };
      }
    },
    async closeScan() {
      if (!scan) return;
      const current = scan;
      scan = undefined;
      try { await current.close(); } catch {}
    },
  };
}
