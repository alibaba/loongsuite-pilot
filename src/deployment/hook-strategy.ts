import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  AgentDefinition,
  AgentHookConfig,
  DeployResult,
  DeployStrategy,
  DeployedAgentRecord,
} from '../types/index.js';
import { HookManager, type HookDefinition } from '../hooks/hook-manager.js';
import {
  fileExists,
  readJsonFile,
  writeJsonFile,
  writeTextFileAtomic,
  resolveHome,
  ensureDir,
} from '../utils/fs-utils.js';
import { detectAgent } from './detect-utils.js';
import { createLogger } from '../utils/logger.js';
import {
  CODEX_HOOK_EVENT_KEYS,
  type InstalledCodexCommandHandler,
  type InstalledCodexHookLocation,
  installedHookStateKey,
  writeTrustedHashes,
  removeTrustBlock,
  removeTrustStateKeys,
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
function wrapLegacyPs1Command(cmd: string): string {
  if (process.platform !== 'win32') return cmd;
  const parts = cmd.split(' ');
  const script = parts[0];
  if (!script.endsWith('.ps1')) return cmd;
  const args = parts.slice(1).join(' ');
  const wrapped = `powershell -NoProfile -ExecutionPolicy Bypass -File ${script}`;
  return args ? `${wrapped} ${args}` : wrapped;
}

function wrapPs1Command(cmd: string, agentId: string): string {
  if (process.platform !== 'win32' || (agentId !== 'codex' && agentId !== 'grok-build')) {
    return wrapLegacyPs1Command(cmd);
  }

  const match = cmd.match(/^(.*?\.ps1)(?:\s+(.*))?$/i);
  if (!match) return cmd;
  const script = match[1];
  const args = match[2] ?? '';
  const wrapped = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${script}"`;
  return args ? `${wrapped} ${args}` : wrapped;
}

function appendEventSubcommand(
  command: string,
  event: string,
  style: AgentHookConfig['eventSubcommand'],
): string {
  if (style === 'kebab-case') {
    return `${command} ${eventToSubcommand(event)}`;
  }
  if (style === 'as-is') {
    return `${command} ${event}`;
  }
  return command;
}

/**
 * Pick the right settings path for the current platform.
 * Round 8 fix (PR #233, addressing fangxiu-wf review): agents that ship
 * a per-platform settings location (e.g. the official MiniMax Code
 * 3.0.60 Windows client writes to `%APPDATA%\MiniMax\settings.json`)
 * declare the Windows path in `settingsPathWindows`; everywhere else
 * we fall back to the POSIX `settingsPath`.
 */
function resolvePlatformSettingsPath(hookConfig: AgentHookConfig): string {
  if (process.platform === 'win32' && hookConfig.settingsPathWindows) {
    return hookConfig.settingsPathWindows;
  }
  return hookConfig.settingsPath;
}

/**
 * Pick the right hook command for the current platform. Mirrors
 * `resolvePlatformSettingsPath` but for the hook script — some agents
 * ship a dedicated `.ps1` (e.g. MiniMax Code) so the AgentDefLoader's
 * automatic `.sh` -> `.ps1` extension rewrite points at a file that
 * actually exists in the deployed `assets/hooks/` directory.
 */
function resolvePlatformHookCommand(hookConfig: AgentHookConfig): string {
  if (process.platform === 'win32' && hookConfig.hookCommandWindows) {
    return hookConfig.hookCommandWindows;
  }
  return hookConfig.hookCommand;
}

/**
 * 拼 hooks.json 中实际写入的 command 字符串。
 * 必须与 codex trust hash 算用的字符串完全一致。
 */
function formatHookCommand(
  hookCommand: string,
  event: string,
  style: AgentHookConfig['eventSubcommand'],
  agentId: string,
): string {
  return appendEventSubcommand(wrapPs1Command(hookCommand, agentId), event, style);
}

function legacyQuotedPs1HookCommands(
  hookCommand: string,
  event: string,
  style: AgentHookConfig['eventSubcommand'],
  agentId: string,
): string[] {
  if (process.platform !== 'win32' || (agentId !== 'codex' && agentId !== 'grok-build')) return [];

  const current = formatHookCommand(hookCommand, event, style, agentId);
  return [...new Set([
    appendEventSubcommand(hookCommand, event, style),
    appendEventSubcommand(wrapLegacyPs1Command(hookCommand), event, style),
  ])].filter(command => command !== current);
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
    if (await this.needsSettingsRepairForCodex(def)) {
      return true;
    }

    // Round 8 fix (PR #233, addressing fangxiu-wf review finding #5):
    // validate that the settings file's extraSettings match the agent
    // def's required values. Without this, a user (or third-party tool)
    // that flips `hooks.enabled = false` would have the deployment
    // reported healthy even though no events will ever fire.
    if (await this.needsExtraSettingsRepair(def)) {
      return true;
    }

    if (def.hook?.kiroAgent) {
      return this.kiroAgentNeedsDeploy(def);
    }

    const hookDefs = this.buildHookDefinitions(def);
    for (const hookDef of hookDefs) {
      if (!(await this.hookManager.isHookInstalled(hookDef))) {
        return true;
      }
    }
    for (const retiredDef of this.buildRetiredHookDefinitions(def)) {
      if (await this.hookManager.isHookInstalled(retiredDef)) {
        return true;
      }
    }
    if (await this.needsTrustRepairForCodex(def)) {
      return true;
    }
    return false;
  }

  private async needsExtraSettingsRepair(def: AgentDefinition): Promise<boolean> {
    const extra = def.hook?.extraSettings;
    if (!extra || Object.keys(extra).length === 0) return false;

    const settingsPath = resolvePlatformSettingsPath(def.hook!);
    const existing =
      (await readJsonFile<Record<string, unknown>>(settingsPath)) ?? {};
    return this.diffExtraSettings(existing, extra).length > 0;
  }

  /**
   * Walk the existing settings object and the agent def's required
   * extraSettings. Return a list of dot-paths whose values differ (or
   * are missing on the existing side). The list is empty when the
   * existing file already has every required value, so the deployment
   * is healthy and needs no repair.
   */
  private diffExtraSettings(
    existing: Record<string, unknown>,
    required: Record<string, unknown>,
    prefix = '',
  ): string[] {
    const mismatches: string[] = [];
    for (const [key, expected] of Object.entries(required)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const actual = existing[key];
      if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
        if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
          mismatches.push(path);
          continue;
        }
        mismatches.push(
          ...this.diffExtraSettings(
            actual as Record<string, unknown>,
            expected as Record<string, unknown>,
            path,
          ),
        );
      } else if (actual !== expected) {
        mismatches.push(path);
      }
    }
    return mismatches;
  }

  private async needsSettingsRepairForCodex(def: AgentDefinition): Promise<boolean> {
    const settingsPath = def.hook?.settingsPath;
    if (!settingsPath) return false;

    const isCodexHooksJson = settingsPath.endsWith('hooks.json') && settingsPath.includes('.codex');
    if (!isCodexHooksJson) return false;

    const existing = await readJsonFile<Record<string, unknown>>(settingsPath);
    return existing?.version !== undefined;
  }

  private async needsTrustRepairForCodex(def: AgentDefinition): Promise<boolean> {
    const cfg = def.hook?.trustToml;
    if (!cfg || !def.hook) return false;
    try {
      const locations = await this.resolveInstalledCodexHooks(def);
      return !verifyTrustHashes({
        configPath: resolveHome(cfg.configPath),
        hooksJsonAbsPath: path.resolve(resolveHome(def.hook.settingsPath)),
        locations,
        marker: cfg.marker,
      }).valid;
    } catch (err) {
      logger.warn('could not resolve installed Codex hooks for trust verification', {
        agentId: def.id,
        error: String(err),
      });
      return true;
    }
  }

  async deploy(def: AgentDefinition): Promise<DeployResult> {
    const hookConfig = def.hook;
    if (!hookConfig) {
      return { success: false, agentId: def.id, deployMode: 'hook', error: 'missing hook config' };
    }

    // Round 8 fix (PR #233, addressing fangxiu-wf review): the official
    // MiniMax Code 3.0.60 Windows desktop client stores settings under
    // a per-platform location (`%APPDATA%\MiniMax\settings.json`), not
    // the POSIX `~/.minimax-code/`. Resolve per-platform so the Windows
    // AgentDefLoader's `*.sh` -> `*.ps1` rewrite (driven by `hookCommand`)
    // uses a settings path that actually exists on Windows.
    const resolvedSettingsPath = resolvePlatformSettingsPath(hookConfig);
    const resolvedHookCommand = resolvePlatformHookCommand(hookConfig);

    try {
      await this.ensureSettingsFile(resolvedSettingsPath);

      // Kiro CLI: settingsPath 是整个 Agent 定义 JSON，需要顶层 name + tools +
      // hooks:<event>:[{command, matcher}]（flat，无 type 字段）。
      // NOTE: this branch returns early — it does NOT run retiredEvents cleanup
      // or env injection (applyEnvToSettings). kiro-cli.json currently declares
      // neither field, so this is a no-op today; if retiredEvents/env are added
      // later, deployKiroAgent must handle them explicitly (or route through the
      // standard flow) — don't assume the shared path covers them.
      if (hookConfig.kiroAgent) {
        await this.deployKiroAgent(def);
        logger.info('hooks deployed', { agentId: def.id, events: hookConfig.events.length });
        return { success: true, agentId: def.id, deployMode: 'hook' };
      }

      const retiredHookDefs = this.buildRetiredHookDefinitions(def);
      let retiredTrustKeys: string[] = [];
      if (hookConfig.trustToml && retiredHookDefs.length > 0) {
        try {
          const retiredEvents = retiredHookDefs.map(
            definition => definition.hookJsonPath.at(-1)!,
          );
          const locations = await this.resolveInstalledCodexHooks(def, retiredEvents, true);
          const hooksJsonAbsPath = path.resolve(resolveHome(hookConfig.settingsPath));
          retiredTrustKeys = Object.values(locations).map(
            location => installedHookStateKey(hooksJsonAbsPath, location),
          );
        } catch (err) {
          // Cleanup must be conservative: if ownership cannot be proven from the
          // installed handler, leave stale state behind rather than deleting a
          // third-party hook's position-based trust entry.
          logger.warn('could not resolve retired Codex hook trust ownership', {
            agentId: def.id,
            error: String(err),
          });
        }
      }
      for (const retiredHookDef of retiredHookDefs) {
        const removed = await this.hookManager.uninstallHook(retiredHookDef);
        if (!removed) {
          return { success: false, agentId: def.id, deployMode: 'hook', error: 'failed to remove retired hook event' };
        }
      }
      if (hookConfig.trustToml && retiredHookDefs.length > 0) {
        const trust = hookConfig.trustToml;
        removeTrustStateKeys(
          resolveHome(trust.configPath),
          retiredTrustKeys,
        );
      }

      if (hookConfig.env) {
        try {
          await this.applyEnvToSettings(hookConfig.settingsPath, hookConfig.env);
        } catch (err) {
          // env injection failure must not block hook deployment — pilot can still
          // collect the basic transcript-based events without preload.
          logger.warn('settings.env merge failed (non-blocking)', {
            agentId: def.id,
            error: String(err),
          });
        }
      }

      if (hookConfig.extraSettings) {
        try {
          await this.applyExtraSettings(
            hookConfig.settingsPath,
            hookConfig.extraSettings,
          );
        } catch (err) {
          // extraSettings merge failure must not block hook deployment — pilot
          // can still write the hook entry; the sibling flag (e.g.
          // settings.hooks.enabled=true) is a soft requirement.
          logger.warn('settings.extraSettings merge failed (non-blocking)', {
            agentId: def.id,
            error: String(err),
          });
        }
      }

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

      // Codex 类 hook 需要写 trust hash 到 config.toml。
      // Hook trust bypass 仅是 Codex 进程级 CLI 参数，不是合法的 config.toml 字段；
      // Pilot 不拥有 Codex 启动入口，因此这里不能提供 bypass 通道。
      if (hookConfig.trustToml) {
        await this.writeCodexTrust(def);
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
   * 定位、写入或本地校验失败时必须阻止 deploy 成功，避免产生“hook 存在但不可执行”
   * 的静默部署状态。
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
    const locations = await this.resolveInstalledCodexHooks(def);

    const changed = writeTrustedHashes({
      configPath,
      hooksJsonAbsPath,
      locations,
      marker: cfg.marker,
    });

    const verify = verifyTrustHashes({
      configPath,
      hooksJsonAbsPath,
      locations,
      marker: cfg.marker,
    });
    if (!verify.valid) {
      throw new Error(`codex trust hash verification failed: ${verify.mismatches.join('; ')}`);
    }
    logger.info('codex trust block self-check passed', { agentId: def.id, changed });
  }

  async undeploy(def: AgentDefinition): Promise<boolean> {
    // Mirror deploy(): also remove retiredEvents (e.g. codex's PreToolUse/
    // PostToolUse from an older version). Otherwise disabling a codex agent
    // that was first deployed by an old build leaves those retired hooks
    // firing, since current events don't cover them.
    const retiredHookDefs = this.buildRetiredHookDefinitions(def);
    const hookDefs = [...this.buildHookDefinitions(def), ...retiredHookDefs];
    let ownedTrustKeys: string[] = [];
    if (def.hook?.trustToml) {
      try {
        const events = hookDefs.map(hookDef => hookDef.hookJsonPath.at(-1)!);
        const locations = await this.resolveInstalledCodexHooks(def, events, true);
        const hooksJsonAbsPath = path.resolve(resolveHome(def.hook.settingsPath));
        ownedTrustKeys = Object.values(locations).map(
          location => installedHookStateKey(hooksJsonAbsPath, location),
        );
      } catch (err) {
        logger.warn('could not resolve Codex hook trust ownership before undeploy', {
          agentId: def.id,
          error: String(err),
        });
      }
    }
    let allOk = true;
    for (const hookDef of hookDefs) {
      const ok = await this.hookManager.uninstallHook(hookDef);
      if (!ok) allOk = false;
    }

    // Round 8 fix (PR #233, addressing fangxiu-wf review finding #5):
    // roll back the extraSettings we set during deploy so the user's
    // settings file returns to its original shape. We do not have a
    // "snapshot of pre-deploy values" record, so the rollback is
    // best-effort: we delete leaf keys that exactly match what we
    // wrote. If the user originally had a non-default value (e.g.
    // `hooks.enabled = true` they set themselves), they can re-set
    // it after undeploy.
    if (def.hook?.extraSettings && Object.keys(def.hook.extraSettings).length > 0) {
      try {
        await this.removeExtraSettings(def.hook);
      } catch (err) {
        logger.warn('settings.extraSettings rollback failed (non-blocking)', {
          agentId: def.id,
          error: String(err),
        });
      }
    }

    if (def.hook?.trustToml) {
      try {
        const cfg = def.hook.trustToml;
        const configPath = resolveHome(cfg.configPath);
        removeTrustBlock(configPath, cfg.marker, ownedTrustKeys);
      } catch (err) {
        logger.warn('codex trust cleanup failed (non-blocking)', { error: String(err) });
      }
    }

    return allOk;
  }


  /** Resolve each exact installed Pilot handler. Ambiguity is unsafe for trust. */
  private async resolveInstalledCodexHooks(
    def: AgentDefinition,
    eventNames: readonly string[] = def.hook!.events,
    allowMissing = false,
  ): Promise<Record<string, InstalledCodexHookLocation>> {
    const result: Record<string, InstalledCodexHookLocation> = {};
    const hookCommand = resolveHome(def.hook!.hookCommand);
    const settingsPath = resolveHome(def.hook!.settingsPath);
    const settings = await readJsonFile<Record<string, unknown>>(settingsPath);
    const hooks = (settings as { hooks?: Record<string, unknown> } | null)?.hooks;
    if (!hooks || typeof hooks !== 'object') {
      throw new Error(`installed hooks object missing: ${settingsPath}`);
    }

    for (const eventName of eventNames) {
      const eventKey = CODEX_HOOK_EVENT_KEYS[eventName];
      if (!eventKey) throw new Error(`Unknown hook event: ${eventName}`);
      const groups = hooks[eventName];
      if (!Array.isArray(groups)) {
        if (allowMissing) continue;
        throw new Error(`installed hook event missing: ${eventName}`);
      }
      const command = formatHookCommand(
        hookCommand, eventName, def.hook!.eventSubcommand, def.id,
      );
      const matches: InstalledCodexHookLocation[] = [];
      groups.forEach((rawGroup, groupIndex) => {
        if (!rawGroup || typeof rawGroup !== 'object') return;
        const group = rawGroup as Record<string, unknown>;
        const handlers = Array.isArray(group.hooks) ? group.hooks : [group];
        handlers.forEach((rawHandler, handlerIndex) => {
          if (!rawHandler || typeof rawHandler !== 'object') return;
          const handler = rawHandler as Record<string, unknown>;
          if (handler.command !== command) return;
          if (handler.type !== undefined && handler.type !== 'command') return;
          const installed: InstalledCodexCommandHandler = {
            type: 'command',
            command,
            ...(typeof handler.commandWindows === 'string'
              ? { commandWindows: handler.commandWindows }
              : typeof handler.command_windows === 'string'
                ? { commandWindows: handler.command_windows }
                : {}),
            ...(typeof handler.timeout === 'number' ? { timeout: handler.timeout } : {}),
            ...(typeof handler.async === 'boolean' ? { async: handler.async } : {}),
            ...(typeof handler.statusMessage === 'string' ? { statusMessage: handler.statusMessage } : {}),
            ...(typeof handler.additionalContextLimit === 'number'
              ? { additionalContextLimit: handler.additionalContextLimit }
              : {}),
          };
          matches.push({
            eventName,
            eventKey,
            groupIndex,
            handlerIndex: Array.isArray(group.hooks) ? handlerIndex : 0,
            ...(typeof group.matcher === 'string' ? { matcher: group.matcher } : {}),
            handler: installed,
          });
        });
      });
      if (matches.length === 0 && allowMissing) continue;
      if (matches.length !== 1) {
        throw new Error(
          `expected exactly one installed Pilot handler for ${eventName}; found ${matches.length}`,
        );
      }
      result[eventName] = matches[0]!;
    }
    return result;
  }

  private buildHookDefinitions(def: AgentDefinition): HookDefinition[] {
    const hookConfig = def.hook;
    if (!hookConfig) return [];

    // Round 4 (PR #233): honor `hookContainerPath` (default ['hooks']) so
    // agents with non-standard config schemas (ZCode, MiniMax Code nest
    // event arrays under settings.hooks.events.<event>) get their hooks
    // written to the correct JSON path. Mirrors PR #101 hook-strategy
    // change.
    //
    // Round 8 (PR #233): per-platform settingsPath + hookCommand so the
    // Windows hook entry points at the per-platform settings JSON and
    // ships a real `.ps1` (the old code wrote the POSIX settingsPath +
    // POSIX hookCommand, then the .sh -> .ps1 extension rewrite in
    // AgentDefLoader pointed at a .ps1 file that did not exist in the
    // package).
    const containerPath = hookConfig.hookContainerPath ?? ['hooks'];
    const settingsPath = resolvePlatformSettingsPath(hookConfig);
    const hookCommand = resolvePlatformHookCommand(hookConfig);
    return hookConfig.events.map(event => ({
      agentId: def.id,
      settingsPath,
      settingsSyntax: hookConfig.settingsSyntax,
      hookJsonPath: [...containerPath, event],
      hookCommand: formatHookCommand(
        hookCommand, event, hookConfig.eventSubcommand, def.id,
      ),
      matcher: hookConfig.eventMatchers?.[event] ?? hookConfig.matcher,
      useNestedFormat: hookConfig.format === 'nested',
      shell: process.platform === 'win32' ? hookConfig.winShell : undefined,
      replaceHookCommands: [
        ...(hookConfig.replaceHookCommands ?? []),
        ...legacyQuotedPs1HookCommands(
          hookConfig.hookCommand, event, hookConfig.eventSubcommand, def.id,
        ),
      ],
    }));
  }

  private buildRetiredHookDefinitions(def: AgentDefinition): HookDefinition[] {
    const hookConfig = def.hook;
    if (!hookConfig?.retiredEvents?.length) return [];
    const currentEvents = new Set(hookConfig.events);
    const containerPath = hookConfig.hookContainerPath ?? ['hooks'];
    const settingsPath = resolvePlatformSettingsPath(hookConfig);
    const hookCommand = resolvePlatformHookCommand(hookConfig);
    return [...new Set(hookConfig.retiredEvents)]
      .filter(event => !currentEvents.has(event))
      .map(event => ({
        agentId: def.id,
        settingsPath,
        settingsSyntax: hookConfig.settingsSyntax,
        hookJsonPath: [...containerPath, event],
        hookCommand: formatHookCommand(
          hookCommand, event, hookConfig.eventSubcommand, def.id,
        ),
        matcher: hookConfig.eventMatchers?.[event] ?? hookConfig.matcher,
        useNestedFormat: hookConfig.format === 'nested',
        replaceHookCommands: [
          ...(hookConfig.replaceHookCommands ?? []),
          ...legacyQuotedPs1HookCommands(
            hookConfig.hookCommand, event, hookConfig.eventSubcommand, def.id,
          ),
        ],
      }));
  }

  /**
   * Merge env entries from the agent hook config into the settings file's
   * top-level `env` block. Supports `$PILOT_DATA` token expansion.
   *
   * Idempotency:
   *   - Regular keys overwrite if already present.
   *   - `BUN_OPTIONS` is treated as a space-separated flag list. If the
   *     existing value already contains the same `--preload=<path>` we are
   *     about to add, the write is skipped (allows coexistence with user's
   *     own preload scripts).
   *
   * Failure here is non-fatal — caller in deploy() wraps in try/catch.
   */
  private async applyEnvToSettings(
    settingsPath: string,
    env: Record<string, string>,
  ): Promise<void> {
    // NOTE: $PILOT_DATA tokens in `env` values are already resolved by
    // AgentDefLoader.resolveVariables() before the config reaches here
    // (see agent-def-loader.ts), so no further expansion is needed.
    const existing =
      (await readJsonFile<Record<string, unknown>>(settingsPath)) ?? {};
    const envBlock =
      (existing.env as Record<string, string> | undefined) ?? {};
    let changed = false;

    for (const [key, value] of Object.entries(env)) {
      if (key === 'BUN_OPTIONS') {
        const current = envBlock[key];
        if (typeof current === 'string' && current.length > 0) {
          // Match against full whitespace-delimited tokens to avoid a
          // superstring false-positive (e.g., `...intercept.mjs-debug`
          // would otherwise be treated as already containing our path).
          const ourTokens = value.split(/\s+/).filter(Boolean);
          const currentTokens = current.split(/\s+/).filter(Boolean);
          if (ourTokens.every((t) => currentTokens.includes(t))) {
            continue; // already injected (exact tokens present)
          }
          envBlock[key] = `${current} ${value}`.trim();
          changed = true;
          continue;
        }
      }

      if (envBlock[key] !== value) {
        envBlock[key] = value;
        changed = true;
      }
    }

    if (!changed) return;
    existing.env = envBlock;
    await writeJsonFile(settingsPath, existing);
    logger.info('settings.env merged', { settingsPath, keys: Object.keys(env) });
  }

  /**
   * Round 4 (PR #233): Deep-merge `extraSettings` into the agent's settings
   * file. Used by agents like ZCode / MiniMax Code that require a sibling
   * flag (e.g. `settings.hooks.enabled = true`) for the registered hook
   * entries to actually fire.
   *
   * Merge semantics: walk both trees, overwrite at leaf level, recurse into
   * nested objects without blowing away sibling keys the user already
   * configured (preserves `model` / `provider` etc.). Mirrors PR #101.
   */
  private async applyExtraSettings(
    settingsPath: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    const existing =
      (await readJsonFile<Record<string, unknown>>(settingsPath)) ?? {};

    const mergeLeaf = (
      target: Record<string, unknown>,
      src: Record<string, unknown>,
    ): boolean => {
      let changed = false;
      for (const [key, value] of Object.entries(src)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const child = (target[key] as Record<string, unknown> | undefined) ?? {};
          if (typeof child !== 'object' || Array.isArray(child)) {
            target[key] = value;
            changed = true;
            continue;
          }
          if (mergeLeaf(child, value as Record<string, unknown>)) {
            target[key] = child;
            changed = true;
          }
        } else {
          if (target[key] !== value) {
            target[key] = value;
            changed = true;
          }
        }
      }
      return changed;
    };

    const changed = mergeLeaf(existing, extra);
    if (!changed) return;
    await writeJsonFile(settingsPath, existing);
    logger.info('settings.extraSettings merged', { settingsPath, keys: Object.keys(extra) });
  }

  /**
   * Kiro CLI Agent 定义 JSON（~/.kiro/agents/<name>.json）专用 deploy。
   *
   * 文件结构（round3 实证，hook.rs Hook 扁平结构无 type 字段）：
   *   { "name": "...", "tools": [...], "hooks": { "<event>": [{"command": "..."}] } }
   * 每个 hook 条目是 flat {command, matcher?}（无 type 字段，否则 Kiro loader 拒绝）。
   */
  private async deployKiroAgent(def: AgentDefinition): Promise<void> {
    const hookConfig = def.hook!;
    const settingsPath = resolveHome(hookConfig.settingsPath);
    const agent = hookConfig.kiroAgent!;
    const hookCommandBase = resolveHome(hookConfig.hookCommand);

    await ensureDir(path.dirname(settingsPath));
    const existing = (await readJsonFile<Record<string, unknown>>(settingsPath)) ?? {};

    const merged: Record<string, unknown> = { ...existing };
    merged['name'] = agent.name;
    merged['tools'] = agent.tools;

    const hooks = (merged['hooks'] && typeof merged['hooks'] === 'object')
      ? { ...(merged['hooks'] as Record<string, unknown>) }
      : {};

    for (const event of hookConfig.events) {
      const cmd = formatHookCommand(hookCommandBase, event, hookConfig.eventSubcommand, def.id);
      const entry: Record<string, unknown> = { command: cmd };
      if (hookConfig.matcher) entry['matcher'] = hookConfig.matcher;

      const arr = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
      // 移除旧的 pilot hook 条目（command 以 hookCommandBase 开头），保留第三方
      const filtered = arr.filter((e) => {
        const existingCmd = (e as any)?.command;
        return typeof existingCmd !== 'string' || !existingCmd.startsWith(hookCommandBase);
      });
      // 幂等：已存在则不重复 push
      const present = filtered.some((e) => (e as any)?.command === cmd);
      if (!present) filtered.push(entry);
      hooks[event] = filtered;
    }

    merged['hooks'] = hooks;
    await writeJsonFile(settingsPath, merged);

    // Make pilot-kiro the default agent so users can run `kiro-cli` without
    // `--agent pilot-kiro`. Only set when missing — don't override a user's
    // explicit choice (they can still pass --agent for a one-off override).
    await this.setKiroDefaultAgentIfMissing(agent.name);
  }

  /**
   * Set `chat.defaultAgent = <agentName>` in ~/.kiro/settings/cli.json when not
   * already set, so kiro-cli launches with the pilot agent by default.
   */
  private async setKiroDefaultAgentIfMissing(agentName: string): Promise<void> {
    // NOTE: distinct from hookConfig.settingsPath (~/.kiro/agents/pilot-kiro.json).
    // This is Kiro's CLI-level settings file — a different concern (default-agent
    // selection, not the agent definition). Kiro fixes both paths; if the config
    // root ever moves, update this literal alongside settingsPath rather than
    // coupling them via a new config field (they're not 1:1 related).
    const cliSettingsPath = resolveHome('~/.kiro/settings/cli.json');
    try {
      await ensureDir(path.dirname(cliSettingsPath));
      const cli = (await readJsonFile<Record<string, unknown>>(cliSettingsPath)) ?? {};
      const cur = cli['chat.defaultAgent'];
      if (typeof cur === 'string' && cur.length > 0) return; // respect existing choice
      cli['chat.defaultAgent'] = agentName;
      await writeJsonFile(cliSettingsPath, cli);
      logger.info('kiro default agent set', { path: cliSettingsPath, agent: agentName });
    } catch (err) {
      logger.warn('failed to set kiro default agent', { error: String(err) });
    }
  }

  private async kiroAgentNeedsDeploy(def: AgentDefinition): Promise<boolean> {
    const hookConfig = def.hook!;
    const settings = await readJsonFile<Record<string, unknown>>(resolveHome(hookConfig.settingsPath));
    if (!settings) return true;
    const hooks = settings['hooks'] as Record<string, unknown> | undefined;
    if (!hooks || typeof hooks !== 'object') return true;
    const base = resolveHome(hookConfig.hookCommand);
    for (const event of hookConfig.events) {
      const cmd = formatHookCommand(base, event, hookConfig.eventSubcommand, def.id);
      const arr = hooks[event];
      if (!Array.isArray(arr)) return true;
      const found = arr.some((e) => (e as any)?.command === cmd);
      if (!found) return true;
    }
    return false;
  }

  /**
   * Ensure the settings file exists with a valid structure.
   * Cursor's hooks.json requires a `version` field; Codex's does NOT
   * (Codex uses `#[serde(deny_unknown_fields)]` and only allows `hooks`).
   */
  private async ensureSettingsFile(settingsPath: string): Promise<void> {
    const isHooksJson = settingsPath.endsWith('hooks.json');
    if (!isHooksJson) return;

    const needsVersion = isHooksJson && settingsPath.includes('.cursor');
    const existed = await fileExists(settingsPath);
    const existing = await readJsonFile<Record<string, unknown>>(settingsPath);
    if (existed && !existing) {
      const raw = await fs.readFile(settingsPath, 'utf8');
      if (raw.trim() !== '') {
        throw new Error(`refusing to overwrite invalid settings: ${settingsPath}`);
      }

      const initial: Record<string, unknown> = { hooks: {} };
      if (needsVersion) {
        initial.version = 1;
      }
      await writeTextFileAtomic(
        settingsPath,
        `${JSON.stringify(initial, null, 2)}\n`,
        { expected: { exists: true, content: raw } },
      );
      return;
    }
    if (!existing) {
      const initial: Record<string, unknown> = { hooks: {} };
      if (needsVersion) {
        initial.version = 1;
      }
      await writeJsonFile(settingsPath, initial);
    } else if (needsVersion && existing.version === undefined) {
      existing.version = 1;
      await writeJsonFile(settingsPath, existing);
    } else if (isHooksJson && settingsPath.includes('.codex') && existing.version !== undefined) {
      // Clean up stale `version` field previously injected by older pilot versions.
      // Codex uses #[serde(deny_unknown_fields)] and rejects any key other than `hooks`.
      delete existing.version;
      await writeJsonFile(settingsPath, existing);
    }
  }
}
