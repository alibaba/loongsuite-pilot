#!/usr/bin/env node
/**
 * 生成 TRAE hook 配置到目标工作区的 .trae/hooks.json
 *
 * 为什么用脚本生成而不是手写模板：
 * hook 的 command 必须是绝对路径，写死在模板里会因机器不同而失效。
 *
 * 两种安装位置：
 *   --global        → ~/.trae-cn/hooks.json（全局，对当前用户的所有工作区生效）
 *                     路径已经官方文档确认（Windows：%userprofile%/.trae-cn/hooks.json）
 *   <工作区路径>   → <工作区>/.trae/hooks.json（仅该项目/工作区生效）
 *
 * 两种埋点后端：
 *   默认            → assets/hooks/trae-cn-loongsuite-pilot-hook.sh
 *                     产出符合仓库 GenAI 语义规范的记录到
 *                     ~/.loongsuite-pilot/logs/trae-cn/history/
 *   --capture       → demo/hooks/capture.mjs
 *                     原始 payload 直落 .data/hook-events.jsonl，
 *                     仅用于 TRAE hook schema 与预期不符时反推真实结构
 *
 * 用法：
 *   node src/install-hooks.mjs --global
 *   node src/install-hooks.mjs <目标工作区路径>
 *   node src/install-hooks.mjs --global --capture
 *   node src/install-hooks.mjs --print            # 只打印不写入
 *
 * schema 依据官方文档（已逐字段核对，不再是猜测）：
 *   https://docs.trae.ai/ide/hook-configuration-reference?_lang=zh
 *   中文摘录见 docs/zh-CN/trae-session-trace-path.md §2.7
 *
 * 关键约束：
 *   - version    默认 1 且当前仅支持 1，按官方示例显式写出
 *   - type       当前仅支持 command（dylib 里的 http_executor 未对外开放）
 *   - matcher    仅对 PreToolUse / PostToolUse / Notification 有效，其余事件不写
 *   - timeout    官方默认 30s；这里收紧到 10s（PreToolUse 会阻塞它自己的工具执行）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(DEMO_ROOT, '..', '..');

const PILOT_HOOK = path.join(REPO_ROOT, 'assets', 'hooks', 'trae-cn-loongsuite-pilot-hook.sh');
const DEMO_CAPTURE = path.join(DEMO_ROOT, 'hooks', 'capture.mjs');
/** TRAE 全局 hook 配置（实测由 TRAE 自行创建） */
const GLOBAL_HOOKS_FILE = path.join(os.homedir(), '.trae-cn', 'hooks.json');

/** 官方文档确认的 6 个事件 */
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification'];

/** 官方：matcher 仅对这三个事件有效（前两个按工具名，Notification 按通知类型） */
const MATCHER_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'Notification']);

function quote(p) {
  return /[\s"']/.test(p) ? JSON.stringify(p) : p;
}

/**
 * 把本工具的 hook 合入已有配置，而不是整体覆盖。
 * 全局配置可能已有用户自己的 hook，直接覆写会默默弄丢。
 * 同一个 command 重复执行一次安装也不应重复追加，所以先按 command 去重。
 */
function mergeConfig(existing, commandFor) {
  const out = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? { ...existing }
    : {};
  const hooks = out.hooks && typeof out.hooks === 'object' && !Array.isArray(out.hooks)
    ? { ...out.hooks }
    : {};

  let replaced = 0;
  for (const ev of EVENTS) {
    const command = commandFor(ev);
    const groups = Array.isArray(hooks[ev]) ? hooks[ev].slice() : [];

    // 先摘掉旧的同名埋点（路径可能变了），避免一个事件挂两份
    const isOurs = h => typeof h?.command === 'string'
      && (h.command.includes('trae-cn-loongsuite-pilot-hook') || h.command.includes('trae-trace-demo'));
    const cleaned = [];
    for (const g of groups) {
      const inner = Array.isArray(g?.hooks) ? g.hooks.filter(h => !isOurs(h)) : g?.hooks;
      if (Array.isArray(g?.hooks)) {
        if (g.hooks.length !== inner.length) replaced++;
        if (inner.length > 0) cleaned.push({ ...g, hooks: inner });
      } else {
        cleaned.push(g);
      }
    }

    cleaned.push({
      // matcher 仅对 PreToolUse / PostToolUse / Notification 有效，其余事件不写以免误导
      ...(MATCHER_EVENTS.has(ev) ? { matcher: '*' } : {}),
      hooks: [
        {
          type: 'command',
          command,
          // PreToolUse 阻塞它自己要执行的工具，超时必须比官方默认的 30s 短
          timeout: 10,
        },
      ],
    });
    hooks[ev] = cleaned;
  }

  // version 默认 1 且官方当前仅支持 1，显式写出与官方示例一致；已有其他版本则不动
  if (out.version === undefined) out.version = 1;
  out.hooks = hooks;
  return { config: out, replaced };
}

function readJsonSafe(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    return text ? JSON.parse(text) : {};
  } catch {
    return null;
  }
}

