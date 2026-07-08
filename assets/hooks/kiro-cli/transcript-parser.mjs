// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * transcript-parser.mjs — Kiro CLI transcript 解析。
 *
 * 数据源：~/.local/share/kiro-cli/data.sqlite3 表 conversations_v2
 *   - key             = 会话的 cwd（hook 的 cwd 对应这里的 key）
 *   - conversation_id = 会话 id（gen_ai.session.id / conversation.id）
 *   - value           = JSON 文本，结构同 round3 conv_raw.json
 *
 * STEP 骨干 = value.history[]（round3 实证：requests[] 丢弃最终回答步，
 *   history[] 才是完整 STEP 主干，含最后一条 assistant.Response）。
 *
 * 字段映射（round3 实证，request_id ≠ message_id，各取各字段）：
 *   gen_ai.step.id        ← history[i].request_metadata.request_id
 *   gen_ai.response.id     ← history[i].request_metadata.message_id
 *   gen_ai.tool.call.id    ← history[i].assistant.<ToolUse>.tool_uses[].id
 *   gen_ai.conversation.id ← value.conversation_id / value.user_turn_metadata.continuation_id
 *
 * token：transcript 中 total_tokens/uncached_input_tokens/output_tokens/cache_*
 *   全部恒 null（AWS CodeWhisperer 后端只回吐 credit，不回吐 token），
 *   故 usage.input/output_tokens 保持 null，不臆造 0；credit 从 usage_info 取。
 *
 * 导出 parseTranscript(dbPath, cwd, sinceUpdatedMs)：
 *   - 自 db 读 key=cwd 的最新一行（updated_at > sinceUpdatedMs）
 *   - 返回 { steps, conversationId, continuationId, modelId, credits, nextUpdatedMs } | null
 *     steps: StepInfo[]（按 request_start_timestamp_ms 升序）
 */

import { createRequire } from 'node:module';
import { resolveDbPath } from './db-path.mjs';

// node:sqlite 是 Node ≥ 22.5 的实验内置模块。顶层 require 会让本模块在
// Node 18/20 上 import 即崩（ERR_UNKNOWN_BUILTIN_MODULE），且本模块被单测和
// hook-processor 在顶层 import，故惰性加载到 queryReadonly() 内首次调用时取，
// 保证模块在所有 Node 版本可 import、无 builtin 时 hook fail-open。
// 用 createRequire 取，避免被 vite/vitest 静态 transform 误解析为 url "sqlite"。
let _DatabaseSync = undefined;

function loadDatabaseSync() {
  if (_DatabaseSync !== undefined) return _DatabaseSync;
  const req = createRequire(import.meta.url);
  _DatabaseSync = req('node:sqlite').DatabaseSync;
  return _DatabaseSync;
}

/** 运行时是否可用 node:sqlite（探针，供测试决定 DB 用例跑或 skip）。 */
export function hasNodeSqlite() {
  try {
    loadDatabaseSync();
    return true;
  } catch {
    return false;
  }
}

/**
 * @typedef {object} ToolUseInfo
 * @property {string} id        tool_use_id（gen_ai.tool.call.id）
 * @property {string} name      工具名（fs_read / fs_write / ...）
 * @property {any} args        工具入参（用于 hook→transcript 匹配）
 */

/**
 * @typedef {object} StepInfo
 * @property {string} stepId        request_id（gen_ai.step.id）
 * @property {string} responseId    message_id（gen_ai.response.id）
 * @property {'ToolUse'|'NotToolUse'} kind
 * @property {string} modelId
 * @property {number} startTimeMs   request_start_timestamp_ms
 * @property {number} endTimeMs     stream_end_timestamp_ms
 * @property {ToolUseInfo[]} tools 该步声明的工具调用（仅 ToolUse 步）
 * @property {string} assistantText 最终文本内容（NotToolUse 步取 Response.content；
 *                                   ToolUse 步为 ""，由 caller 合成 tool_call 摘要）
 * @property {string} userPrompt  该步 user turn 的原始 prompt（仅首轮 Prompt 型 entry 非空，
 *                                ToolUseResults 型为 ''）
 * @property {string[]} toolUseResults 该步 user turn 的 ToolUseResults 文本列表（仅后续轮有值）
 * @property {number} [creditIndex] 对齐到 user_turn_metadata.usage_info[] 的下标
 * @property {number} index         在 history 中的序号（用于 credit 对齐）
 */

/**
 * @typedef {object} TranscriptData
 * @property {string} conversationId
 * @property {string} continuationId
 * @property {string} modelId
 * @property {StepInfo[]} steps
 * @property {number[]} credits       usage_info[].value（与 history 等长对齐）
 * @property {number} updatedMs
 */

/**
 * 打开只读 sqlite 连接查询。使用 Node 内置 node:sqlite（DatabaseSync），
 * 避免 deployed hooks 目录无 node_modules 依赖。
 * 包成 Promise 以保持 async 调用风格。
 */
