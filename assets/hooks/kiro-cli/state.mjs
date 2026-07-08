// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * state.mjs — Kiro CLI hook 事件缓冲（per-cwd）。
 *
 * Kiro hook 事件分多次进程到达：postToolUse 比 stop 早。
 * 中间 tool 事件的 tool_response（transcript 拿不到的唯一产出）必须先缓冲，
 * stop 触发导出时再与 transcript join。
 *
 * 缓冲键：cwd（= conversations_v2.key）。每个 cwd 一个 JSONL 缓冲文件，
 * 存 PostToolUse 的 {tool_name, tool_input, tool_response, captureTs}。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function pilotDataDir() {
  return process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
}

const BUFFER_DIR = path.join(pilotDataDir(), 'state', 'kiro-cli', 'buffers');
const PRE_TOOL_BUFFER_DIR = path.join(pilotDataDir(), 'state', 'kiro-cli', 'pre-tool-buffers');
const OFFSET_DIR = path.join(pilotDataDir(), 'state', 'kiro-cli', 'offsets');
const SESSION_OFFSET_DIR = path.join(pilotDataDir(), 'state', 'kiro-cli', 'session-offsets');
const EMITTED_STEPS_DIR = path.join(pilotDataDir(), 'state', 'kiro-cli', 'emitted-steps');
const TURN_COUNT_DIR = path.join(pilotDataDir(), 'state', 'kiro-cli', 'turn-counts');
const PENDING_STOPS_DIR = path.join(pilotDataDir(), 'state', 'kiro-cli', 'pending-stops');

function safeKey(cwd) {
  return Buffer.from(String(cwd || 'unknown')).toString('base64url');
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
  return dir;
}

function bufferFile(cwd) {
  return path.join(ensureDir(BUFFER_DIR), `${safeKey(cwd)}.jsonl`);
}

function preToolBufferFile(cwd) {
  return path.join(ensureDir(PRE_TOOL_BUFFER_DIR), `${safeKey(cwd)}.jsonl`);
}

/**
 * 追加一条 PostToolUse 事件到 per-cwd 缓冲。
 */
export function appendToolEvent(cwd, entry) {
  const file = bufferFile(cwd);
  try {
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // fail-open
  }
}

/**
 * 回收上次 drain 崩溃遗留的 .drain.<pid> 文件。
 * 进程在 rename→unlink 之间崩溃（或被 SIGKILL）会留下 .drain.* 文件，
 * 内含的 tool 事件（tool_response / startTs）是 transcript 拿不到的唯一产出，
 * 不回收则永久丢失。在每次 drain 前扫描同目录下的旧 .drain.*，读取并入本次结果。
 */
function recoverStaleDrainFiles(dir, baseFile) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return out;
  }
  const baseName = path.basename(baseFile);
  for (const f of entries) {
    // 匹配 <baseFile>.drain.<pid> 格式
    if (!f.startsWith(baseName + '.drain.')) continue;
    const full = path.join(dir, f);
    try {
      const raw = fs.readFileSync(full, 'utf-8');
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try { out.push(JSON.parse(t)); } catch { /* skip malformed */ }
      }
    } catch { /* read failed, skip */ }
    try { fs.unlinkSync(full); } catch { /* ignore */ }
  }
  return out;
}

/**
 * 读出并清空 per-cwd 缓冲（rename-then-read 原子化，防并发 hook 丢事件）。
 * @returns {Array<{toolName:string, toolInput:object, toolResponse:any, captureTs:string}>}
 */
export function drainToolEvents(cwd) {
  const file = bufferFile(cwd);
  const dir = path.dirname(file);
  // 先回收上次 drain 崩溃遗留的 .drain.* 文件
  const out = recoverStaleDrainFiles(dir, file);
  const tmp = file + '.drain.' + process.pid;
  try {
    fs.renameSync(file, tmp);
  } catch {
    return out;
  }
  let raw = '';
  try {
    raw = fs.readFileSync(tmp, 'utf-8');
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return out;
  }
  try {
    fs.unlinkSync(tmp);
  } catch {
    // ignore
  }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // skip malformed
    }
  }
  return out;
}

