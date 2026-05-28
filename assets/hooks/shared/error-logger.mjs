// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * error-logger.mjs — fail-open 错误日志。
 *
 * Hook 进程的任何异常都不能阻塞宿主 agent。所有错误写入
 *   ~/.loongsuite-pilot/logs/<agentId>/errors/<agentId>-error-YYYY-MM-DD.jsonl
 * 写入失败也吃掉,永不抛错。
 *
 * 参考 cursor-loongsuite-pilot-hook.sh 的 log_error shell 实现。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function pilotDataDir() {
  return process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
}

function todayStamp() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 写一条 fail-open 错误日志。
 *
 * @param {object} opts
 * @param {string} opts.agentId       agent 标识(如 "claude-code" / "codex")
 * @param {string} opts.stage         发生错误的阶段(如 "stdin_parse" / "transcript_read")
 * @param {string} opts.errorType     错误类型(低基数标识符)
 * @param {string} opts.errorMessage  人类可读详情
 */
export function logHookError({ agentId, stage, errorType, errorMessage }) {
  try {
    const dir = path.join(pilotDataDir(), 'logs', agentId, 'errors');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${agentId}-error-${todayStamp()}.jsonl`);
    const record = {
      time: new Date().toISOString(),
      'gen_ai.agent.type': agentId,
      stage: String(stage || 'unknown'),
      'error.type': String(errorType || '_OTHER'),
      'error.message': String(errorMessage || ''),
    };
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf-8');
  } catch {
    // fail-open: never throw
  }
}