function queryReadonly(dbPath, sql, params = []) {
  return new Promise((resolve, reject) => {
    let db;
    try {
      const DatabaseSync = loadDatabaseSync();
      db = new DatabaseSync(dbPath, { readOnly: true });
    } catch (openErr) {
      reject(openErr);
      return;
    }
    try {
      const stmt = db.prepare(sql);
      const rows = stmt.all(...params);
      db.close();
      resolve(rows);
    } catch (queryErr) {
      try { db.close(); } catch {}
      reject(queryErr);
    }
  });
}

/**
 * 从 assistant 节点中抽取所有 tool_uses。assistant 形如：
 *   { "ToolUse": { "message_id", "content", "tool_uses": [{id,name,args}] } }
 *   { "Response": { "message_id", "content" } }
 */
function extractToolUses(assistant) {
  if (!assistant || typeof assistant !== 'object') return [];
  const tu = assistant.ToolUse;
  if (!tu || typeof tu !== 'object') return [];
  const list = Array.isArray(tu.tool_uses) ? tu.tool_uses : [];
  return list
    .filter((t) => t && typeof t === 'object')
    .map((t) => ({
      id: typeof t.id === 'string' ? t.id : '',
      name: typeof t.name === 'string' ? t.name : 'unknown',
      args: t.orig_args ?? t.args ?? {},
    }))
    .filter((t) => t.id);
}

function extractAssistantText(assistant) {
  if (!assistant || typeof assistant !== 'object') return '';
  const r = assistant.Response;
  if (r && typeof r === 'string') return r;
  if (r && typeof r.content === 'string') return r.content;
  if (r && typeof r === 'object' && typeof r.content === 'string') return r.content;
  return '';
}

function num(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function str(value, fallback = '') {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/**
 * 从 history entry 的 user.content.ToolUseResults 提取工具结果文本列表。
 * 实证结构（round3）：
 *   entry.user.content.ToolUseResults.tool_use_results[].content[].Text
 * @returns {string[]} 每条 tool_use_result 的拼接文本；非 ToolUseResults 型返回 []。
 */
/**
 * 从单个 ToolUseResult content 项提取可读文本。
 * kiro-cli 的工具结果 content 有两种类型：
 *   - {Text: "string"}                 builtin/简单结果
 *   - {Json: {content:[{type:"text",text:"..."}], structuredContent:{...}}}
 *                                       MCP 工具（@filesystem/list_directory 等）
 * 旧逻辑只取 Text，Json 被跳过 → toolUseResults 为空 → input.messages 丢失。
 */
function extractToolResultContentText(item) {
  if (!item || typeof item !== 'object') return '';
  if (typeof item.Text === 'string') return item.Text;
  const j = item.Json;
  if (j && typeof j === 'object') {
    // 优先取 MCP text 块：Json.content[].text
    if (Array.isArray(j.content)) {
      const texts = j.content
        .filter((c) => c && typeof c === 'object' && typeof c.text === 'string')
        .map((c) => c.text);
      if (texts.length > 0) return texts.join('\n');
    }
    // 其次 structuredContent.content（字符串）
    if (j.structuredContent && typeof j.structuredContent.content === 'string') {
      return j.structuredContent.content;
    }
    // 兜底：整体 stringify（避免下游 [object Object]）
    try { return JSON.stringify(j); } catch { return ''; }
  }
  return '';
}

function extractToolUseResults(entry) {
  const content = entry?.user?.content;
  if (!content || typeof content !== 'object') return [];
  // kiro-cli 把工具结果放两种 key 下：
  //   - ToolUseResults（正常完成）
  //   - CancelledToolUses（取消/中断，但仍有 tool_use_results + prompt）
  // 两者结构相同（{tool_use_results:[{tool_use_id,content,status}]}），都要提取，
  // 否则 CancelledToolUses 的 step toolUseResults 为空 → input.messages 丢失。
  const tur = content.ToolUseResults || content.CancelledToolUses;
  if (!tur || typeof tur !== 'object') return [];
  const results = Array.isArray(tur.tool_use_results) ? tur.tool_use_results : [];
  const out = [];
  for (const r of results) {
    if (!r || typeof r !== 'object') continue;
    const contentArr = Array.isArray(r.content) ? r.content : [];
    const texts = contentArr
      .map(extractToolResultContentText)
      .filter((t) => typeof t === 'string' && t.length > 0);
    if (texts.length > 0) {
      out.push(texts.join('\n'));
    }
  }
  return out;
}

/**
 * 从 history entry 的 user.content 提取用户原始 prompt 文本。
 * 实证结构（round3 + tester E2E）：
 *   entry.user.content => { "Prompt": { "prompt": "<用户输入>" } }     // 首轮 user turn
 *   entry.user.content => { "ToolUseResults": { ... } }               // 后续轮（工具结果，无 prompt）
 * 兜底兼容：大小写不敏感（Prompt/prompt）、content 直接是 string、平铺 {prompt} 嵌套。
 * @returns {string} prompt 文本；非 Prompt 型返回 ''。
 */
function extractUserPrompt(entry) {
  const content = entry?.user?.content;
  if (!content || typeof content !== 'object') {
    return typeof content === 'string' ? content : '';
  }
  for (const key of Object.keys(content)) {
    if (key.toLowerCase() !== 'prompt') continue;
    const node = content[key];
    if (typeof node === 'string') return node;
    if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) {
        if (k.toLowerCase() === 'prompt' && typeof node[k] === 'string') return node[k];
      }
    }
  }
  return '';
}

