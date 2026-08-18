/**
 * 解析 hook 产出的事件，两个数据源：
 *
 * 1. **pilot 正式 hook**（推荐）：`~/.loongsuite-pilot/logs/trae-cn/history/*.jsonl`
 *    由 assets/hooks/trae-cn-hook-processor.mjs 产出，已按仓库 GenAI 语义规范归一化
 *    （gen_ai.* 字段 + 轮次串联），还带思考过程。
 * 2. **demo capture.mjs**（兜底）：`.data/hook-events.jsonl`，原始 payload 直落，
 *    用于 TRAE hook schema 与预期不符时反推真实结构。
 *
 * 两者归一到同一内部形状后合并，下游无需关心来源。
 */
import fs from 'node:fs';
import path from 'node:path';
import { HOOK_EVENTS_FILE, PILOT_HISTORY_DIR } from './config.mjs';

/** 在对象中按候选路径深度查找第一个非空值 */
function firstOf(obj, candidates) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of candidates) {
    const v = deepGet(obj, key);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function deepGet(obj, dotted) {
  const parts = dotted.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * 候选字段名清单：官方字段名优先（见方案文档 §2.7），其余是 camelCase / 嵌套形态的兼容。
 * 注意 `message` 不列入 prompt 候选：它是 Notification 的通知正文，误读会把通知当成用户 prompt 展示。
 */
const FIELDS = {
  session: ['session_id', 'sessionId', 'payload.session_id', 'conversation_id'],
  toolName: ['tool_name', 'toolName', 'tool.name', 'name'],
  toolInput: ['tool_input', 'toolInput', 'tool.input', 'input', 'arguments', 'params'],
  toolResult: [
    'tool_response',
    'toolResponse',
    'tool_result',
    'toolResult',
    'tool.result',
    'result',
    'output',
    'response',
  ],
  prompt: ['prompt', 'user_prompt', 'userPrompt', 'text'],
  cwd: ['cwd', 'workspace', 'workingDirectory'],
};

export function loadHookEvents(file = HOOK_EVENTS_FILE) {
  const out = [...loadPilotHookRecords()];

  if (fs.existsSync(file)) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      text = '';
    }
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      try {
        out.push(normalize(JSON.parse(s)));
      } catch {
        // 单行坏数据不影响整体
      }
    }
  }

  out.sort((a, b) => a.capturedAt - b.capturedAt);
  return out;
}

/** 读 pilot 正式 hook 的 GenAI 记录并归一到内部形状 */
function loadPilotHookRecords(dir = PILOT_HISTORY_DIR) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort();
  } catch {
    return [];
  }
  for (const f of files) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      try {
        const rec = normalizePilotRecord(JSON.parse(s));
        if (rec) out.push(rec);
      } catch {
        // 忽略坏行
      }
    }
  }
  return out;
}

/** 从 gen_ai.output.messages 的 parts 里抽取指定类型的文本 */
function partsText(messages, type) {
  if (!Array.isArray(messages)) return undefined;
  const chunks = [];
  for (const m of messages) {
    for (const p of m?.parts ?? []) {
      if (p?.type === type && typeof p.content === 'string' && p.content) chunks.push(p.content);
    }
  }
  return chunks.length ? chunks.join('\n') : undefined;
}

function normalizePilotRecord(r) {
  if (!r || typeof r !== 'object') return null;
  const eventName = r['event.name'];
  // 原始埋点时机（PreToolUse 等）；旧记录缺失时从 GenAI 事件名反推
  const event = r['agent.trae.hook_event_name'] || ({
    'llm.request': 'UserPromptSubmit',
    'tool.call': 'PreToolUse',
    'tool.result': 'PostToolUse',
    'llm.response': 'Stop',
  })[eventName] || 'unknown';

  const nano = Number(r.time_unix_nano || r.observed_time_unix_nano || 0);
  const inputMessages = r['gen_ai.input.messages'];
  const outputMessages = r['gen_ai.output.messages'];

  return {
    capturedAt: nano ? Math.round(nano / 1e6) : 0,
    event,
    source: 'pilot',
    eventName,
    sessionId: r['gen_ai.session.id'] || null,
    turnId: r['gen_ai.turn.id'] || null,
    traceId: r.trace_id || null,
    toolName: r['gen_ai.tool.name'] ?? null,
    toolCallId: r['gen_ai.tool.call.id'] ?? null,
    toolInput: r['gen_ai.tool.call.arguments'],
    toolResult: r['gen_ai.tool.call.result'],
    toolStatus: r['tool.result.status'] ?? null,
    statusSource: r['agent.trae.status_source'] ?? null,
    toolSeq: r['agent.trae.tool_seq'] ?? null,
    durationMs: r['gen_ai.tool.call.duration'] ?? null,
    exitCode: r['agent.trae.exit_code'] ?? null,
    prompt: partsText(inputMessages, 'text') ?? null,
    // 思考过程：reasoning part
    reasoning: partsText(outputMessages, 'reasoning') ?? null,
    responseText: partsText(outputMessages, 'text') ?? null,
    finishReason: Array.isArray(r['gen_ai.response.finish_reasons'])
      ? r['gen_ai.response.finish_reasons'][0]
      : null,
    usage: {
      input: r['gen_ai.usage.input_tokens'] ?? null,
      output: r['gen_ai.usage.output_tokens'] ?? null,
      total: r['gen_ai.usage.total_tokens'] ?? null,
    },
    model: r['gen_ai.response.model'] || r['gen_ai.request.model'] || null,
    cwd: r['workspace.path'] ?? null,
    payload: r,
    raw: null,
    parseError: null,
  };
}

