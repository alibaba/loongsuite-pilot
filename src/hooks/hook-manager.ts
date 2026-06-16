import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import {
  readJsonFile,
  writeJsonFile,
  ensureDir,
  resolveHome,
  fileExists,
} from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('HookManager');
const hookExt = process.platform === 'win32' ? '.ps1' : '.sh';
const isWin = process.platform === 'win32';

function wrapHookCommand(scriptPath: string, args?: string): string {
  if (!isWin) return args ? `${scriptPath} ${args}` : scriptPath;
  const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`;
  return args ? `${cmd} ${args}` : cmd;
}

export interface HookDefinition {
  /** Agent identifier (e.g. "qoder", "claude"). */
  agentId: string;
  /** Path to the agent's settings file (e.g. ~/.qoder/settings.json). */
  settingsPath: string;
  /** JSON path to inject hooks into (e.g. ["hooks", "PostToolUse"]). */
  hookJsonPath: string[];
  /** The hook command to inject. */
  hookCommand: string;
  /** Matcher pattern for the hook. */
  matcher?: string;
  /** Optional explicit history log directory for agents whose control id differs from storage path. */
  historyDir?: string;
  /** Hook commands that should be removed when installing this definition. */
  replaceHookCommands?: string[];
  /**
   * If true, use Qoder's nested format:
   *   { matcher: "...", hooks: [{ command, type }] }
   * Otherwise use flat format:
   *   { command, type, matcher }
   */
  useNestedFormat?: boolean;
}

/**
 * Manages installation and removal of hook scripts into AI tools' config files.
 *
 * Hook injection flow:
 *   1. Read tool's settings.json
 *   2. Navigate to the hookJsonPath
 *   3. Append the hook command entry if not already present
 *   4. Write back settings.json
 */
export class HookManager {
  private readonly hookScriptDir: string;
  private readonly logBaseDir: string;

  constructor(hookScriptDir?: string, logBaseDir?: string) {
    this.hookScriptDir = hookScriptDir ?? resolveHome('~/.loongsuite-pilot/hooks');
    this.logBaseDir = logBaseDir ?? resolveHome('~/.loongsuite-pilot/logs');
  }

  /**
   * Install a hook into the target tool's configuration.
   */
  async installHook(def: HookDefinition): Promise<boolean> {
    try {
      await ensureDir(path.dirname(def.settingsPath));
      const settings = (await readJsonFile<Record<string, unknown>>(def.settingsPath)) ?? {};

      let target: any = settings;
      for (let i = 0; i < def.hookJsonPath.length - 1; i++) {
        const key = def.hookJsonPath[i];
        if (!target[key] || typeof target[key] !== 'object') {
          target[key] = {};
        }
        target = target[key];
      }

      const lastKey = def.hookJsonPath[def.hookJsonPath.length - 1];
      if (!Array.isArray(target[lastKey])) {
        target[lastKey] = [];
      }

      const arr = target[lastKey] as any[];

      if (def.replaceHookCommands?.length) {
        target[lastKey] = this.removeCommands(arr, def.replaceHookCommands);
      }

      const updatedArr = target[lastKey] as any[];

      if (this.isCommandPresent(updatedArr, def.hookCommand)) {
        if (updatedArr !== arr) {
          await writeJsonFile(def.settingsPath, settings);
        }
        logger.debug('hook already installed', { agentId: def.agentId });
        return true;
      }

      const hookEntry = def.useNestedFormat
        ? {
            matcher: def.matcher ?? '*',
            hooks: [{ command: def.hookCommand, type: 'command' }],
          }
        : {
            type: 'command',
            command: def.hookCommand,
            ...(def.matcher ? { matcher: def.matcher } : {}),
          };

      updatedArr.push(hookEntry);
      await writeJsonFile(def.settingsPath, settings);

      // Ensure log directory for this agent
      await ensureDir(def.historyDir ?? path.join(this.logBaseDir, def.agentId, 'history'));

      logger.info('hook installed', { agentId: def.agentId });
      return true;
    } catch (err) {
      logger.error('hook installation failed', {
        agentId: def.agentId,
        error: String(err),
      });
      return false;
    }
  }

  /**
   * Remove a previously installed hook.
   */
  async uninstallHook(def: HookDefinition): Promise<boolean> {
    try {
      const settings = await readJsonFile<Record<string, unknown>>(def.settingsPath);
      if (!settings) return true;

      let target: any = settings;
      for (let i = 0; i < def.hookJsonPath.length - 1; i++) {
        const key = def.hookJsonPath[i];
        if (!target[key]) return true;
        target = target[key];
      }

      const lastKey = def.hookJsonPath[def.hookJsonPath.length - 1];
      if (!Array.isArray(target[lastKey])) return true;

      target[lastKey] = (target[lastKey] as any[]).filter(
        (h: any) => !this.entryMatchesCommand(h, def.hookCommand),
      );

      await writeJsonFile(def.settingsPath, settings);
      logger.info('hook uninstalled', { agentId: def.agentId });
      return true;
    } catch (err) {
      logger.error('hook uninstall failed', { agentId: def.agentId, error: String(err) });
      return false;
    }
  }

  /**
   * Check if a hook is currently installed.
   */
  async isHookInstalled(def: HookDefinition): Promise<boolean> {
    try {
      const settings = await readJsonFile<Record<string, unknown>>(def.settingsPath);
      if (!settings) return false;

      let target: any = settings;
      for (const key of def.hookJsonPath.slice(0, -1)) {
        if (!target[key]) return false;
        target = target[key];
      }

      const lastKey = def.hookJsonPath[def.hookJsonPath.length - 1];
      if (!Array.isArray(target[lastKey])) return false;

      const hooks = target[lastKey] as any[];
      if (def.replaceHookCommands?.some(command => this.isCommandPresent(hooks, command))) {
        return false;
      }

      return this.isCommandPresent(hooks, def.hookCommand);
    } catch {
      return false;
    }
  }

  /**
   * Build hook definitions for Cursor.
   * Registers cursor-loongsuite-pilot-hook.sh into ~/.cursor/hooks.json for key events.
   */
  static buildCursorHooks(loongsuitePilotDir?: string): HookDefinition[] {
    const baseDir = loongsuitePilotDir ?? resolveHome('~/.loongsuite-pilot');
    const command = wrapHookCommand(`${baseDir}/hooks/cursor-loongsuite-pilot-hook${hookExt}`);
    const settingsPath = resolveHome('~/.cursor/hooks.json');

    const events = [
      'stop',
      'preToolUse',
      'postToolUse',
      'postToolUseFailure',
      'beforeSubmitPrompt',
      'preCompact',
      'sessionStart',
      'sessionEnd',
      'subagentStart',
      'subagentStop',
      'afterAgentResponse',
      'afterAgentThought',
    ];

    return events.map(event => ({
      agentId: 'cursor',
      settingsPath,
      hookJsonPath: ['hooks', event],
      hookCommand: command,
      historyDir: path.join(baseDir, 'logs', 'cursor', 'history'),
    }));
  }

  /**
   * Build hook definitions for Qoder CLI (Stop only).
   */
  static buildQoderCliHooks(loongsuitePilotDir?: string): HookDefinition[] {
    const baseDir = loongsuitePilotDir ?? resolveHome('~/.loongsuite-pilot');
    const command = wrapHookCommand(`${baseDir}/hooks/qoder-loongsuite-pilot-hook${hookExt}`, 'qoder');
    const settingsPath = resolveHome('~/.qoder/settings.json');

    return [
      {
        agentId: 'qoder',
        settingsPath,
        hookJsonPath: ['hooks', 'Stop'],
        hookCommand: command,
        matcher: '*',
        useNestedFormat: true,
      },
    ];
  }

  /**
   * Build hook definitions for Qoder Work (Stop only).
   */
  static buildQoderWorkHooks(loongsuitePilotDir?: string): HookDefinition[] {
    const baseDir = loongsuitePilotDir ?? resolveHome('~/.loongsuite-pilot');
    const command = wrapHookCommand(`${baseDir}/hooks/qoderwork-loongsuite-pilot-hook${hookExt}`);
    const legacyCommand = wrapHookCommand(`${baseDir}/hooks/qoder-loongsuite-pilot-hook${hookExt}`, 'qoder-work');
    const settingsPath = resolveHome('~/.qoderwork/settings.json');

    const replaceCmds = [legacyCommand];
    if (isWin) {
      replaceCmds.push(`${baseDir}/hooks/qoderwork-loongsuite-pilot-hook.sh`);
      replaceCmds.push(`${baseDir}/hooks/qoderwork-loongsuite-pilot-hook.ps1`);
      replaceCmds.push(`${baseDir}/hooks/qoder-loongsuite-pilot-hook.sh qoder-work`);
      replaceCmds.push(`${baseDir}/hooks/qoder-loongsuite-pilot-hook.ps1 qoder-work`);
    }

    return [
      {
        agentId: 'qoder-work',
        settingsPath,
        hookJsonPath: ['hooks', 'Stop'],
        hookCommand: command,
        replaceHookCommands: replaceCmds,
        matcher: '*',
        useNestedFormat: true,
      },
    ];
  }

  static buildQoderWorkCNHooks(loongsuitePilotDir?: string): HookDefinition[] {
    const baseDir = loongsuitePilotDir ?? resolveHome('~/.loongsuite-pilot');
    const command = wrapHookCommand(`${baseDir}/hooks/qoderworkcn-loongsuite-pilot-hook${hookExt}`);
    const legacyCommand = wrapHookCommand(`${baseDir}/hooks/qoder-loongsuite-pilot-hook${hookExt}`, 'qoder-work-cn');
    const settingsPath = resolveHome('~/.qoderworkcn/settings.json');

    const replaceCmds = [legacyCommand];
    if (isWin) {
      replaceCmds.push(`${baseDir}/hooks/qoderworkcn-loongsuite-pilot-hook.sh`);
      replaceCmds.push(`${baseDir}/hooks/qoderworkcn-loongsuite-pilot-hook.ps1`);
      replaceCmds.push(`${baseDir}/hooks/qoder-loongsuite-pilot-hook.sh qoder-work-cn`);
      replaceCmds.push(`${baseDir}/hooks/qoder-loongsuite-pilot-hook.ps1 qoder-work-cn`);
    }

    return [
      {
        agentId: 'qoder-work-cn',
        settingsPath,
        hookJsonPath: ['hooks', 'Stop'],
        hookCommand: command,
        replaceHookCommands: replaceCmds,
        matcher: '*',
        useNestedFormat: true,
      },
    ];
  }

  /**
   * @deprecated Use buildQoderCliHooks() instead.
   */
  static buildQoderCliHook(loongsuitePilotDir?: string): HookDefinition {
    return HookManager.buildQoderCliHooks(loongsuitePilotDir)[1];
  }

  /**
   * Build a standard hook definition for any MCP-compatible tool
   * that supports PostToolUse hooks.
   */
  static buildGenericHook(opts: {
    agentId: string;
    settingsDir: string;
    loongsuitePilotDir?: string;
  }): HookDefinition {
    const baseDir = opts.loongsuitePilotDir ?? resolveHome('~/.loongsuite-pilot');
    return {
      agentId: opts.agentId,
      settingsPath: path.join(opts.settingsDir, 'settings.json'),
      hookJsonPath: ['hooks', 'PostToolUse'],
      hookCommand: wrapHookCommand(`${baseDir}/hooks/${opts.agentId}-hook${hookExt}`),
      matcher: '*',
    };
  }

  /**
   * Check if a command string exists in a hook array entry,
   * supporting both flat ({ command }) and nested ({ hooks: [{ command }] }) formats.
   */
  private entryMatchesCommand(entry: any, command: string): boolean {
    if (entry.command === command) return true;
    if (Array.isArray(entry.hooks)) {
      return entry.hooks.some((h: any) => h.command === command);
    }
    return false;
  }

  private isCommandPresent(arr: any[], command: string): boolean {
    return arr.some((entry: any) => this.entryMatchesCommand(entry, command));
  }

  private removeCommands(arr: any[], commands: string[]): any[] {
    return arr
      .map((entry: any) => this.removeCommandsFromEntry(entry, commands))
      .filter((entry: any) => entry !== null);
  }

  private removeCommandsFromEntry(entry: any, commands: string[]): any | null {
    if (commands.includes(entry.command)) return null;
    if (!Array.isArray(entry.hooks)) return entry;

    const hooks = entry.hooks.filter((h: any) => !commands.includes(h.command));
    if (hooks.length === 0) return null;
    if (hooks.length === entry.hooks.length) return entry;
    return { ...entry, hooks };
  }
}
