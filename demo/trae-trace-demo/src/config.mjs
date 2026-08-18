/**
 * TRAE CN Trace Demo — 路径与常量解析
 *
 * 设计约定：
 * - 不硬编码任何绝对路径，全部由 os.homedir() / import.meta.url 推导
 * - 所有路径均可用环境变量覆盖，便于换机器或换 TRAE 版本
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** demo 自身根目录（用于存放捕获到的 hook 事件） */
export const DEMO_ROOT = path.resolve(HERE, '..');
export const DATA_DIR = process.env.TRAE_DEMO_DATA_DIR || path.join(DEMO_ROOT, '.data');
export const HOOK_EVENTS_FILE = path.join(DATA_DIR, 'hook-events.jsonl');

/**
 * pilot 正式 hook 的产出目录。
 * assets/hooks/trae-cn-hook-processor.mjs 会把符合 GenAI 语义规范的记录写到这里，
 * 比 demo 自带的 capture.mjs 多了归一化与轮次串联，是推荐数据源。
 */
export const PILOT_DATA_DIR =
  process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
export const PILOT_HISTORY_DIR = path.join(PILOT_DATA_DIR, 'logs', 'trae-cn', 'history');

/** TRAE CN 应用数据根目录 */
export const TRAE_SUPPORT_DIR =
  process.env.TRAE_SUPPORT_DIR ||
  path.join(os.homedir(), 'Library', 'Application Support', 'Trae CN');

export const TRAE_LOGS_DIR = path.join(TRAE_SUPPORT_DIR, 'logs');

/** 演示默认聚焦的 session（可用 ?session= 或环境变量覆盖） */
export const DEFAULT_SESSION_ID =
  process.env.TRAE_DEMO_SESSION_ID || '6a82baade5152afe53a9612c';

export const PORT = Number(process.env.TRAE_DEMO_PORT || 8799);

/**
 * TRAE 每次启动新建一个 logs/<YYYYMMDDTHHmmss>/ 目录。
 * 注意：**不能按目录 mtime 排序** —— .DS_Store 等无关文件会把旧目录的 mtime 顶上去。
 * 活跃日志是正在被持续写入的那个，按 **日志文件自身的 mtime** 排序，同时取大。
 */
export function findLatestLogSession() {
  if (!fs.existsSync(TRAE_LOGS_DIR)) return null;

  // 允许回放历史日志目录（如 20260817T153924）：验证旧会话、或重现只在某次
  // 启动里出现过的工具（比如 WebSearch / OpenPreview）时必需，否则只能看到活跃日志。
  const pinned = process.env.TRAE_DEMO_LOG_SESSION;
  if (pinned) {
    const dir = path.join(TRAE_LOGS_DIR, pinned);
    const modular = path.join(dir, 'Modular');
    if (fs.existsSync(modular)) {
      const hit = fs
        .readdirSync(modular)
        .filter(f => /^ai-agent_.*_stdout\.log$/.test(f))
        .map(f => {
          const p = path.join(modular, f);
          return { p, size: safeSize(p), mtime: safeMtime(p) };
        })
        .sort((a, b) => b.mtime - a.mtime || b.size - a.size)[0];
      if (hit && hit.size > 0) {
        return { name: pinned, dir, modular, agentLog: hit.p, logMtime: hit.mtime, logSize: hit.size };
      }
    }
    return null;
  }

  const candidates = listLogSessions();
  if (candidates.length === 0) return null;
  return candidates[0];
}

/**
 * 列出所有可用的日志目录，**活跃的排在前面**。
 *
 * 一台机器上可能同时开着多个 TRAE 窗口，每个窗口各自一份 logs/<时间戳>/，
 * 各写各的 session。所以「最新的日志」未必包含你要的那个 session。
 */
