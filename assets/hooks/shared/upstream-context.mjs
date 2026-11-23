// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * upstream-context.mjs — 方案1(env 注入)hook 侧 helper。
 *
 * 非交互式 CLI(headless)或交互式会话首个 turn,读进程环境变量 TRACEPARENT
 * (由上游/适配层注入到 agent 子进程 env,hook 子进程继承),写一条 session 级
 * 关联记录到 ${dataDir}/acp-correlate/<sessionId>.jsonl,供 pilot 归一阶段 stamp。
 *
 * 每个 session 只写一次:用 <sessionId>.env.lock 的 O_CREAT|O_EXCL(fs 'wx')抢锁,
 * 已存在(EEXIST)即视为已写过,直接返回。
 *
 * 全程 fail-open:任何异常都不得影响宿主 agent。
 */

import fs from 'node:fs';
import path from 'node:path';

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);

function safeName(value) {
  return path.basename(String(value)).replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
}

function isValidTraceparent(tp) {
  if (typeof tp !== 'string') return false;
  const m = TRACEPARENT_RE.exec(tp.trim());
  if (!m) return false;
  return m[1].toLowerCase() !== ZERO_TRACE && m[2].toLowerCase() !== ZERO_SPAN;
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
    const tp = (process.env.TRACEPARENT || '').trim();
    if (!isValidTraceparent(tp)) return;

    const dir = path.join(dataDir, 'acp-correlate');
    fs.mkdirSync(dir, { recursive: true });

    const base = safeName(sessionId);
    const lock = path.join(dir, `${base}.env.lock`);
    // O_CREAT|O_EXCL:抢锁成功者才写;已存在(EEXIST)= 已写过,直接返回。
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
    } catch (err) {
      if (err && err.code === 'EEXIST') return; // 正常路径,非错误
      throw err;
    }

    const record = { type: 'session', sessionId, traceparent: tp, ts: new Date().toISOString() };
    fs.appendFileSync(path.join(dir, `${base}.jsonl`), JSON.stringify(record) + '\n', 'utf-8');
  } catch (err) {
    // fail-open: 记录标记失败绝不能影响宿主 agent
    try {
      process.stderr.write(`[${agentId || 'hook'}] upstream_correlate skip: ${String((err && err.message) || err)}\n`);
    } catch {
      // ignore
    }
  }
}
