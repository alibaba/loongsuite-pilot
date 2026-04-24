import * as fs from 'node:fs/promises';
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
    this.hookScriptDir = hookScriptDir ?? resolveHome('~/.r2c/hooks');
    this.logBaseDir = logBaseDir ?? resolveHome('~/.r2c/logs');
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

      const hookEntry = {
        type: 'command',
        command: def.hookCommand,
        ...(def.matcher ? { matcher: def.matcher } : {}),
      };

      const existing = (target[lastKey] as any[]).find(
        (h: any) => h.command === def.hookCommand,
      );
      if (existing) {
        logger.debug('hook already installed', { agentId: def.agentId });
        return true;
      }

      (target[lastKey] as any[]).push(hookEntry);
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
        (h: any) => h.command !== def.hookCommand,
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

      return (target[lastKey] as any[]).some(
        (h: any) => h.command === def.hookCommand,
      );
    } catch {
      return false;
    }
  }

  /**
   * Build a standard hook definition for Qoder CLI.
   */
  static buildQoderCliHook(r2cDir?: string): HookDefinition {
    const baseDir = r2cDir ?? resolveHome('~/.r2c');
    return {
      agentId: 'qoder-cli',
      settingsPath: resolveHome('~/.qoder/settings.json'),
      hookJsonPath: ['hooks', 'PostToolUse'],
      hookCommand: `${baseDir}/hooks/qoder-cli-hook.sh`,
      matcher: '.*',
    };
  }

  /**
   * Build a standard hook definition for any MCP-compatible tool
   * that supports PostToolUse hooks.
   */
  static buildGenericHook(opts: {
    agentId: string;
    settingsDir: string;
    r2cDir?: string;
  }): HookDefinition {
    const baseDir = opts.r2cDir ?? resolveHome('~/.r2c');
    return {
      agentId: opts.agentId,
      settingsPath: path.join(opts.settingsDir, 'settings.json'),
      hookJsonPath: ['hooks', 'PostToolUse'],
      hookCommand: `${baseDir}/hooks/${opts.agentId}-hook.sh`,
      matcher: '.*',
    };
  }
}
