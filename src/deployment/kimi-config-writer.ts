/**
 * kimi-config-writer.ts — Kimi CLI hook 注册到 ~/.kimi/config.toml 的 [[hooks]] 段。
 *
 * Kimi CLI 把 hook 定义存在 TOML 文件里，结构为：
 *
 *   [[hooks]]
 *   event = "Stop"
 *   command = "bash /path/to/kimi-cli-loongsuite-pilot-hook.sh"
 *   matcher = ""
 *   timeout = 30
 *
 * 与 codex-trust-writer.ts 类比，本模块专职读写 pilot 拥有的 [[hooks]] 条目；
 * HookStrategy 在 settingsFormat === 'toml' 时分派到这里，绕过 HookManager 的 JSON 路径。
 *
 * 幂等性：deploy 多次只产生每个 event 一条 [[hooks]] 条目；undeploy 清理 pilot 拥有的
 * 条目（按 command 匹配 hookCommand 或 replaceHookCommands）。其他用户/工具写入的
 * [[hooks]] 条目原样保留。
 *
 * TOML 解析/序列化使用 smol-toml（纯 JS，无 native binding）。round-trip 保留数据但
 * 会丢失注释——kimi config.toml 通常机器生成，可接受。
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { parse, stringify } from 'smol-toml';

/**
 * Kimi [[hooks]] 条目的最小字段集。HookDef 在 kimi-cli/src/kimi_cli/hooks/config.py
 * 定义：event / command / matcher / timeout。pydantic 默认 matcher="" timeout=30，
 * 所以 stringify 时缺字段会回填默认值——这里写全部字段以保持稳定。
 */
export interface KimiHookEntry {
  event: string;
  command: string;
  matcher: string;
  timeout: number;
}

interface ParsedConfig {
  [key: string]: unknown;
  hooks?: KimiHookEntry[];
}

export interface InstallKimiHooksOpts {
  /** 配置文件路径，如 ~/.kimi/config.toml */
  configPath: string;
  /** 写入 [[hooks]].command 的 shell 命令（已 resolveHome + $PILOT_DATA 展开）。 */
  hookCommand: string;
  /** 需要注册的 event 列表（如 ["Stop", "StopFailure"]）。 */
  events: readonly string[];
  /** 写入 [[hooks]].matcher 的值，默认 "*"。 */
  matcher?: string;
  /** 写入 [[hooks]].timeout 的值（秒），默认 30。 */
  timeout?: number;
  /**
   * 旧 pilot 或第三方 hook 留下的 command 字符串前缀，deploy 时一并清除。
   * 与 hookCommand 一同用于识别 pilot 拥有的条目。
   */
  replaceHookCommands?: readonly string[];
}

export interface UninstallKimiHooksOpts {
  configPath: string;
  hookCommand: string;
  events?: readonly string[];
  replaceHookCommands?: readonly string[];
}

/**
 * 读取并解析 kimi config.toml。文件不存在或解析失败时返回空对象。
 */
async function readKimiConfig(configPath: string): Promise<{ data: ParsedConfig; raw: string }> {
  let raw = '';
  try {
    raw = await fsp.readFile(configPath, 'utf-8');
  } catch {
    return { data: {}, raw: '' };
  }
  try {
    const data = parse(raw) as ParsedConfig;
    return { data, raw };
  } catch {
    // 解析失败：保留原文件内容，但操作在一个空对象上进行；调用方决定是否写回。
    return { data: {}, raw };
  }
}

function isOwnedEntry(entry: unknown, hookCommand: string, replaceHookCommands: readonly string[]): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const cmd = (entry as { command?: unknown }).command;
  if (typeof cmd !== 'string') return false;
  if (cmd === hookCommand) return true;
  return replaceHookCommands.some((needle) => typeof needle === 'string' && needle.length > 0 && cmd.includes(needle));
}

function normalizeHooksArray(value: unknown): KimiHookEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((e): e is KimiHookEntry => {
    if (!e || typeof e !== 'object') return false;
    const ev = (e as { event?: unknown }).event;
    const cmd = (e as { command?: unknown }).command;
    return typeof ev === 'string' && typeof cmd === 'string';
  });
}

async function writeKimiConfig(configPath: string, data: ParsedConfig): Promise<void> {
  const dir = path.dirname(configPath);
  await fsp.mkdir(dir, { recursive: true });
  const text = stringify(data as Record<string, unknown>) + '\n';
  const tmp = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsp.writeFile(tmp, text, 'utf8');
    await fsp.rename(tmp, configPath);
  } catch (err) {
    try { await fsp.unlink(tmp); } catch {}
    throw err;
  }
}