/**
 * 追加一条 PreToolUse 事件到 per-cwd 独立缓冲（与 postToolUse 分开 drain）。
 */
export function appendPreToolEvent(cwd, entry) {
  const file = preToolBufferFile(cwd);
  try {
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // fail-open
  }
}

/**
 * 读出并清空 per-cwd PreToolUse 缓冲（rename-then-read 原子化）。
 * @returns {Array<{toolName:string, toolInput:object, startTs:string}>}
 */
export function drainPreToolEvents(cwd) {
  const file = preToolBufferFile(cwd);
  const dir = path.dirname(file);
  // 先回收上次 drain 崩溃遗留的 .drain.* 文件
  const out = recoverStaleDrainFiles(dir, file);
  const tmp = file + '.drain.' + process.pid;
  try {
    fs.renameSync(file, tmp);
  } catch {
    return out;
  }
  let raw = '';
  try {
    raw = fs.readFileSync(tmp, 'utf-8');
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return out;
  }
  try {
    fs.unlinkSync(tmp);
  } catch {
    // ignore
  }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip malformed */ }
  }
  return out;
}

// ─── per-cwd transcript offset（updated_at 增量游标）───

function offsetFile(cwd) {
  return path.join(ensureDir(OFFSET_DIR), `${safeKey(cwd)}.json`);
}

/**
 * 读取某 cwd 上次已上报的 updated_at（毫秒）。
 */
export function loadOffset(cwd) {
  const file = offsetFile(cwd);
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      return typeof data?.updatedMs === 'number' ? data.updatedMs : 0;
    }
  } catch {
    // ignore
  }
  return 0;
}

/**
 * 记录某 cwd 已上报到的 updated_at。
 */
export function saveOffset(cwd, updatedMs) {
  const file = offsetFile(cwd);
  const dir = path.dirname(file);
  const tmp = path.join(dir, `${safeKey(cwd)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify({ updatedMs }), 'utf-8');
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.writeFileSync(file, JSON.stringify({ updatedMs }), 'utf-8');
    } catch {
      // ignore
    }
  }
}

// ─── per-cwd session offset（session JSONL 增量游标）───

function sessionOffsetFile(cwd) {
  return path.join(ensureDir(SESSION_OFFSET_DIR), `${safeKey(cwd)}.json`);
}

export function loadSessionOffset(cwd) {
  const file = sessionOffsetFile(cwd);
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      return typeof data?.updatedMs === 'number' ? data.updatedMs : 0;
    }
  } catch {
    // ignore
  }
  return 0;
}

export function saveSessionOffset(cwd, updatedMs) {
  const file = sessionOffsetFile(cwd);
  const dir = path.dirname(file);
  const tmp = path.join(dir, `${safeKey(cwd)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify({ updatedMs }), 'utf-8');
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.writeFileSync(file, JSON.stringify({ updatedMs }), 'utf-8');
    } catch {
      // ignore
    }
  }
}

// ─── per-cwd step-level idempotent dedup (multi-conversation) ───
//
// 交互式模式下 stop hook 可能多次触发。若 SQLite 行的 updated_at 在两次
// stop 之间发生变化（kiro-cli 延迟写入），offset 机制失效，整个会话的所有
// step 被重新读取并发射。此处按 (conversationId + stepId) 做幂等去重：
// 已发射的 stepId 在后续 stop 中被跳过。
//
// 存储格式（v2，多会话）：
//   {"conversations": {"<convId>": ["stepId1", "stepId2", ...], ...}}
// 向后兼容 v1 格式：
//   {"conversationId": "<convId>", "stepIds": [...]}

function emittedStepsFile(cwd) {
  return path.join(ensureDir(EMITTED_STEPS_DIR), `${safeKey(cwd)}.json`);
}

