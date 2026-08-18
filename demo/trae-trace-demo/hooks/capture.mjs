#!/usr/bin/env node
/**
 * TRAE CN Hook 捕获脚本（埋点入口）
 *
 * TRAE 通过 stdin 传入 JSON payload 调用本脚本。由于 TRAE 的 hook payload
 * schema 尚未经官方文档确认，本脚本刻意做成 **schema 无关**：
 * 原样落盘收到的一切，解析交给下游 build-trace，避免因字段猜错而丢数据。
 *
 * 安全底线（务必保持）：
 * 1. 永远 exit 0 —— PreToolUse/PostToolUse 的非零退出会阻断 TRAE 的工具执行
 * 2. 永远输出合法的放行 JSON —— 避免被解读为 block 决策
 * 3. 任何异常都吞掉 —— 埋点不能让用户的 IDE 卡住
 *
 * 用法（由 hooks.json 配置调用）：
 *   node capture.mjs --event PreToolUse
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO_ROOT = path.resolve(HERE, '..');
const DATA_DIR = process.env.TRAE_DEMO_DATA_DIR || path.join(DEMO_ROOT, '.data');
const OUT_FILE = path.join(DATA_DIR, 'hook-events.jsonl');

/** 从 --event <name> 取事件名；取不到则回落到环境变量或 unknown */
function resolveEventName() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--event');
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  return process.env.TRAE_HOOK_EVENT || 'unknown';
}

/** 读完整 stdin；TRAE 未传 stdin 时返回空串而不是挂住 */
function readStdin() {
  return new Promise(resolve => {
    if (process.stdin.isTTY) return resolve('');
    let buf = '';
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve(buf);
      }
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => {
      buf += c;
      // 防御：单次 hook payload 超过 8MB 就截断，避免把内存吃爆
      if (buf.length > 8 * 1024 * 1024) done();
    });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
    // 兜底超时：2s 内没有 end 就用已读到的内容
    setTimeout(done, 2000);
  });
}

/**
 * 极简脱敏：仅处理明确的凭证字段。
 * demo 阶段刻意保守 —— 只遮蔽有把握的键，避免误伤 prompt/结果内容。
 */
const SECRET_KEY_RE = /^(ak|sk|token|secret|password|passwd|api_?key|session_token|authorization)$/i;

function maskSecrets(value, depth = 0) {
  if (depth > 12 || value == null) return value;
  if (Array.isArray(value)) return value.map(v => maskSecrets(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_RE.test(k) && v ? '***MASKED***' : maskSecrets(v, depth + 1);
    }
    return out;
  }
  return value;
}

async function main() {
  const event = resolveEventName();
  const raw = await readStdin();

  let parsed = null;
  let parseError = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch (err) {
    parseError = String(err && err.message ? err.message : err);
  }

  const record = {
    // 本地捕获时刻（ms）—— 构建 span 时间轴的兜底锚点
    captured_at: Date.now(),
    captured_at_iso: new Date().toISOString(),
    // hook 事件名：优先用 payload 自带的 hook_event_name，其次用 --event
    event: (parsed && (parsed.hook_event_name || parsed.hookEventName)) || event,
    event_from_arg: event,
    pid: process.pid,
    // payload 原文（解析成功则存结构化，失败则存原始串以便排查 schema）
    payload: parsed ? maskSecrets(parsed) : null,
    raw: parsed ? undefined : raw.slice(0, 200000),
    parse_error: parseError || undefined,
  };

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // 单行 JSON 追加写；换行在前缀不需要，JSONL 以 \n 结尾即可
    fs.appendFileSync(OUT_FILE, JSON.stringify(record) + os.EOL, 'utf8');
  } catch {
    /* 落盘失败也不能影响 TRAE，静默忽略 */
  }
}

// 无论如何都放行 + exit 0
main()
  .catch(() => {})
  .finally(() => {
    try {
      process.stdout.write(JSON.stringify({ continue: true }));
    } catch {
      /* ignore */
    }
    process.exit(0);
  });
