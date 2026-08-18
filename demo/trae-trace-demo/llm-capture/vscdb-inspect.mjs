#!/usr/bin/env node
/**
 * state.vscdb 安全结构探查器。
 *
 * 回答的问题：TRAE 的 Safe Storage（OSCrypt）加密字段**有哪些、在哪个键、
 * 多长**，以及它们与「LLM 系统提示词 / 模型推理」是否相关——**只靠键名**判断，
 * 绝不靠解密判断。
 *
 * ⚠️ 本脚本刻意**不含任何解密逻辑**：
 *   - 不解密 v10 / v11 密文，不调用 keychain，不派生 AES 密钥；
 *   - 疑似密钥/token/密码的**明文值**也不打印，只报长度与指纹前缀；
 *   - 只读**副本**：先拷到临时目录再查，避免触发活动库的 WAL checkpoint。
 *
 * 为什么坚持不 decrypt：
 * 1. 凭据提取是红线——本项目的目标是观测 Agent 行为，不是还原用户密钥；
 * 2. LLM 的 system prompt / reasoning 大概率**不在**这个库里（服务端拼装），
 *    解密了也是白解密还留下风险。探查器先回答「这条路通不通」，不通就换路。
 *
 * 用法：
 *   node llm-capture/vscdb-inspect.mjs [--db <path>] [--out <report.txt>] [--all]
 *   --all  : 列出全部键（默认只列与 agent/model/skill/memory/llm/chat 相关的）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { TRAE_SUPPORT_DIR } from '../src/config.mjs';

const DEFAULT_DB = path.join(TRAE_SUPPORT_DIR, 'User', 'globalStorage', 'state.vscdb');

const args = process.argv.slice(2);
const val = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const dbPath = val('--db') || DEFAULT_DB;
const outPath = val('--out') || path.join(path.dirname(new URL(import.meta.url).pathname), 'out', 'vscdb-inspect-report.txt');
// --all：加密键与相关键列表不截断（默认各表最多 200 条，防刷屏）
const showAll = args.includes('--all');
const LIMIT = showAll ? Infinity : 200;

if (!fs.existsSync(dbPath)) {
  console.error(`找不到数据库: ${dbPath}`);
  process.exit(1);
}

// ---- 1. 先拷贝（含 WAL/SHM），绝不直连活动库 ----
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscdb-inspect-'));
const tmpDb = path.join(tmpDir, 'state.vscdb');
fs.copyFileSync(dbPath, tmpDb);
for (const ext of ['-wal', '-shm']) {
  const side = dbPath + ext;
  if (fs.existsSync(side)) fs.copyFileSync(side, tmpDb + ext);
}

/** 在副本上跑只读 SQL，结果按单元分隔符解析（值里可能有换行/引号） */
function query(sql) {
  const SEP = '\u001f';
  const raw = execFileSync('sqlite3', ['-readonly', '-noheader', '-batch', tmpDb,
    `.mode list`, `.separator "${SEP}"`, sql], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return raw.split('\n').filter(Boolean).map(l => l.split(SEP));
}

/** 值的前缀分类：Chromium OSCrypt 密文以 v10/v11 起头；dpapi 是 Windows 形态 */
function classify(prefix) {
  if (prefix.startsWith('v10')) return 'oscrypt-v10';
  if (prefix.startsWith('v11')) return 'oscrypt-v11';
  if (prefix.startsWith('dpapi')) return 'dpapi';
  return 'plaintext';
}

/** 明文值的形态：只判类型，不当作内容来源 */
function shapeOfText(text) {
  const t = text.trim();
  if (!t) return 'empty';
  if (t[0] === '{' || t[0] === '[') {
    try { JSON.parse(t); return t[0] === '{' ? 'json-object' : 'json-array'; } catch { /* 落回 string */ }
  }
  if (/^-?\d+(\.\d+)?$/.test(t)) return 'number';
  if (/^(true|false)$/.test(t)) return 'boolean';
  return 'string';
}

/** 键名或明文形态里疑似凭据的特征：命中就只报指纹不报内容 */
const SECRET_KEY_RE = /token|secret|password|passwd|credential|auth|api[_-]?key|apikey|access[_-]?key|private[_-]?key|session[_-]?key|bearer/i;
const SECRET_SHAPE_RE = /^(eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.|sk-[A-Za-z0-9_-]{16,}|ghp_|gho_|ghs_|ghu_|glpat-|xox[bpas]-|AKIA[A-Z0-9]{12})/;

function isSecret(key, shape, prefix = '') {
  if (SECRET_KEY_RE.test(key)) return true;
  if (shape === 'string' && SECRET_SHAPE_RE.test(prefix)) return true;
  return false;
}

/** 与 LLM / Agent 观测可能相关的键名特征 */
const RELEVANT_RE = /agent|model|skill|memory|llm|chat|prompt|rule|hook|mcp|subagent|custom[_-]?model|endpoint|base[_-]?url/i;

const lines = [];
const emit = s => lines.push(s);
emit(`state.vscdb 安全结构探查  ${new Date().toISOString()}`);
emit(`数据库（原始）: ${dbPath}`);
emit(`副本（只读）  : ${tmpDb}`);
emit('');
emit('安全承诺：本探查不解密任何字段、不打印任何密文、疑似凭据只报指纹。');
emit('');

let tables = [];
try {
  tables = query(`SELECT name FROM sqlite_master WHERE type='table'`).map(r => r[0]);
} catch (e) {
  emit(`读取失败（库可能整体加密或损坏）: ${String(e).split('\n')[0]}`);
  finish();
}
emit(`表: ${tables.join(', ') || '(空)'}`);

const stats = { encrypted: 0, plaintext: 0, secretLike: 0, relevant: 0, total: 0 };
const encryptedKeys = [];
const relevantKeys = [];
const secretKeys = [];

for (const t of tables) {
  const cols = query(`PRAGMA table_info("${t.replace(/"/g, '""')}")`).map(r => r[1]);
  // 只处理含 key/value 形态的键值表（ItemTable / 其它表只报行数）
  if (!(cols.includes('key') && cols.includes('value'))) {
    const n = query(`SELECT COUNT(*) FROM "${t.replace(/"/g, '""')}"`)[0]?.[0];
    emit(`\n表 ${t}: ${n} 行（非键值表，不展开）`);
    continue;
  }
  emit(`\n表 ${t}:`);
  const rows = query(`SELECT key, typeof(value), length(value), substr(CAST(value AS TEXT),1,32) FROM "${t.replace(/"/g, '""')}"`);
  stats.total += rows.length;

  for (const [key, vtype, vlen, prefixRaw] of rows) {
    const prefix = prefixRaw || '';
    const enc = vtype === 'blob' ? classify(prefix) : null;
    if (enc) {
      stats.encrypted++;
      encryptedKeys.push({ key, enc, vlen: Number(vlen) });
      if (RELEVANT_RE.test(key)) { stats.relevant++; relevantKeys.push(`${key}  [${enc}, ${vlen}B]`); }
      if (SECRET_KEY_RE.test(key)) { stats.secretLike++; secretKeys.push(key); }
      continue;
    }
    stats.plaintext++;
    // prefix 只有 32 字符：JSON 可能被截断解析失败，退回按 sqlite typeof 判形态
    const shape = inferShape(key, vtype, prefix);
    if (isSecret(key, shape, prefix)) {
      stats.secretLike++;
      secretKeys.push(key);
    }
    if (RELEVANT_RE.test(key)) {
      stats.relevant++;
      relevantKeys.push(`${key}  [plaintext/${shape}, ${vlen}B]`);
    }
  }
}

/** 明文值的形态推断（prefix 只有 32 字符，JSON 可能截断解析失败，属预期） */
function inferShape(key, vtype, prefix) {
  if (vtype === 'integer') return 'integer';
  if (vtype === 'real') return 'real';
  if (vtype === 'null') return 'null';
  return shapeOfText(prefix);
}

emit('');
emit(`── 汇总 ──`);
emit(`键总数 ${stats.total}  |  OSCrypt 加密 ${stats.encrypted}  |  明文 ${stats.plaintext}  |  疑似凭据 ${stats.secretLike}  |  与 LLM/Agent 相关 ${stats.relevant}`);

emit('');
emit(`── 加密字段（${encryptedKeys.length} 个，只有键名与长度；本探查不解密）──`);
for (const e of encryptedKeys.slice(0, LIMIT)) emit(`  ${e.key.padEnd(60)} ${e.enc}  ${e.vlen}B`);
if (encryptedKeys.length > LIMIT) emit(`  …另有 ${encryptedKeys.length - LIMIT} 个未列出（--all 看全量）`);

emit('');
emit(`── 与 LLM/Agent 观测相关的键（${relevantKeys.length} 个）──`);
if (relevantKeys.length === 0) {
  emit('  (无) —— 这本身就是重要信号：这个库大概率不存系统提示词/推理内容');
} else {
  for (const k of relevantKeys.slice(0, LIMIT)) emit(`  ${k}`);
  if (relevantKeys.length > LIMIT) emit(`  …另有 ${relevantKeys.length - LIMIT} 个`);
}

emit('');
emit(`── 疑似凭据（${secretKeys.length} 个键名命中 token/secret/auth 等模式）──`);
emit('  只列键名。无论加密与否，解密并打印它们是凭据提取，不在本项目范围内。');
for (const k of secretKeys.slice(0, 100)) emit(`  ${k}`);
if (secretKeys.length > 100) emit(`  …另有 ${secretKeys.length - 100} 个`);

emit('');
emit(`── 结论指引 ──`);
emit(`1. 加密字段${stats.encrypted > 0 ? '存在' : '不存在'}。若键名全是凭据/账号类 → 解密它拿不到 system prompt / reasoning。`);
emit(`2. 相关键${stats.relevant > 0 ? '有 ' + stats.relevant + ' 个（见上）→ 值得用明文读取确认内容性质' : '为零 → 这条路与 LLM 观测无关，应转向 proxy / mitm'}。`);
emit(`3. system prompt 与 reasoning 的优先获取路径：自定义模型代理 → mitmproxy → (最后)二进制插桩。`);

finish();

function finish() {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join('\n') + '\n');
  console.log(lines.join('\n'));
  console.log(`\n报告已写: ${outPath}`);
  // 清理副本
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}
