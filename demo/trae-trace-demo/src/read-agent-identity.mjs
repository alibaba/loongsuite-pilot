/**
 * 读取 TRAE 渲染端的 Agent 身份与能力声明。
 *
 * 数据源：`<Trae 支持目录>/User/workspaceStorage/<hash>/state.vscdb`
 * —— 这是 VSCode 系 IDE 的**明文** SQLite 键值库（与 ai-agent 的 SQLCipher
 * `database.db` 是两回事），里面有三个对本方案有用的键：
 *
 * | 键 | 内容 |
 * |---|---|
 * | `currentAgentData_<userId>` | 当前 Agent 的完整声明：id/name/描述/内置工具/成员(子智能体)/是否可作子智能体 |
 * | `icube_session_agent_map`   | session_id → agent_id 映射，用来给轮次归属 Agent |
 * | `<userId>_AI.agent.plan.mode.map` | session_id → 是否规划模式 |
 *
 * ⚠️ 两条硬约束：
 * 1. **必须先拷贝再读**。直连活动库会触发 WAL checkpoint，等于写入用户的 IDE 状态。
 * 2. 只读白名单里的键。同库还存着编辑器历史等无关隐私数据，不整表导出。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { TRAE_SUPPORT_DIR } from './config.mjs';

/** 只读这些键，避免把无关的 IDE 状态一并捞出来 */
const WANTED_EXACT = ['icube_session_agent_map'];
const WANTED_PREFIX = ['currentAgentData_'];
const WANTED_SUFFIX = ['_AI.agent.plan.mode.map'];

/** TRAE 的内置工具枚举 → 可读名称（对应设置界面里的能力开关） */
const BUILTIN_TOOL_LABELS = {
  readonly: '阅读',
  edit: '编辑',
  terminal: '终端',
  preview: '预览',
  web_search: '联网搜索',
};

function wanted(key) {
  return WANTED_EXACT.includes(key)
    || WANTED_PREFIX.some(p => key.startsWith(p))
    || WANTED_SUFFIX.some(s => key.endsWith(s));
}

function readVscdb(dbPath) {
  // 拷贝到临时目录再读：绝不直连活动库
  const tmp = path.join(os.tmpdir(), `trae-state-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  try {
    fs.copyFileSync(dbPath, tmp);
    // -separator 用制表符，值里可能含逗号但不含裸制表符（JSON 会转义成 \t）
    const out = execFileSync('sqlite3', [tmp, '-separator', '\t', 'SELECT key, value FROM ItemTable;'], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const map = new Map();
    for (const line of out.split('\n')) {
      const i = line.indexOf('\t');
      if (i < 0) continue;
      const key = line.slice(0, i);
      if (!wanted(key)) continue;
      map.set(key, line.slice(i + 1));
    }
    return map;
  } catch {
    return new Map();
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 清理失败无所谓 */ }
  }
}

function parseJson(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * @returns {{
 *   agents: Map<string, object>,      // agent_id → 声明
 *   sessionAgent: Map<string, string>,// session_id → agent_id
 *   planMode: Map<string, boolean>,   // session_id → 是否规划模式
 *   source: string|null
 * }}
 */
export function readAgentIdentity() {
  const result = { agents: new Map(), sessionAgent: new Map(), planMode: new Map(), source: null };
  const root = path.join(TRAE_SUPPORT_DIR, 'User', 'workspaceStorage');
  if (!fs.existsSync(root)) return result;

  let dirs;
  try {
    dirs = fs.readdirSync(root)
      .map(d => path.join(root, d, 'state.vscdb'))
      .filter(p => fs.existsSync(p));
  } catch {
    return result;
  }

  // 多工作区各有一份 state.vscdb，全都读一遍再合并：
  // session→agent 映射只落在打开过该会话的那个工作区里。
  for (const db of dirs) {
    const kv = readVscdb(db);
    if (kv.size === 0) continue;
    result.source = result.source || db;

    for (const [key, raw] of kv) {
      if (key.startsWith('currentAgentData_')) {
        const a = parseJson(raw);
        if (a && a.agent_id) {
          const builtin = Array.isArray(a.built_in_tool_list)
            ? a.built_in_tool_list.map(x => (x && typeof x === 'object' ? x.value : x)).filter(Boolean)
            : [];
          result.agents.set(a.agent_id, {
            agentId: a.agent_id,
            name: a.name || a.unique_name || a.agent_id,
            type: a.type || null,
            description: a.description || null,
            builtinTools: builtin,
            builtinToolLabels: builtin.map(v => BUILTIN_TOOL_LABELS[v] || v),
            members: Array.isArray(a.members) ? a.members.slice() : [],
            mcpCount: Array.isArray(a.mcp_list) ? a.mcp_list.length : 0,
            canBeSubAgent: a.can_be_sub_agent === true,
            isMergedAgent: a.is_merged_agent === true,
            isEnterprise: a.is_enterprise === true,
            hasCustomPrompt: typeof a.prompt === 'string' && a.prompt.trim().length > 0,
          });
        }
        continue;
      }
      if (key === 'icube_session_agent_map') {
        const m = parseJson(raw);
        if (m && typeof m === 'object') {
          for (const [sid, aid] of Object.entries(m)) {
            if (typeof aid === 'string') result.sessionAgent.set(sid, aid);
          }
        }
        continue;
      }
      if (key.endsWith('_AI.agent.plan.mode.map')) {
        const m = parseJson(raw);
        if (m && typeof m === 'object') {
          for (const [sid, on] of Object.entries(m)) {
            if (typeof on === 'boolean') result.planMode.set(sid, on);
          }
        }
      }
    }
  }
  return result;
}

/** 供 CLI 自查：node src/read-agent-identity.mjs */
if (import.meta.url === `file://${process.argv[1]}`) {
  const r = readAgentIdentity();
  console.log('来源:', r.source || '(未找到 state.vscdb)');
  console.log(`\nAgent 声明 ${r.agents.size} 个：`);
  for (const a of r.agents.values()) {
    console.log(`  ${a.agentId}  name=${a.name}  type=${a.type}`);
    console.log(`    描述        : ${a.description}`);
    console.log(`    内置工具    : ${a.builtinTools.join(', ')}  →  ${a.builtinToolLabels.join('/')}`);
    console.log(`    成员(子智能体): ${a.members.length ? a.members.join(', ') : '(无)'}`);
    console.log(`    MCP 数      : ${a.mcpCount}`);
    console.log(`    是否合并态  : ${a.isMergedAgent}   可作子智能体: ${a.canBeSubAgent}`);
    console.log(`    自定义提示词: ${a.hasCustomPrompt}`);
  }
  console.log(`\nsession → agent（${r.sessionAgent.size} 条）：`);
  for (const [s, a] of r.sessionAgent) {
    console.log(`  ${s} → ${a}${r.planMode.get(s) === true ? '  [规划模式]' : ''}`);
  }
}