function main() {
  const args = process.argv.slice(2);
  const printOnly = args.includes('--print');
  const useCapture = args.includes('--capture');
  const useGlobal = args.includes('--global');
  const target = args.find(a => !a.startsWith('--'));

  const backend = useCapture ? DEMO_CAPTURE : PILOT_HOOK;
  if (!fs.existsSync(backend)) {
    console.error(`[错误] 找不到埋点脚本: ${backend}`);
    process.exit(1);
  }

  const commandFor = useCapture
    ? ev => `${quote(process.execPath)} ${quote(DEMO_CAPTURE)} --event ${ev}`
    // wrapper 自带 node 探测，事件名走 $1
    : ev => `${quote(PILOT_HOOK)} ${ev}`;

  if (printOnly || (!useGlobal && !target)) {
    console.log('# 将以下内容写入 ~/.trae-cn/hooks.json（全局）或 <工作区>/.trae/hooks.json\n');
    console.log(JSON.stringify(mergeConfig({}, commandFor).config, null, 2));
    if (!useGlobal && !target) {
      const self = path.relative(process.cwd(), fileURLToPath(import.meta.url));
      console.log('\n# 或直接自动写入（会合并而非覆盖，并先备份）：');
      console.log(`#   node ${self} --global                    # 推荐：所有工作区生效`);
      console.log(`#   node ${self} /path/to/your/workspace     # 仅单个工作区`);
    }
    return;
  }

  let outFile;
  let scopeLabel;
  if (useGlobal) {
    outFile = GLOBAL_HOOKS_FILE;
    scopeLabel = '全局（所有工作区生效）';
  } else {
    const workspace = path.resolve(target);
    if (!fs.existsSync(workspace)) {
      console.error(`[错误] 工作区不存在: ${workspace}`);
      process.exit(1);
    }
    outFile = path.join(workspace, '.trae', 'hooks.json');
    scopeLabel = `单工作区（${workspace}）`;
  }

  let existing = {};
  if (fs.existsSync(outFile)) {
    const parsed = readJsonSafe(outFile);
    if (parsed === null) {
      console.error(`[错误] 已有配置不是合法 JSON，拒绝改写以免弄坏: ${outFile}`);
      console.error('       请先修正或手动删除该文件后重试。');
      process.exit(1);
    }
    existing = parsed;
    const backup = `${outFile}.bak-${Date.now()}`;
    fs.copyFileSync(outFile, backup);
    console.log(`[备份] 原配置已备份到: ${backup}`);
  }

  const { config, replaced } = mergeConfig(existing, commandFor);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(config, null, 2) + '\n', 'utf8');

  console.log(`[完成] 已写入: ${outFile}`);
  console.log(`[作用域] ${scopeLabel}`);
  console.log(`[埋点后端] ${useCapture ? 'demo capture（原始 payload）' : 'pilot hook（GenAI 规范）'}`);
  console.log(`[脚本] ${backend}`);
  console.log(`[事件] ${EVENTS.join(', ')}`);
  if (replaced > 0) console.log(`[清理] 移除了 ${replaced} 处旧的本工具埋点（避免重复）`);
  console.log('');
  console.log('下一步：');
  console.log('  1. 重启 TRAE 窗口（已打开的窗口不会重载 hook 配置）');
  console.log('  2. 确认配置被正确加载（is_ok=true 才算成功）：');
  console.log('     grep -aE "resolve_hooks_config result|parse_hooks_config" \\');
  console.log('       ~/Library/Application\\ Support/Trae\\ CN/logs/*/Modular/ai-agent_*_stdout.log | tail -5');
  console.log('  3. 发起一轮带工具调用的会话（例如让它读文件、跑命令）');
  console.log('  4. 检查是否采集到记录：');
  if (useCapture) {
    console.log(`     cat ${path.join(DEMO_ROOT, '.data', 'hook-events.jsonl')} | head`);
  } else {
    console.log('     ls ~/.loongsuite-pilot/logs/trae-cn/history/');
    console.log('     tail -1 ~/.loongsuite-pilot/logs/trae-cn/history/*.jsonl | python3 -m json.tool');
    console.log('     # 没有产出时看错误日志：');
    console.log('     cat ~/.loongsuite-pilot/logs/trae-cn/errors/*.jsonl 2>/dev/null');
    console.log('     # 看 TRAE 实际传给 hook 的真实 payload（用于校对 schema）：');
    console.log('     grep -a "Hook input payload" \\');
    console.log('       ~/Library/Application\\ Support/Trae\\ CN/logs/*/Modular/ai-agent_*_stdout.log | tail -3');
  }
  console.log('  5. 刷新前端页面，prompt / 工具结果 / 思考过程应出现在 span 详情里');
}

main();
