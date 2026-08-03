import * as path from 'node:path';
import {
  writeJsonFile,
  writeTextFileAtomic,
  ensureDir,
  resolveHome,
} from '../utils/fs-utils.js';
import {
  editJsonc,
  parseJsonDocument,
  readJsonDocument,
  type JsonSyntax,
} from '../utils/json-document.js';
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
  /** File syntax. Defaults to strict JSON. */
  settingsSyntax?: JsonSyntax;
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
  /**
   * Optional shell declared on the nested hook entry's inner object
   * (`{ command, type, shell }`). Set for hosts (Qoder family on Windows) that
   * need `"shell": "powershell"` to run the `.ps1` command through PowerShell.
   * Only emitted when set, so agents that omit it (e.g. codex) are unaffected.
   */
  shell?: string;
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
      if (def.settingsSyntax === 'jsonc') {
        return await this.installJsoncHook(def);
      }

      const document = await readJsonDocument<Record<string, unknown>>(
        def.settingsPath,
        'json',
      );
      if (document.status === 'error') {
        throw new Error(`refusing to overwrite invalid settings: ${document.error.message}`);
      }
      const settings = document.status === 'missing' || document.status === 'empty'
        ? {}
        : this.requireSettingsObject(document.data);

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
            hooks: [{
              command: def.hookCommand,
              type: 'command',
              ...(def.shell ? { shell: def.shell } : {}),
            }],
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
      if (def.settingsSyntax === 'jsonc') {
        return await this.uninstallJsoncHook(def);
      }

      const document = await readJsonDocument<Record<string, unknown>>(
        def.settingsPath,
        'json',
      );
      if (document.status === 'missing' || document.status === 'empty') return true;
      if (document.status === 'error') {
        throw new Error(`refusing to overwrite invalid settings: ${document.error.message}`);
      }
      const settings = this.requireSettingsObject(document.data);

      let target: any = settings;
      for (let i = 0; i < def.hookJsonPath.length - 1; i++) {
        const key = def.hookJsonPath[i];
        if (!target[key]) return true;
        target = target[key];
      }

      const lastKey = def.hookJsonPath[def.hookJsonPath.length - 1];
      if (!Array.isArray(target[lastKey])) return true;

      const commands = [def.hookCommand, ...(def.replaceHookCommands ?? [])];
      target[lastKey] = this.removeCommands(target[lastKey] as any[], commands);
      if ((target[lastKey] as any[]).length === 0) {
        delete target[lastKey];
      }

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
      const document = await readJsonDocument<Record<string, unknown>>(
        def.settingsPath,
        def.settingsSyntax ?? 'json',
      );
      if (document.status !== 'ok') return false;
      const settings = this.requireSettingsObject(document.data);

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

  private async installJsoncHook(def: HookDefinition): Promise<boolean> {
    const document = await readJsonDocument<Record<string, unknown>>(
      def.settingsPath,
      'jsonc',
    );
    if (document.status === 'error') {
      throw new Error(`refusing to overwrite invalid settings: ${document.error.message}`);
    }

    const expected = document.status === 'missing'
      ? { exists: false as const }
      : { exists: true as const, content: document.raw };
    let raw = document.status === 'missing' || document.status === 'empty'
      ? '{}\n'
      : document.raw;
    const settings = document.status === 'missing' || document.status === 'empty'
      ? {}
      : this.requireSettingsObject(document.data);
    const existingValue = this.valueAtPath(settings, def.hookJsonPath);
    if (existingValue !== undefined && !Array.isArray(existingValue)) {
      throw new Error(`hook path is not an array: ${def.hookJsonPath.join('.')}`);
    }

    if (def.replaceHookCommands?.length && Array.isArray(existingValue)) {
      raw = this.removeCommandsFromJsonc(
        raw,
        def.hookJsonPath,
        existingValue,
        def.replaceHookCommands,
      );
    }

    const reparsed = parseJsonDocument<Record<string, unknown>>(raw, 'jsonc');
    if (!reparsed.ok) throw reparsed.error;
    const currentValue = this.valueAtPath(
      this.requireSettingsObject(reparsed.data),
      def.hookJsonPath,
    );
    if (currentValue !== undefined && !Array.isArray(currentValue)) {
      throw new Error(`hook path is not an array: ${def.hookJsonPath.join('.')}`);
    }
    const hooks = currentValue ?? [];

    if (!this.isCommandPresent(hooks, def.hookCommand)) {
      const hookEntry = this.buildHookEntry(def);
      raw = currentValue === undefined
        ? editJsonc(raw, def.hookJsonPath, [hookEntry])
        : editJsonc(
            raw,
            [...def.hookJsonPath, hooks.length],
            hookEntry,
            { isArrayInsertion: true },
          );
    }

    if (document.status === 'ok' && raw === document.raw) {
      logger.debug('hook already installed', { agentId: def.agentId });
      return true;
    }

    await writeTextFileAtomic(def.settingsPath, raw, {
      expected,
      backupPath: document.status === 'missing'
        ? undefined
        : `${def.settingsPath}.loongsuite-pilot.bak`,
    });
    await ensureDir(def.historyDir ?? path.join(this.logBaseDir, def.agentId, 'history'));
    logger.info('hook installed', { agentId: def.agentId });
    return true;
  }

  private async uninstallJsoncHook(def: HookDefinition): Promise<boolean> {
    const document = await readJsonDocument<Record<string, unknown>>(
      def.settingsPath,
      'jsonc',
    );
    if (document.status === 'missing' || document.status === 'empty') return true;
    if (document.status === 'error') {
      throw new Error(`refusing to overwrite invalid settings: ${document.error.message}`);
    }

    const settings = this.requireSettingsObject(document.data);
    const existingValue = this.valueAtPath(settings, def.hookJsonPath);
    if (existingValue === undefined) return true;
    if (!Array.isArray(existingValue)) {
      throw new Error(`hook path is not an array: ${def.hookJsonPath.join('.')}`);
    }

    const commands = [def.hookCommand, ...(def.replaceHookCommands ?? [])];
    const raw = this.removeCommandsFromJsonc(
      document.raw,
      def.hookJsonPath,
      existingValue,
      commands,
    );
    if (raw === document.raw) return true;

    await writeTextFileAtomic(def.settingsPath, raw, {
      expected: { exists: true, content: document.raw },
      backupPath: `${def.settingsPath}.loongsuite-pilot.bak`,
    });
    logger.info('hook uninstalled', { agentId: def.agentId });
    return true;
  }

  private removeCommandsFromJsonc(
    source: string,
    hookPath: string[],
    entries: unknown[],
    commands: string[],
  ): string {
    let raw = source;
    for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex--) {
      const entry = entries[entryIndex] as any;
      if (commands.includes(entry?.command)) {
        raw = editJsonc(raw, [...hookPath, entryIndex], undefined);
        continue;
      }
      if (!Array.isArray(entry?.hooks)) continue;

      const matching: number[] = [];
      for (let hookIndex = entry.hooks.length - 1; hookIndex >= 0; hookIndex--) {
        if (commands.includes(entry.hooks[hookIndex]?.command)) {
          matching.push(hookIndex);
        }
      }
      if (matching.length === entry.hooks.length && matching.length > 0) {
        raw = editJsonc(raw, [...hookPath, entryIndex], undefined);
        continue;
      }
      for (const hookIndex of matching) {
        raw = editJsonc(raw, [...hookPath, entryIndex, 'hooks', hookIndex], undefined);
      }
    }
    return raw;
  }

  private buildHookEntry(def: HookDefinition): Record<string, unknown> {
    return def.useNestedFormat
      ? {
          matcher: def.matcher ?? '*',
          hooks: [{
            command: def.hookCommand,
            type: 'command',
            ...(def.shell ? { shell: def.shell } : {}),
          }],
        }
      : {
          type: 'command',
          command: def.hookCommand,
          ...(def.matcher ? { matcher: def.matcher } : {}),
        };
  }

  private valueAtPath(root: Record<string, unknown>, jsonPath: string[]): unknown {
    let current: unknown = root;
    for (const key of jsonPath) {
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  }

  private requireSettingsObject(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('settings root must be a JSON object');
    }
    return value as Record<string, unknown>;
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