export function listLogSessions() {
  if (!fs.existsSync(TRAE_LOGS_DIR)) return [];
  const candidates = fs
    .readdirSync(TRAE_LOGS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && /^\d{8}T\d{6}$/.test(d.name))
    .map(d => {
      const dir = path.join(TRAE_LOGS_DIR, d.name);
      const modular = path.join(dir, 'Modular');
      let agentLog = null;
      let logMtime = 0;
      let logSize = 0;
      if (fs.existsSync(modular)) {
        const hit = fs
          .readdirSync(modular)
          .filter(f => /^ai-agent_.*_stdout\.log$/.test(f))
          .map(f => {
            const p = path.join(modular, f);
            return { p, size: safeSize(p), mtime: safeMtime(p) };
          })
          // 同一目录可能有多个，取最近写入的（并列时取最大）
          .sort((a, b) => b.mtime - a.mtime || b.size - a.size)[0];
        if (hit && hit.size > 0) {
          agentLog = hit.p;
          logMtime = hit.mtime;
          logSize = hit.size;
        }
      }
      return { name: d.name, dir, modular, agentLog, logMtime, logSize };
    })
    .filter(c => c.agentLog);

  candidates.sort((a, b) => b.logMtime - a.logMtime || b.logSize - a.logSize);
  return candidates;
}

/**
 * 列出日志里“提到过”指定 session 的候选目录，活跃的在前。
 *
 * ⚠️ 这只是**预筛**，不是结论。字面包含不等于该 session 真的在这份日志里跑过：
 * - `recently used sessions: ["<id>", ...]` 会把别的窗口的 session 列出来（实测 19 次）
 * - `commit_toolcall_result` 的 payload 会把包含 session_id 的日志原文回灌进来
 * 所以谁真的包含它，得交给解析器按 tracing 尾字段判定（见 parseAgentLog 的 sessionMatch）。
 */
export function findLogSessionsMentioning(sessionId) {
  if (!sessionId) return [];
  // 显式 pin 了日志目录时不往外游走：回放历史日志本来就是要钉住那一份。
  if (process.env.TRAE_DEMO_LOG_SESSION) {
    const pinned = findLatestLogSession();
    return pinned ? [pinned] : [];
  }
  return listLogSessions().filter(c => fileContains(c.agentLog, sessionId));
}

/** 流式判断文件是否含某个字面串，命中即停；跨块边界留 needle-1 字节重叠 */
function fileContains(filePath, needle) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return false;
  }
  const CHUNK = 1 << 20;
  const overlap = needle.length - 1;
  const buf = Buffer.allocUnsafe(CHUNK + overlap);
  let carry = 0;
  let pos = 0;
  try {
    for (;;) {
      const read = fs.readSync(fd, buf, carry, CHUNK, pos);
      if (read <= 0) return false;
      pos += read;
      const total = carry + read;
      if (buf.subarray(0, total).includes(needle)) return true;
      // 把尾部 overlap 字节挪到开头，避免目标串正好跨在两块之间被漏掉
      const keep = Math.min(overlap, total);
      buf.copy(buf, 0, total - keep, total);
      carry = keep;
    }
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

/** toolhost.log 位于 Modular/toolhost-host-<pid>/toolhost.log */
export function findToolhostLog(modularDir) {
  if (!modularDir || !fs.existsSync(modularDir)) return null;
  const dirs = fs
    .readdirSync(modularDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name.startsWith('toolhost-host-'))
    .map(d => path.join(modularDir, d.name, 'toolhost.log'))
    .filter(p => fs.existsSync(p))
    .sort((a, b) => safeMtime(b) - safeMtime(a));
  return dirs[0] || null;
}

/**
 * toolhost 的 job 落盘目录：
 *   $TMPDIR/trae-agent-toolhost-<uid>/jobs/job-<id>/
 * 注意：位于系统临时目录，会被 macOS 定期清理，不跨重启保留。
 */
export function findJobsDir() {
  if (process.env.TRAE_JOBS_DIR) return process.env.TRAE_JOBS_DIR;
  const tmp = os.tmpdir();
  let uid = '';
  try {
    uid = String(process.getuid?.() ?? '');
  } catch {
    uid = '';
  }
  const guesses = [];
  if (uid) guesses.push(path.join(tmp, `trae-agent-toolhost-${uid}`, 'jobs'));
  // 兜底：扫描 tmp 下所有 trae-agent-toolhost-*
  try {
    for (const name of fs.readdirSync(tmp)) {
      if (name.startsWith('trae-agent-toolhost-')) {
        guesses.push(path.join(tmp, name, 'jobs'));
      }
    }
  } catch {
    /* ignore */
  }
  return guesses.find(p => fs.existsSync(p)) || null;
}

function safeMtime(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

function safeSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

export function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return DATA_DIR;
}