function normalize(rec) {
  const p = rec.payload || {};
  return {
    capturedAt: Number(rec.captured_at) || 0,
    event: rec.event || rec.event_from_arg || 'unknown',
    sessionId: firstOf(p, FIELDS.session) ?? null,
    toolName: firstOf(p, FIELDS.toolName) ?? null,
    toolInput: firstOf(p, FIELDS.toolInput),
    toolResult: firstOf(p, FIELDS.toolResult),
    prompt: firstOf(p, FIELDS.prompt) ?? null,
    cwd: firstOf(p, FIELDS.cwd) ?? null,
    // 原始 payload 保留，前端可展开查看真实 schema
    payload: rec.payload ?? null,
    raw: rec.raw ?? null,
    parseError: rec.parse_error ?? null,
  };
}

/**
 * 构建 hook 事件索引。
 *
 * 工具事件优先用 **tool_call_id 精确 join**：日志的
 * `[handle_stream] ToolCall arrived: toolcall_id=call_xxx` 与 hook 的 `tool_use_id`
 * 是同一个值，比「工具名 + 时间窗」可靠得多——同一轮里反复调用同名工具（比如
 * 连读三个文件）时，时间窗会把参数和结果串到错的 span 上。
 * 只在拿不到 id 时才降级到时间窗。
 */
export function indexHookEvents(events) {
  const TOLERANCE_MS = 5000;

  const toolEvents = events.filter(
    e => e.event === 'PreToolUse' || e.event === 'PostToolUse',
  );
  const promptEvents = events.filter(e => e.event === 'UserPromptSubmit');
  const stopEvents = events.filter(e => e.event === 'Stop' || e.eventName === 'llm.response');

  /** 把一组 Pre/Post 事件归并成一份工具详情 */
  function mergeToolHits(hits, matchedBy) {
    if (hits.length === 0) return null;
    const pre = hits.find(h => h.event === 'PreToolUse');
    const post = hits.find(h => h.event === 'PostToolUse');
    const result = {
      events: hits.map(h => h.event),
      matchedBy,
      sessionId: (post && post.sessionId) || (pre && pre.sessionId) || null,
    };
    if (pre && pre.toolInput !== undefined) result.arguments = pre.toolInput;
    if (post && post.toolResult !== undefined) result.result = post.toolResult;
    // Post 事件也可能同时带 input
    if (result.arguments === undefined && post && post.toolInput !== undefined) {
      result.arguments = post.toolInput;
    }
    // pilot hook 还能提供状态 / exit_code / tool_call_id
    const rich = post || pre;
    if (rich) {
      if (rich.toolStatus) result.status = rich.toolStatus;
      if (rich.exitCode !== null && rich.exitCode !== undefined) result.exitCode = rich.exitCode;
      if (rich.toolCallId) result.toolCallId = rich.toolCallId;
      if (rich.durationMs != null) result.durationMs = rich.durationMs;
      if (rich.statusSource) result.statusSource = rich.statusSource;
    }
    return result;
  }

  return {
    all: events,
    /**
     * 为某个 TOOL span 找配对的 hook 事件（Pre 提供参数，Post 提供结果）。
     * toolCallId 有值时用它精确匹配，不再看时间。
     */
    matchTool(toolName, startMs, endMs, toolCallId) {
      if (toolCallId) {
        const exact = toolEvents.filter(e => e.toolCallId === toolCallId);
        if (exact.length > 0) return mergeToolHits(exact, 'tool_call_id');
      }
      const lo = startMs - TOLERANCE_MS;
      const hi = endMs + TOLERANCE_MS;
      const hits = toolEvents.filter(
        e =>
          (e.toolName == null || e.toolName === toolName) &&
          e.capturedAt >= lo &&
          e.capturedAt <= hi,
      );
      return mergeToolHits(hits, 'name+time_window');
    },
    /** 为轮次找 Stop 事件：思考过程 + 助手回复 + token 用量 */
    matchResponse(startMs, endMs) {
      const hits = stopEvents.filter(
        e => e.capturedAt >= startMs - TOLERANCE_MS && e.capturedAt <= endMs + 60000,
      );
      if (hits.length === 0) return null;
      // 取时间上最接近轮次结束的那条
      hits.sort((a, b) => Math.abs(a.capturedAt - endMs) - Math.abs(b.capturedAt - endMs));
      return hits[0];
    },
    /** 为某个 ENTRY span 找对应的用户 prompt */
    matchPrompt(startMs, endMs) {
      const lo = startMs - 60000; // prompt 在轮次开始前提交，窗口放宽
      const hi = endMs;
      const hits = promptEvents.filter(e => e.capturedAt >= lo && e.capturedAt <= hi);
      if (hits.length === 0) return null;
      // 取时间上最接近轮次开始的那条
      hits.sort((a, b) => Math.abs(a.capturedAt - startMs) - Math.abs(b.capturedAt - startMs));
      return hits[0];
    },
  };
}
