#!/usr/bin/env node
/**
 * 命令行验证入口（不开前端也能看结果）
 *
 *   node src/cli.mjs                    # 打印 session 的 trace 概要
 *   node src/cli.mjs --session <id>
 *   node src/cli.mjs --json             # 输出完整 JSON
 *   node src/cli.mjs --doctor           # 自检各数据源是否就绪
 */
import fs from 'node:fs';
import { buildTrace } from './build-trace.mjs';
import { loadHookEvents } from './parse-hook-events.mjs';
import {
  findLatestLogSession,
  findToolhostLog,
  findJobsDir,
  DEFAULT_SESSION_ID,
  HOOK_EVENTS_FILE,
  TRAE_SUPPORT_DIR,
} from './config.mjs';
import { listJobIds } from './parse-toolhost.mjs';

const args = process.argv.slice(2);
const has = f => args.includes(f);
const val = f => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

function human(bytes) {
  if (bytes == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return n.toFixed(1) + u[i];
}

function sizeOf(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return null;
  }
}

function doctor() {
  console.log('\n=== TRAE CN Trace Demo 数据源自检 ===\n');

  const ok = s => `  \x1b[32m✓\x1b[0m ${s}`;
  const bad = s => `  \x1b[31m✗\x1b[0m ${s}`;
  const warn = s => `  \x1b[33m!\x1b[0m ${s}`;

  console.log(fs.existsSync(TRAE_SUPPORT_DIR) ? ok(`TRAE 数据目录: ${TRAE_SUPPORT_DIR}`) : bad(`TRAE 数据目录不存在: ${TRAE_SUPPORT_DIR}`));

  const ls = findLatestLogSession();
  if (ls) {
    console.log(ok(`ai-agent 日志: ${ls.name}  (${human(sizeOf(ls.agentLog))})`));
    const th = findToolhostLog(ls.modular);
    console.log(th ? ok(`toolhost 日志: ${human(sizeOf(th))}`) : warn('toolhost 日志未找到 —— RunCommand 的 exit_code 将缺失'));
  } else {
    console.log(bad('未找到 ai-agent stdout 日志 —— 请先运行 TRAE CN'));
  }

  const jd = findJobsDir();
  if (jd) {
    const ids = listJobIds(jd);
    console.log(ok(`toolhost jobs 目录: ${ids.length} 个 job`));
    console.log(`     ${jd}`);
    if (ids.length === 0) console.log(warn('目录为空 —— 该目录在系统临时区，会被定期清理'));
  } else {
    console.log(warn('未找到 toolhost jobs 目录 —— RunCommand 的输出将缺失'));
  }

  const events = loadHookEvents();
  if (events.length > 0) {
    const byEvent = {};
    for (const e of events) byEvent[e.event] = (byEvent[e.event] || 0) + 1;
    console.log(ok(`hook 事件: ${events.length} 条  ${JSON.stringify(byEvent)}`));
  } else {
    console.log(warn(`hook 未配置或未触发 (${HOOK_EVENTS_FILE})`));
    console.log('     → 运行: node src/install-hooks.mjs <你的工作区路径>');
    console.log('     → 缺少 hook 时：非 RunCommand 工具的结果与用户 prompt 不可见');
  }
  console.log('');
}

async function main() {
  if (has('--doctor')) return doctor();

  const sessionId = val('--session') || DEFAULT_SESSION_ID;
  const t0 = Date.now();
  const result = await buildTrace({ sessionId });

  if (has('--json')) {
    process.stdout.write(JSON.stringify(result, null, 2));
    return;
  }

  if (!result.ok) {
    console.error('构建失败:', result.error);
    process.exit(1);
  }

  console.log(`\nsession   ${result.sessionId}`);
  console.log(`日志       ${result.sources.agentLogDir}`);
  console.log(`扫描       ${result.stats.linesRead.toLocaleString()} 行，命中 ${result.stats.linesParsed.toLocaleString()} 行，${Date.now() - t0}ms`);
  console.log(`hook 事件  ${result.sources.hookEventsCount}${result.sources.hookConfigured ? '' : '  (未配置 → 无 prompt / 无非 RunCommand 结果)'}`);
  console.log(`轮次       ${result.traces.length}\n`);

  for (const t of result.traces) {
    console.log(`── Turn ${t.turnIndex}  ${t.traceId}  ${(t.durationMs / 1000).toFixed(2)}s  ${t.stepCount} steps  ${t.toolCount} tools`);
    printSpan(t.root, 0);
    console.log('');
  }

  if (result.traces.length === 0) {
    console.log('未找到该 session 的对话轮次。可尝试:');
    console.log(`  node src/cli.mjs --session <其他 id>`);
    console.log(`  已观察到的 session: ${result.stats.observedSessions.slice(0, 5).join(', ')}`);
  }
}

function printSpan(sp, depth) {
  const pad = '   '.repeat(depth);
  const dur = sp.durationMs >= 1000 ? `${(sp.durationMs / 1000).toFixed(2)}s` : `${sp.durationMs}ms`;
  const flag = sp.status === 'ERROR' ? ' \x1b[31m[ERROR]\x1b[0m' : '';
  const a = sp.attributes || {};

  // 标注内容可得性，一眼看出哪里是缺口
  let content = '';
  if (sp.kind === 'TOOL') {
    const res = a['gen_ai.tool.call.result'];
    if (res != null) {
      // 结果常常是对象，不能直接 String() —— 那会得到 "[object Object]"（15 字符），
      // 把每个工具的结果都误报成 15 字节，看起来像没采到数据。
      const text = typeof res === 'string' ? res : JSON.stringify(res);
      const preview = text.replace(/\s+/g, ' ').slice(0, 48);
      content = ` \x1b[32m结果${text.length}字节\x1b[0m \x1b[90m${preview}…\x1b[0m`;
    } else {
      content = ' \x1b[33m无结果\x1b[0m';
    }
    if (a['gen_ai.tool.call.arguments'] != null) content += ' \x1b[36m有参数\x1b[0m';
  }
  if (sp.kind === 'STEP') {
    content = ` \x1b[90mround ${a['gen_ai.react.round']} · ${a['trae.step.tool_count']} tools\x1b[0m`;
  }
  if (sp.kind === 'LLM') {
    const ttft = a['trae.llm.ttft_ms'];
    if (ttft != null) content = ` \x1b[90mTTFT ${ttft}ms\x1b[0m`;
    if (a['gen_ai.output.messages'] != null) content += ' \x1b[32m有回复\x1b[0m';
  }
  if (sp.kind === 'ENTRY') {
    content = a['gen_ai.input.messages'] ? ' \x1b[32m有prompt\x1b[0m' : ' \x1b[33m无prompt\x1b[0m';
  }

  console.log(`${pad}${sp.kind.padEnd(5)} ${sp.name.padEnd(Math.max(8, 34 - depth * 3))} ${dur.padStart(8)}${flag}${content}`);
  for (const c of sp.children || []) printSpan(c, depth + 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
