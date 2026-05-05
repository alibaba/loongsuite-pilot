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

export interface HookDefinition {
  /** Agent identifier (e.g. "qoder-cli", "claude"). */
  agentId: string;
  /** Path to the agent's settings file (e.g. ~/.qoder/settings.json). */
  settingsPath: string;
  /** JSON path to inject hooks into (e.g. ["hooks", "PostToolUse"]). */
  hookJsonPath: string[];
  /** The hook command to inject. */
  hookCommand: string;
  /** Matcher pattern for the hook. */
  matcher?: string;
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

      if (this.isCommandPresent(arr, def.hookCommand)) {
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

      arr.push(hookEntry);
      await writeJsonFile(def.settingsPath, settings);

      // Ensure log directory for this agent
      await ensureDir(path.join(this.logBaseDir, def.agentId, 'history'));

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

      return this.isCommandPresent(target[lastKey] as any[], def.hookCommand);
    } catch {
      return false;
    }
  }

  /**
   * Build hook definitions for Cursor.
   * Registers cursor-loongpilot-hook.sh into ~/.cursor/hooks.json for key events.
   */
  static buildCursorHooks(loongsuitePilotDir?: string): HookDefinition[] {
    const baseDir = loongsuitePilotDir ?? resolveHome('~/.loongsuite-pilot');
    const command = `${baseDir}/hooks/cursor-loongpilot-hook.sh`;
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
      agentId: 'cursor-hook',
      settingsPath,
      hookJsonPath: ['hooks', event],
      hookCommand: command,
    }));
  }

  /**
   * Build hook definitions for Qoder CLI (Stop only).
   */
  static buildQoderCliHooks(loongsuitePilotDir?: string): HookDefinition[] {
    const baseDir = loongsuitePilotDir ?? resolveHome('~/.loongsuite-pilot');
    const command = `${baseDir}/hooks/qoder-loongpilot-hook.sh qoder-cli`;
    const settingsPath = resolveHome('~/.qoder/settings.json');

    return [
      {
        agentId: 'qoder-cli',
        settingsPath,
        hookJsonPath: ['hooks', 'Stop'],
        hookCommand: command,
        matcher: '*',
        useNestedFormat: true,
      },
    ];
  }

  /**
   * Build hook definitions for QoderWork (Stop only).
   * Reuses the same hook script as Qoder CLI, passing "qoder-work" as agent ID.
   */
  static buildQoderWorkHooks(loongsuitePilotDir?: string): HookDefinition[] {
    const baseDir = loongsuitePilotDir ?? resolveHome('~/.loongsuite-pilot');
    const command = `${baseDir}/hooks/qoder-loongpilot-hook.sh qoder-work`;
    const settingsPath = resolveHome('~/.qoderwork/settings.json');

    return [
      {
        agentId: 'qoder-work',
        settingsPath,
        hookJsonPath: ['hooks', 'Stop'],
        hookCommand: command,
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
      hookCommand: `${baseDir}/hooks/${opts.agentId}-hook.sh`,
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
}
