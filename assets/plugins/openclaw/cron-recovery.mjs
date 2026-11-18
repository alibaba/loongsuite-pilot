// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

const INTERVAL_MS = 30_000;

// A model response is not a job boundary. Only the scheduler's matching
// completed execution is evidence that it is safe to close a missing hook.
export function hasFinishedCronRun(job, snapshot) {
  const state = job?.state;
  return job?.id === snapshot.jobId && state?.lastRunAtMs === snapshot.runAtMs
    && state?.runningAtMs !== snapshot.runAtMs
    && (state?.lastRunStatus === "ok" || state?.lastRunStatus === "error" || state?.lastRunStatus === "skipped");
}

export function cronRunEndMs(runAtMs, durationMs) {
  if (!Number.isSafeInteger(runAtMs) || runAtMs < 0
    || !Number.isSafeInteger(durationMs) || durationMs < 0) return undefined;
  const end = runAtMs + durationMs;
  return Number.isSafeInteger(end) ? end : undefined;
}

/** Reconcile only a bounded batch of persisted ownership against the host's
 * read-only cron service. Failures and unknown states retain the source data. */
export function createCronRecovery(contexts, reportError, intervalMs = INTERVAL_MS) {
  let getCron;
  let onRecovered;
  let timer;
  let inFlight;
  let enabled = false;
  let generation = 0;
  let wakeRequested = false;

  function configure(nextGetCron, nextOnRecovered) {
    if (typeof nextGetCron !== "function" || typeof nextOnRecovered !== "function") return;
    getCron = nextGetCron;
    onRecovered = nextOnRecovered;
    enabled = true;
  }

  async function reconcile() {
    if (inFlight) return inFlight;
    const epoch = generation;
    inFlight = (async () => {
      try {
        const { items, more } = await contexts.listBatch(32);
        if (!enabled || epoch !== generation) return false;
        if (items.length === 0) return more;
        const service = getCron?.();
        if (typeof service?.list !== "function") return true;
        const jobs = await service.list({ includeDisabled: true });
        if (!enabled || epoch !== generation) return false;
        if (!Array.isArray(jobs)) return true;
        const wanted = new Set(items.map(item => item.jobId));
        const byId = new Map();
        for (const job of jobs) if (wanted.has(job?.id)) byId.set(job.id, job);
        let pending = more;
        for (const item of items) {
          const job = byId.get(item.jobId);
          if (!hasFinishedCronRun(job, item) || onRecovered(item, job) === false) pending = true;
        }
        return pending;
      } catch (err) {
        reportError("cron-recovery", err);
        return enabled && epoch === generation;
      }
    })().finally(() => { inFlight = undefined; });
    return inFlight;
  }

  function wake() {
    if (!enabled || timer) return;
    if (inFlight) { wakeRequested = true; return; }
    timer = setTimeout(() => {
      timer = undefined;
      void reconcile().then(pending => {
        const again = pending || wakeRequested;
        wakeRequested = false;
        if (again) wake();
      });
    }, intervalMs);
    timer.unref?.();
  }

  function stop() {
    enabled = false;
    generation++;
    wakeRequested = false;
    if (timer) clearTimeout(timer);
    timer = undefined;
    void contexts.closeScan();
  }

  return { configure, wake, reconcile, stop };
}
