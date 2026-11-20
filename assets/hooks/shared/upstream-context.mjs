// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * upstream-context.mjs — 方案1(env 注入)hook 侧 helper。
 *
 * 非交互式 CLI(headless)或交互式会话首个 turn,读进程环境变量 TRACEPARENT
 * (由上游/适配层注入到 agent 子进程 env,hook 子进程继承),写一条 session 级
 * 关联记录到 ${dataDir}/acp-correlate/<sessionId>.jsonl,供 pilot 归一阶段 stamp。
 *
 * 全程 fail-open:任何异常都不得影响宿主 agent。
 */

import fs from 'node:fs';
import path from 'node:path';
import { normalizeUpstreamCarrier, publishUpstreamRecord } from './upstream-ingress.mjs';

function safeName(value) {
  return path.basename(String(value)).replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
}

/**
 * @param {object} opts
 * @param {string} opts.agentId    agent 标识(如 "claude-code")
 * @param {string} opts.sessionId  当前会话 id
 * @param {string} opts.dataDir    pilot 数据目录(各 processor 的 pilotDataDir())
 */
export function recordUpstreamContextOnce({ agentId, sessionId, dataDir }) {
  try {
    if (!sessionId || !dataDir) return;
    const context = normalizeUpstreamCarrier(process.env);
    if (!context) return;

    const dir = path.join(dataDir, 'acp-correlate');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    const base = safeName(sessionId);
    const lock = path.join(dir, `${base}.env.lock`);
    const record = { type: 'session', sessionId, ...context, ts: new Date().toISOString() };
    if (!publishUpstreamRecord(lock, record)) return;
    fs.appendFileSync(path.join(dir, `${base}.jsonl`), JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    // fail-open: 记录标记失败绝不能影响宿主 agent
    try {
      process.stderr.write(`[${agentId || 'hook'}] upstream_correlate skip: io\n`);
    } catch {
      // ignore
    }
  }
}
