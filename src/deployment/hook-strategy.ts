import * as path from 'node:path';
import type {
  AgentDefinition,
  AgentHookConfig,
  DeployResult,
  DeployStrategy,
  DeployedAgentRecord,
} from '../types/index.js';
import { HookManager, type HookDefinition } from '../hooks/hook-manager.js';
import { readJsonFile, writeJsonFile, resolveHome } from '../utils/fs-utils.js';
import { detectAgent } from './detect-utils.js';
import { createLogger } from '../utils/logger.js';
import {
  writeTrustedHashes,
  removeTrustBlock,
  verifyTrustHashes,
} from './codex-trust-writer.js';

const logger = createLogger('HookStrategy');

/**
 * 把 hook event 名(JSON 中的 PascalCase,如 "SessionStart") → mjs handler 期望的
 * subcommand 名(kebab-case,如 "session-start")。两端必须保持一致,否则 trust hash
 * 会因 command 字符串差异而对不上。
 */
function eventToSubcommand(event: string): string {
  return event.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * On Windows, .ps1 scripts must be invoked via `powershell -File` for stdin
 * piping to work correctly.  Bare `.ps1` paths fail to receive stdin when
 * spawned through cmd.exe / child_process.
 */
function wrapPs1Command(cmd: string): string {
  if (process.platform !== 'win32') return cmd;
  const parts = cmd.split(' ');
  const script = parts[0];
  if (!script.endsWith('.ps1')) return cmd;
  const args = parts.slice(1).join(' ');
  const wrapped = `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}"`;
  return args ? `${wrapped} ${args}` : wrapped;
}

/**
 * 拼 hooks.json 中实际写入的 command 字符串。
 * 必须与 codex trust hash 算用的字符串完全一致。
 */
function formatHookCommand(
  hookCommand: string,
  event: string,
  style: AgentHookConfig['eventSubcommand'],
): string {
  const cmd = wrapPs1Command(hookCommand);
  if (style === 'kebab-case') {
    return `${cmd} ${eventToSubcommand(event)}`;
  }
  return cmd;
}

export class HookStrategy implements DeployStrategy {
  private readonly hookManager: HookManager;

  constructor(hookManager: HookManager) {
    this.hookManager = hookManager;
  }

  async detect(def: AgentDefinition): Promise<boolean> {
    return detectAgent(def.detection);
  }

  async needsDeploy(def: AgentDefinition, _record?: DeployedAgentRecord): Promise<boolean> {
    const hookDefs = this.buildHookDefinitions(def);
    for (const hookDef of hookDefs) {
      if (!(await this.hookManager.isHookInstalled(hookDef))) {
        return true;
      }
    }
    return false;
  }

  async deploy(def: AgentDefinition): Promise<DeployResult> {
    const hookConfig = def.hook;
    if (!hookConfig) {
      return { success: false, agentId: def.id, deployMode: 'hook', error: 'missing hook config' };
    }

    try {
      await this.ensureSettingsFile(hookConfig.settingsPath);

      const hookDefs = this.buildHookDefinitions(def);
      for (const hookDef of hookDefs) {
        const installed = await this.hookManager.isHookInstalled(hookDef);
        if (!installed) {
          const ok = await this.hookManager.installHook(hookDef);
          if (!ok) {
            return { success: false, agentId: def.id, deployMode: 'hook', error: `failed to install hook for event` };
          }
        }
      }

      // Codex 类 hook 需要写 trust hash 到 config.toml(forceBypass 应急通道由 pilot
      // config.json 的 agents.<id>.trust.forceBypass 控制 — 后续可由 hook-watchdog 读取)
      if (hookConfig.trustToml) {
        try {
          await this.writeCodexTrust(def);
        } catch (err) {
          logger.error('codex trust write failed (deploy continues)', {
            agentId: def.id,
            error: String(err),
          });
        }
      }

      logger.info('hooks deployed', { agentId: def.id, events: hookConfig.events.length });

      if (hookConfig.trustToml) {
        logger.info(
          'Codex desktop app note: if hooks show as "Untrusted" in the desktop UI, ' +
          'please manually trust them once via the desktop hook review prompt. ' +
          'CLI codex will trust them automatically via trusted_hash.',
          { agentId: def.id },
        );
      }
      return { success: true, agentId: def.id, deployMode: 'hook' };
    } catch (err) {
      return { success: false, agentId: def.id, deployMode: 'hook', error: String(err) };
    }
  }

  /**
   * 写 Codex trust hash + 立即自洽性校验(Q8)。
   * 校验失败仅记 logger.error,不阻塞 deploy(让 hook-watchdog 活性检查兜底重试)。
   *
   * 注:command 字符串必须与 HookManager.installHook 写入 hooks.json 时一致,否则 hash 对不上。
   * HookManager nested format 写入的 command 就是原始 def.hook.hookCommand + 末尾空格 + subcommand
   * (subcommand 在我们 buildHookDefinitions 里没拼,因为 mjs handler 是单入口、subcommand 当 argv)。
   * 这里 trust hash 算的是 `bash <hookCommand> <subcommand>` — 与实际 hooks.json 中条目对齐。
   *
   * 重要:HookManager 写 hooks.json 时把 hookCommand 整体作为 command(不会拼 subcommand),
   * 所以**每个 event** 的 hooks.json 条目共享同一个 hookCommand 字符串。但 codex 上游 trust hash
   * 是基于 hooks.json 中 entry 的精确 command 算的;hooks.json 里写 `bash $entryPath` 而 trust 算
   * `bash $entryPath <sub>` 会对不上。
   *
   * 解决:HookManager 已支持每事件独立 hookCommand(我们在 buildHookDefinitions 里拼了 subcommand),
   * 见下方 buildHookDefinitions 改动。
   */
  private async writeCodexTrust(def: AgentDefinition): Promise<void> {
    const cfg = def.hook!.trustToml!;
    const configPath = resolveHome(cfg.configPath);
    const hooksJsonAbsPath = path.resolve(resolveHome(def.hook!.settingsPath));
    const hookCommand = resolveHome(def.hook!.hookCommand);

    // 构建 event → 实际写入 hooks.json 的完整 command(与 buildHookDefinitions 一致)
    const eventToCmd: Record<string, string> = {};
    for (const ev of def.hook!.events) {
      eventToCmd[ev] = formatHookCommand(hookCommand, ev, def.hook!.eventSubcommand);
    }

    // 回读 hooks.json,算出每个 event 中 pilot hook 的实际 group index。
    // 当其他第三方 hook(如 r2c)排在前面时,pilot 的 hook 会被 push 到后面的位置。
    // trust hash 的 key 必须用实际 index,否则 codex 端校验失败(静默 Untrusted)。
    const eventToGroupIndex = await this.resolveGroupIndices(def);

    writeTrustedHashes({
      configPath,
      hooksJsonAbsPath,
      hookEvents: def.hook!.events,
      eventToCommand: eventToCmd,
      eventToGroupIndex,
      marker: cfg.marker,
      forceBypass: process.env.LOONGSUITE_PILOT_CODEX_FORCE_BYPASS === '1',
    });

    if (process.env.LOONGSUITE_PILOT_CODEX_FORCE_BYPASS === '1') {
      logger.warn('Codex trust bypass enabled via LOONGSUITE_PILOT_CODEX_FORCE_BYPASS — hook trust verification is DISABLED', { agentId: def.id });
    }

    const verify = verifyTrustHashes({
      configPath,
      hooksJsonAbsPath,
      hookEvents: def.hook!.events,
      eventToCommand: eventToCmd,
      eventToGroupIndex,
      marker: cfg.marker,
    });
    if (!verify.valid) {
      logger.error('codex trust hash verification failed', {
        agentId: def.id,
        mismatches: verify.mismatches,
      });
    } else {
      logger.info('codex trust hash verified', { agentId: def.id });
    }
  }

  async undeploy(def: AgentDefinition): Promise<boolean> {
    const hookDefs = this.buildHookDefinitions(def);
    let allOk = true;
    for (const hookDef of hookDefs) {
      const ok = await this.hookManager.uninstallHook(hookDef);
      if (!ok) allOk = false;
    }

    if (def.hook?.trustToml) {
      try {
        const cfg = def.hook.trustToml;
        const configPath = resolveHome(cfg.configPath);
        const hooksJsonAbsPath = path.resolve(resolveHome(def.hook.settingsPath));
        removeTrustBlock(configPath, cfg.marker, hooksJsonAbsPath, def.hook.events);
      } catch (err) {
        logger.warn('codex trust cleanup failed (non-blocking)', { error: String(err) });
      }
    }

    return allOk;
  }

  /**
   * 回读 hooks.json,找到 pilot hook command 在每个 event 数组中的实际 group index。
   * 支持 nested format({hooks:[{command}]}) 和 flat format({command})两种结构。
   */
  private async resolveGroupIndices(def: AgentDefinition): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    const hookCommand = resolveHome(def.hook!.hookCommand);

    try {
      const settings = await readJsonFile<Record<string, unknown>>(def.hook!.settingsPath);
      const hooks = (settings as any)?.hooks;
      if (!hooks || typeof hooks !== 'object') {
        return result;
      }

      for (const event of def.hook!.events) {
        const arr = hooks[event];
        if (!Array.isArray(arr)) continue;
        const cmd = formatHookCommand(hookCommand, event, def.hook!.eventSubcommand);
        for (let i = 0; i < arr.length; i++) {
          const entry = arr[i];
          // nested: {hooks: [{command}]}
          if (Array.isArray(entry?.hooks)) {
            if (entry.hooks.some((h: any) => h.command === cmd)) {
              result[event] = i;
              break;
            }
          }
          // flat: {command}
          if (entry?.command === cmd) {
            result[event] = i;
            break;
          }
        }
      }
    } catch {
      // 读取失败时 fallback 全 0(首次安装、无其他 hook 时是对的)
    }

    return result;
  }

  private buildHookDefinitions(def: AgentDefinition): HookDefinition[] {
    const hookConfig = def.hook;
    if (!hookConfig) return [];

    return hookConfig.events.map(event => ({
      agentId: def.id,
      settingsPath: hookConfig.settingsPath,
      hookJsonPath: ['hooks', event],
      hookCommand: formatHookCommand(hookConfig.hookCommand, event, hookConfig.eventSubcommand),
      matcher: hookConfig.matcher,
      useNestedFormat: hookConfig.format === 'nested',
      replaceHookCommands: hookConfig.replaceHookCommands,
    }));
  }

  /**
   * Ensure the settings file exists with a valid structure.
   * Handles Cursor's hooks.json which needs a `version` field.
   */
  private async ensureSettingsFile(settingsPath: string): Promise<void> {
    const existing = await readJsonFile<Record<string, unknown>>(settingsPath);
    if (!existing) {
      if (settingsPath.endsWith('hooks.json')) {
        await writeJsonFile(settingsPath, { version: 1, hooks: {} });
      }
    } else if (settingsPath.endsWith('hooks.json') && existing.version === undefined) {
      existing.version = 1;
      await writeJsonFile(settingsPath, existing);
    }
  }
}