/**
 * 读取 per-cwd 的已发射 step 去重状态。
 * @returns {Map<string, Set<string>>} conversationId → stepIds
 */
export function loadEmittedSteps(cwd) {
  const file = emittedStepsFile(cwd);
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const map = new Map();

      // v2 format: {conversations: {convId: [stepIds]}}
      if (data.conversations && typeof data.conversations === 'object') {
        for (const [convId, ids] of Object.entries(data.conversations)) {
          map.set(convId, new Set(Array.isArray(ids) ? ids : []));
        }
        return map;
      }

      // v1 backward compat: {conversationId, stepIds}
      if (typeof data.conversationId === 'string' && Array.isArray(data.stepIds)) {
        map.set(data.conversationId, new Set(data.stepIds));
        return map;
      }
    }
  } catch {
    // ignore
  }
  return new Map();
}

/**
 * 合并写入 per-cwd 的已发射 step 去重状态。
 * 读取现有 Map → 合并新 stepIds → 原子写回。
 */
export function saveEmittedSteps(cwd, conversationId, newStepIds) {
  const file = emittedStepsFile(cwd);
  const existing = loadEmittedSteps(cwd);
  const current = existing.get(conversationId) || new Set();
  for (const id of newStepIds) {
    if (id) current.add(id);
  }
  existing.set(conversationId, current);

  const payload = {
    conversations: Object.fromEntries(
      [...existing].map(([k, v]) => [k, [...v]]),
    ),
  };
  const dir = path.dirname(file);
  const tmp = path.join(dir, `${safeKey(cwd)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf-8');
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.writeFileSync(file, JSON.stringify(payload), 'utf-8');
    } catch {
      // ignore
    }
  }
}

// ─── per-cwd turn 计数（跨 stop 递增，保证 gen_ai.turn.id 每轮不同）───

function turnCountFile(cwd) {
  return path.join(ensureDir(TURN_COUNT_DIR), `${safeKey(cwd)}.json`);
}

export function loadTurnCount(cwd) {
  const file = turnCountFile(cwd);
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      return typeof data?.count === 'number' ? data.count : 0;
    }
  } catch {
    // ignore
  }
  return 0;
}

export function saveTurnCount(cwd, count) {
  const file = turnCountFile(cwd);
  const dir = path.dirname(file);
  const tmp = path.join(dir, `${safeKey(cwd)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify({ count }), 'utf-8');
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.writeFileSync(file, JSON.stringify({ count }), 'utf-8');
    } catch {
      // ignore
    }
  }
}

// ─── pending-stops 队列（stop hook → delayed sidecar scan）───
//
// stop hook 触发时把元信息（cwd / 时间 / offset / assistant_response）作为一个
// 文件投递到 PENDING_STOPS_DIR/ready/，立即返回 {}，不阻塞 kiro-cli。
//
// 主服务侧的 KiroCliSessionInput 每 30s 轮询此目录：
//   - 满足成熟条件（now - stop_unix_ms >= MATURE_MS）→ rename 到 inflight/，
//     调用 delayedCollect 子命令把成熟样本转成 hook JSONL；成功后删除文件。
//   - 未成熟 → 跳过，下一轮再试。
//   - 超过 MAX_AGE_MS 仍未成熟 → 强制 fallback（由 delayedCollect 内部决定）。
//
// 文件命名: `${pad(enqueueMs, 13)}-${pid}-${counter}.json`
// 内容字段:
//   cwd               string  (path)
//   stopUnixMs        number  (stop hook 触发时刻)
//   sinceMs           number  (loadOffset 快照，传给 SQLite 路径)
//   sessionSinceMs    number  (loadSessionOffset 快照，传给 session JSONL 路径)
//   assistantResponse string? (stop event 自带 assistant_response，作为合成兜底)
//   userId            string  (从 hook runtime config 解析)
//   schemaVersion     1

