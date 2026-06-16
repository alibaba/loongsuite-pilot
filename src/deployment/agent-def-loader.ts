import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentDefinition } from '../types/index.js';
import { resolveHome } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('AgentDefLoader');

const REQUIRED_FIELDS: (keyof AgentDefinition)[] = ['id', 'displayName', 'deployMode', 'detection'];

export interface AgentDefLoaderOptions {
  builtinDir: string;
  localDir: string;
  pilotDir: string;
  dataDir: string;
}

export class AgentDefLoader {
  private readonly builtinDir: string;
  private readonly localDir: string;
  private readonly pilotDir: string;
  private readonly dataDir: string;

  constructor(opts: AgentDefLoaderOptions) {
    this.builtinDir = opts.builtinDir;
    this.localDir = opts.localDir;
    this.pilotDir = opts.pilotDir;
    this.dataDir = opts.dataDir;
  }

  async load(): Promise<AgentDefinition[]> {
    const builtin = await this.loadFromDir(this.builtinDir);
    const local = await this.loadFromDir(this.localDir);

    const merged = new Map<string, AgentDefinition>();
    for (const def of builtin) {
      merged.set(def.id, def);
    }
    for (const def of local) {
      merged.set(def.id, def);
    }

    const result = [...merged.values()];
    logger.info('agent definitions loaded', {
      builtin: builtin.length,
      local: local.length,
      total: result.length,
    });
    return result;
  }

  private async loadFromDir(dir: string): Promise<AgentDefinition[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      logger.debug('agent definition directory not found', { dir });
      return [];
    }

    const defs: AgentDefinition[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json') || path.basename(entry).startsWith('._')) continue;
      const filePath = path.join(dir, entry);
      try {
        const raw = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const resolved = this.resolveVariables(parsed) as unknown as AgentDefinition;

        if (!this.validate(resolved, filePath)) continue;

        defs.push(resolved);
      } catch (err) {
        logger.warn('failed to parse agent definition', { file: filePath, error: String(err) });
      }
    }
    return defs;
  }

  private validate(def: unknown, filePath: string): def is AgentDefinition {
    if (!def || typeof def !== 'object') {
      logger.warn('invalid agent definition: not an object', { file: filePath });
      return false;
    }
    const obj = def as Record<string, unknown>;
    for (const field of REQUIRED_FIELDS) {
      if (obj[field] === undefined || obj[field] === null) {
        logger.warn('invalid agent definition: missing required field', { file: filePath, field });
        return false;
      }
    }
    const mode = obj.deployMode;
    if (mode !== 'hook' && mode !== 'plugin-probe' && mode !== 'plugin-inject') {
      logger.warn('invalid agent definition: unknown deployMode', { file: filePath, deployMode: mode });
      return false;
    }
    return true;
  }

  private resolveVariables(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = this.resolveValue(value);
    }
    return result;
  }

  private resolveValue(value: unknown): unknown {
    if (typeof value === 'string') {
      return this.resolveString(value);
    }
    if (Array.isArray(value)) {
      return value.map(v => this.resolveValue(v));
    }
    if (value && typeof value === 'object') {
      return this.resolveVariables(value as Record<string, unknown>);
    }
    return value;
  }

  private resolveString(s: string): string {
    let result = s
      .replace(/\$PILOT_DIR/g, this.pilotDir)
      .replace(/\$PILOT_DATA/g, this.dataDir);

    result = resolveHome(result);

    if (process.platform === 'win32') {
      result = result.replace(/\.sh$/, '.ps1');
    }
    return result;
  }
}