/**
 * 安装 pilot 拥有的 [[hooks]] 条目。幂等：
 *   1. 解析 config.toml
 *   2. 从 hooks 数组中移除 command 匹配 hookCommand / replaceHookCommands 的旧条目
 *      （包括其他 event 的残留，用于 retiredEvents 清理）
 *   3. 对每个 event，若数组中已有 command===hookCommand 且 event===event 的条目，跳过；
 *      否则追加新条目
 *   4. 写回
 *
 * 注意：retiredEvents 清理由调用方（HookStrategy）通过传入 events=当前 events 列表
 * + replaceHookCommands 触发——本函数只保留与 hookCommand/replaceHookCommands 不匹配
 * 的条目，再追加当前 events。这样新 events 列表里被淘汰的 event 会被自然清除。
 */
export async function installKimiHooks(opts: InstallKimiHooksOpts): Promise<boolean> {
  const { configPath, hookCommand, events, matcher = '*', timeout = 30, replaceHookCommands = [] } = opts;
  const { data } = await readKimiConfig(configPath);

  const existing = normalizeHooksArray(data.hooks);
  // 保留非 pilot 拥有的条目（用户、其他工具写入）
  const survivors = existing.filter((e) => !isOwnedEntry(e, hookCommand, replaceHookCommands));

  // 对每个 event，若 survivors 中已有同 event + 同 command 的条目，复用；否则追加
  const result: KimiHookEntry[] = [...survivors];
  for (const event of events) {
    const present = result.some((e) => e.event === event && e.command === hookCommand);
    if (!present) {
      result.push({ event, command: hookCommand, matcher, timeout });
    }
  }

  data.hooks = result;
  await writeKimiConfig(configPath, data);
  return true;
}

/**
 * 卸载 pilot 拥有的所有 [[hooks]] 条目（command 匹配 hookCommand 或 replaceHookCommands）。
 * 不传 events 时清除所有匹配条目；传 events 时仅清除这些 event 下的匹配条目。
 */
export async function uninstallKimiHooks(opts: UninstallKimiHooksOpts): Promise<boolean> {
  const { configPath, hookCommand, events, replaceHookCommands = [] } = opts;
  const { data, raw } = await readKimiConfig(configPath);
  if (raw === '' && !data.hooks) {
    return false;
  }

  const existing = normalizeHooksArray(data.hooks);
  if (existing.length === 0) return false;

  const survivors = existing.filter((e) => {
    if (!isOwnedEntry(e, hookCommand, replaceHookCommands)) return true;
    if (events && events.length > 0 && !events.includes(e.event)) return true;
    return false;
  });

  if (survivors.length === existing.length) return false;

  if (survivors.length === 0) {
    delete data.hooks;
  } else {
    data.hooks = survivors;
  }
  await writeKimiConfig(configPath, data);
  return true;
}

export interface IsKimiHookInstalledOpts {
  configPath: string;
  hookCommand: string;
  event: string;
  replaceHookCommands?: readonly string[];
}

/**
 * 检查 config.toml 中是否已存在 pilot 拥有的某 event 的 [[hooks]] 条目。
 * 若 replaceHookCommands 中任一前缀出现在某条目的 command 中，视为该条目非 pilot
 * 当前版本（旧残留）→ 返回 false（需要重新安装）。
 */
export async function isKimiHookInstalled(opts: IsKimiHookInstalledOpts): Promise<boolean> {
  const { configPath, hookCommand, event, replaceHookCommands = [] } = opts;
  if (!fs.existsSync(configPath)) return false;

  const { data } = await readKimiConfig(configPath);
  const hooks = normalizeHooksArray(data.hooks);
  if (hooks.length === 0) return false;

  // 任何 replaceHookCommands 残留 → 视为需要重装（旧条目未清理）
  for (const e of hooks) {
    if (replaceHookCommands.some((needle) => typeof needle === 'string' && needle.length > 0 && e.command.includes(needle))) {
      return false;
    }
  }
  return hooks.some((e) => e.event === event && e.command === hookCommand);
}

/**
 * 列出 config.toml 中已安装的 pilot 拥有的 event 列表（仅 command === hookCommand）。
 * 用于 hook-watchdog 的 expectedHooks 校验。
 */
export async function listInstalledKimiEvents(
  configPath: string,
  hookCommand: string,
): Promise<readonly string[]> {
  if (!fs.existsSync(configPath)) return [];
  const { data } = await readKimiConfig(configPath);
  const hooks = normalizeHooksArray(data.hooks);
  return hooks.filter((e) => e.command === hookCommand).map((e) => e.event);
}

/**
 * 列出 config.toml 中所有 pilot 拥有的 [[hooks]] 条目（command 匹配 hookCommand
 * 或 replaceHookCommands 中的任一前缀）。用于 needsDeploy 判断 retiredEvents 残留
 * 与 replaceHookCommands 残留。
 */
export async function listOwnedKimiEntries(
  configPath: string,
  hookCommand: string,
  replaceHookCommands: readonly string[] = [],
): Promise<readonly KimiHookEntry[]> {
  if (!fs.existsSync(configPath)) return [];
  const { data } = await readKimiConfig(configPath);
  const hooks = normalizeHooksArray(data.hooks);
  return hooks.filter((e) => isOwnedEntry(e, hookCommand, replaceHookCommands));
}