const PENDING_READY = path.join(PENDING_STOPS_DIR, 'ready');
const PENDING_INFLIGHT = path.join(PENDING_STOPS_DIR, 'inflight');

let _enqueueCounter = 0;
function nextEnqueueId() {
  _enqueueCounter = (_enqueueCounter + 1) & 0xffff;
  return _enqueueCounter;
}

function pendingFilename(enqueueMs) {
  return `${String(enqueueMs).padStart(13, '0')}-${process.pid}-${nextEnqueueId()}.json`;
}

/**
 * stop hook 调用：把一条待延迟处理的 stop 记录入队。
 */
export function enqueuePendingStop(record) {
  ensureDir(PENDING_READY);
  ensureDir(PENDING_INFLIGHT);
  const enqueueMs = Date.now();
  const name = pendingFilename(enqueueMs);
  const file = path.join(PENDING_READY, name);
  const tmp = file + '.tmp';
  const payload = JSON.stringify({ schemaVersion: 1, enqueueMs, ...record });
  try {
    fs.writeFileSync(tmp, payload, 'utf-8');
    fs.renameSync(tmp, file);
    return file;
  } catch {
    try {
      fs.writeFileSync(file, payload, 'utf-8');
      return file;
    } catch {
      return null;
    }
  }
}

/**
 * input 层调用：列出所有就绪 pending 记录。返回 `[{ path, record }, ...]`，
 * 按 enqueueMs 升序。读取失败的文件忽略。
 */
export function listPendingStops() {
  ensureDir(PENDING_READY);
  let names;
  try {
    names = fs.readdirSync(PENDING_READY);
  } catch {
    return [];
  }
  const items = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name.endsWith('.tmp')) continue;
    const filePath = path.join(PENDING_READY, name);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const record = JSON.parse(raw);
      items.push({ path: filePath, record });
    } catch {
      // 读取失败 → 删掉，避免反复污染
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    }
  }
  items.sort((a, b) => (a.record?.enqueueMs || 0) - (b.record?.enqueueMs || 0));
  return items;
}

/**
 * input 层调用：声明对某条 pending 的处理权（原子 rename 到 inflight/）。
 * 返回 inflight 后的文件路径，或 null（被别人抢先）。
 */
export function claimPendingStop(readyPath) {
  ensureDir(PENDING_INFLIGHT);
  const base = path.basename(readyPath);
  const inflightPath = path.join(PENDING_INFLIGHT, base);
  try {
    fs.renameSync(readyPath, inflightPath);
    return inflightPath;
  } catch {
    return null;
  }
}

/**
 * input 层调用：归还（处理完成或永久放弃）。直接删除 inflight 文件。
 */
export function finishPendingStop(inflightPath) {
  try {
    fs.unlinkSync(inflightPath);
  } catch {
    // ignore
  }
}

/**
 * input 层调用：把 inflight 退回 ready（让下一轮再试）。
 */
export function releasePendingStop(inflightPath) {
  const base = path.basename(inflightPath);
  const readyPath = path.join(PENDING_READY, base);
  try {
    fs.renameSync(inflightPath, readyPath);
  } catch {
    // 若 rename 失败，至少别留死锁：把 inflight 删除
    try { fs.unlinkSync(inflightPath); } catch { /* ignore */ }
  }
}

/**
 * 启动时清理：把残留在 inflight/ 的记录全部退回 ready/（前一进程没干完）。
 */
export function recoverInflightPendingStops() {
  ensureDir(PENDING_INFLIGHT);
  ensureDir(PENDING_READY);
  let names;
  try {
    names = fs.readdirSync(PENDING_INFLIGHT);
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const inflightPath = path.join(PENDING_INFLIGHT, name);
    const readyPath = path.join(PENDING_READY, name);
    try {
      fs.renameSync(inflightPath, readyPath);
      n++;
    } catch {
      // 同名 ready 已存在 → 重复入队，删除 inflight 的副本
      try { fs.unlinkSync(inflightPath); } catch { /* ignore */ }
    }
  }
  return n;
}
