import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentDefinition, DeployedAgentRecord } from '../types/index.js';
import { resolveHome } from '../utils/fs-utils.js';
import { detectAgent } from './detect-utils.js';

const DSH_PATCH_FILENAME = 'cordis.patch.yml';
const MAX_PROC_FILE_BYTES = 4 * 1024 * 1024;

export type DshRuntimeTargetSource =
  | 'persisted'
  | 'configured-patch'
  | 'pilot-env'
  | 'running-process'
  | 'standard-detection';

/** One deterministic Harness home and the machine-wide patch it consumes. */
export interface DshRuntimeTarget {
  home: string;
  patchPath: string;
  source: DshRuntimeTargetSource;
  pid?: number;
}

export interface DshRuntimeLocatorOptions {
  /** Injectable Linux procfs root for deterministic tests. */
  procRoot?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  cwd?: () => string;
  uid?: number;
}

/**
 * Locate the exact Harness home used by the DSH YAML-patch lifecycle.
 *
 * This is intentionally DSH-specific. Generic Agent detection returns only a
 * boolean and cannot carry the home that must later receive the patch. Keeping
 * discovery and target selection together prevents a running DSH process from
 * being detected at one path while Pilot writes another.
 */
export class DshRuntimeLocator {
  private readonly procRoot: string;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd: () => string;
  private readonly uid: number | undefined;

  constructor(options: DshRuntimeLocatorOptions = {}) {
    this.procRoot = options.procRoot ?? '/proc';
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.cwd = options.cwd ?? (() => process.cwd());
    this.uid = options.uid ?? process.getuid?.();
  }

  async locate(def: AgentDefinition, record?: DeployedAgentRecord): Promise<DshRuntimeTarget | null> {
    const cfg = def.dshYamlPatch;
    if (!cfg) return null;

    // A persisted path is lifecycle ownership: repair and uninstall must keep
    // managing the exact file Pilot originally changed even if service env drifts.
    if (record?.dshPatchPath && path.isAbsolute(record.dshPatchPath)) {
      const patchPath = path.resolve(record.dshPatchPath);
      return this.targetFromPatchPath(patchPath, 'persisted');
    }

    // Explicit definition configuration remains the highest-ranked initial target.
    if (cfg.patchPath) {
      const patchPath = path.resolve(resolveHome(cfg.patchPath));
      return this.targetFromPatchPath(patchPath, 'configured-patch');
    }

    const pilotHome = this.resolveHomeValue(this.env.DSH_HOME, this.cwd());
    if (pilotHome) return this.targetFromHome(pilotHome, 'pilot-env');

    const running = await this.locateRunningProcess();
    if (running) return running;

    // Preserve the existing standard-install contract. A detected command uses
    // DSH's default home because no overriding home was discoverable.
    if (await detectAgent(def.detection)) {
      return this.targetFromHome(path.join(os.homedir(), '.dsh'), 'standard-detection');
    }

    return null;
  }

  private async locateRunningProcess(): Promise<DshRuntimeTarget | null> {
    if (this.platform !== 'linux') return null;

    let entries: string[];
    try {
      entries = await fs.readdir(this.procRoot);
    } catch {
      return null;
    }

    const candidates = new Map<string, number[]>();
    for (const entry of entries.filter(name => /^\d+$/.test(name)).sort((a, b) => Number(a) - Number(b))) {
      const pid = Number(entry);
      const processDir = path.join(this.procRoot, entry);
      if (!(await this.isOwnedProcess(processDir))) continue;

      const cmdline = await this.readProcFile(path.join(processDir, 'cmdline'));
      if (!cmdline || !this.isDshCommandLine(cmdline)) continue;

      const environ = await this.readProcFile(path.join(processDir, 'environ'));
      const rawHome = environ ? this.readEnvironmentValue(environ, 'DSH_HOME') : undefined;
      if (!rawHome) continue;

      let processCwd: string | undefined;
      if (!path.isAbsolute(resolveHome(rawHome))) {
        try {
          processCwd = await fs.readlink(path.join(processDir, 'cwd'));
        } catch {
          continue;
        }
      }
      const home = this.resolveHomeValue(rawHome, processCwd);
      if (!home) continue;
      const pids = candidates.get(home) ?? [];
      pids.push(pid);
      candidates.set(home, pids);
    }

    if (candidates.size === 0) return null;
    if (candidates.size > 1) {
      const homes = [...candidates.keys()].sort().map(home => JSON.stringify(home)).join(', ');
      throw new Error(`ambiguous DSH runtime homes discovered from running processes: ${homes}`);
    }

    const [[home, pids]] = [...candidates.entries()];
    return this.targetFromHome(home, 'running-process', pids[0]);
  }

  private async isOwnedProcess(processDir: string): Promise<boolean> {
    if (this.uid === undefined) return true;
    try {
      return (await fs.stat(processDir)).uid === this.uid;
    } catch {
      return false;
    }
  }

  private async readProcFile(filename: string): Promise<Buffer | null> {
    try {
      const bytes = await fs.readFile(filename);
      return bytes.length <= MAX_PROC_FILE_BYTES ? bytes : null;
    } catch {
      // Processes may exit between procfs enumeration and reads; discovery is best effort.
      return null;
    }
  }

  private isDshCommandLine(bytes: Buffer): boolean {
    const args = bytes.toString('utf8').split('\0').filter(Boolean);
    const executable = path.basename(args[0] ?? '').toLowerCase();
    if (executable === 'dsh' || executable === 'dsh.exe') return true;
    if (executable !== 'node' && executable !== 'node.exe' && executable !== 'nodejs') return false;
    const script = args[1] ?? '';
    return path.basename(script).toLowerCase() === 'dsh'
      || script.replace(/\\/g, '/').endsWith('/@deepseek-ai/dsh/lib/bin.js');
  }

  private readEnvironmentValue(bytes: Buffer, name: string): string | undefined {
    const prefix = `${name}=`;
    for (const field of bytes.toString('utf8').split('\0')) {
      if (field.startsWith(prefix)) return field.slice(prefix.length);
    }
    return undefined;
  }

  private resolveHomeValue(raw: string | undefined, cwd: string | undefined): string | null {
    if (!raw || raw.trim().length === 0) return null;
    const expanded = resolveHome(raw);
    if (path.isAbsolute(expanded)) return path.resolve(expanded);
    return cwd ? path.resolve(cwd, expanded) : null;
  }

  private targetFromHome(home: string, source: DshRuntimeTargetSource, pid?: number): DshRuntimeTarget {
    return {
      home,
      patchPath: path.join(home, DSH_PATCH_FILENAME),
      source,
      ...(pid === undefined ? {} : { pid }),
    };
  }

  private targetFromPatchPath(patchPath: string, source: DshRuntimeTargetSource): DshRuntimeTarget {
    return { home: path.dirname(patchPath), patchPath, source };
  }
}