/**
 * 解析单个会话的 value JSON，转成 steps。
 * @param {object} value  conversations_v2.value 解析后的对象
 * @returns {{ steps: StepInfo[], conversationId: string, continuationId: string, modelId: string, credits: number[] }}
 */
export function parseConversationValue(value) {
  const conversationId = str(value?.conversation_id);
  const utm = value?.user_turn_metadata || {};
  const continuationId = str(utm?.continuation_id);
  const modelId = str(value?.model_info?.model_id, str(value?.model_info?.model_name, 'auto'));

  const credits = Array.isArray(utm?.usage_info)
    ? utm.usage_info.map((u) => num(typeof u === 'object' ? u?.value : u))
    : [];

  const history = Array.isArray(value?.history) ? value.history : [];
  const steps = [];

  for (let i = 0; i < history.length; i++) {
    const entry = history[i];
    if (!entry || typeof entry !== 'object') continue;

    const assistant = entry.assistant || {};
    const rm = entry.request_metadata || {};
    const isToolUse = !!assistant.ToolUse;
    const isResponse = !!assistant.Response;
    if (!isToolUse && !isResponse) continue;

    const stepId = str(rm?.request_id);
    const responseId = str(rm?.message_id);
    const chatType = str(rm?.chat_conversation_type, isToolUse ? 'ToolUse' : 'NotToolUse');

    steps.push({
      index: i,
      stepId,
      responseId,
      kind: chatType === 'NotToolUse' || (!isToolUse && isResponse) ? 'NotToolUse' : 'ToolUse',
      modelId: str(rm?.model_id, modelId),
      startTimeMs: num(rm?.request_start_timestamp_ms),
      endTimeMs: num(rm?.stream_end_timestamp_ms),
      tools: isToolUse ? extractToolUses(assistant) : [],
      assistantText: isToolUse ? '' : extractAssistantText(assistant),
      userPrompt: extractUserPrompt(entry),
      toolUseResults: extractToolUseResults(entry),
      creditIndex: i < credits.length ? i : -1,
    });
  }

  steps.sort((a, b) => a.startTimeMs - b.startTimeMs);
  return { steps, conversationId, continuationId, modelId, credits };
}

/**
 * 读取指定 cwd 的最新会话 transcript。
 *
 * @param {string} cwd            hook cwd（对应 conversations_v2.key）
 * @param {object} [opts]
 * @param {string} [opts.dbPath]  显式 db 路径（默认走 resolveDbPath）
 * @param {number} [opts.sinceUpdatedMs]  仅取 updated_at > 此值的行；默认 0（取最新）
 * @returns {Promise<TranscriptData|null>}
 */
export async function readTranscriptForCwd(cwd, opts = {}) {
  if (!cwd) return null;
  const dbPath = opts.dbPath || resolveDbPath();
  const since = typeof opts.sinceUpdatedMs === 'number' ? opts.sinceUpdatedMs : 0;

  let rows;
  try {
    rows = await queryReadonly(
      dbPath,
      `SELECT conversation_id, value, updated_at
         FROM conversations_v2
        WHERE key = ?
          AND (? = 0 OR updated_at > ?)
        ORDER BY updated_at DESC
        LIMIT 1`,
      [cwd, since, since],
    );
  } catch (err) {
    throw new Error(`[kiro-cli-transcript] failed to query db ${dbPath}: ${err?.message || err}`);
  }

  if (!rows || rows.length === 0) return null;
  const row = rows[0];
  let value;
  try {
    value = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
  } catch {
    return null;
  }
  const parsed = parseConversationValue(value);
  if (parsed.steps.length === 0) return null;

  // NOTE on sinceUpdatedMs: row-level WHERE clause already discards stale
  // rows, and upstream `emitted-steps` state dedups individual steps when
  // conversations_v2 merges multiple runs into one row. We deliberately do
  // NOT add a step.endTimeMs > since filter here to keep the parser pure.
  return {
    conversationId: parsed.conversationId,
    continuationId: parsed.continuationId,
    modelId: parsed.modelId,
    steps: parsed.steps,
    credits: parsed.credits,
    updatedMs: num(row.updated_at),
  };
}

export { resolveDbPath, resolveDbDir } from './db-path.mjs';
