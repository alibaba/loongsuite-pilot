import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  AgentDefinition,
  DeployResult,
  DeployStrategy,
  DeployedAgentRecord,
  DshYamlPatchConfig,
} from '../types/index.js';
import { detectAgent } from './detect-utils.js';
import { fileExists, resolveHome } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('DshYamlPatchStrategy');

const DEFAULT_PATCH_PATH = path.join(os.homedir(), '.dsh', 'cordis.patch.yml');

const BEGIN_PREFIX = '# BEGIN ';
const END_PREFIX = '# END ';

/**
 * Manages a single marked YAML block inside deepseek-harness's machine-wide
 * user patch layer (`$DSH_HOME/cordis.patch.yml`). The block carries one
 * `- insert:` row that loads the Pilot plugin via a `file://` URL.
 *
 * Concurrency / safety contract (architect APPROVED comment 1083c086):
 *   - Only the Pilot-managed BEGIN/END block is ever appended or removed.
 *     Non-Pilot bytes (user rows, comments, formatting) are preserved
 *     verbatim — no `js-yaml.dump` whole-file rewrite.
 *   - The block's BEGIN marker carries `created-file: true|false` so
 *     `undeploy(def)` — which only sees `AgentDefinition`, not in-memory
 *     deploy state — can decide whether to delete a now-empty file
 *     (Pilot created it) or keep it (user pre-existing, even if empty).
 *   - Concurrency: read original bytes → sha256 h0. Compose new bytes,
 *     write tmpfile → fsync → atomic rename. Before rename, re-read
 *     current bytes → sha256 h1. If `h1 !== h0`, abort + retry once
 *     (re-reading h0). `stat` (mtime/size) is a fast-path precheck
 *     only — same size/mtime but different bytes still rejects.
 */
export class DshYamlPatchStrategy implements DeployStrategy {
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  async detect(def: AgentDefinition): Promise<boolean> {
    return detectAgent(def.detection);
  }

  async needsDeploy(def: AgentDefinition, _record?: DeployedAgentRecord): Promise<boolean> {
    const cfg = def.dshYamlPatch;
    if (!cfg) return false;
    const pluginPath = this.resolvePluginPath(cfg);
    const pluginHash = await this.sha256File(pluginPath);
    if (!pluginHash) return true;
    const pluginUrl = pathToFileURL(pluginPath).href;
    const fileBytes = await this.readBytes(this.resolvePatchPath(cfg));
    const block = this.findPilotBlock(fileBytes, cfg.marker);
    if (!block) return true;
    if (!block.includes(`entryId=${cfg.entryId}\n`)) return true;
    if (!block.includes(`pluginSource=${pluginUrl}\n`)) return true;
    if (!block.includes(`pluginHash=${pluginHash}\n`)) return true;
    return false;
  }

  async deploy(def: AgentDefinition): Promise<DeployResult> {
    const cfg = def.dshYamlPatch;
    if (!cfg) {
      return { success: false, agentId: def.id, deployMode: 'dsh-yaml-patch', error: 'missing dshYamlPatch config' };
    }
    const pluginPath = this.resolvePluginPath(cfg);
    const pluginHash = await this.sha256File(pluginPath);
    if (!pluginHash) {
      return {
        success: false,
        agentId: def.id,
        deployMode: 'dsh-yaml-patch',
        error: `plugin file not found or unreadable: ${pluginPath}`,
      };
    }

    const patchPath = this.resolvePatchPath(cfg);

    for (let attempt = 0; attempt < 2; attempt++) {
      const originalBytes = await this.readBytes(patchPath);
      const existedBefore = originalBytes.length > 0 || (await fileExists(patchPath));
      const h0 = this.sha256Bytes(originalBytes);
      const mode = await this.resolveMode(patchPath, existedBefore);

      const parsed = this.splitOnPilotBlock(originalBytes, cfg.marker);
      if (parsed.conflictBlock) {
        return {
          success: false,
          agentId: def.id,
          deployMode: 'dsh-yaml-patch',
          error: `conflict: existing block with marker ${cfg.marker} is not Pilot-managed (path/id mismatch)`,
        };
      }
      let createdFileFlag: boolean;
      if (parsed.existingBlock) {
        const existing = this.extractCreatedFlag(parsed.existingBlock);
        if (existing === 'true' || existing === 'false') {
          createdFileFlag = existing === 'true';
        } else {
          createdFileFlag = !existedBefore;
        }
      } else {
        createdFileFlag = !existedBefore;
      }
      const newBlock = this.composePilotBlock(cfg, pluginHash, createdFileFlag);
      let nextBytes: Buffer;
      if (parsed.existingBlock) {
        nextBytes = Buffer.concat([parsed.before, Buffer.from(newBlock), parsed.after]);
      } else {
        const sep = originalBytes.length > 0 && !originalBytes.toString('utf-8').endsWith('\n')
          ? Buffer.from('\n')
          : Buffer.alloc(0);
        nextBytes = Buffer.concat([originalBytes, sep, Buffer.from(newBlock)]);
      }

      const wrote = await this.atomicWriteIfUnchanged(patchPath, nextBytes, h0, mode);
      if (wrote) return { success: true, agentId: def.id, deployMode: 'dsh-yaml-patch' };
      logger.warn('concurrent modification detected, retrying once', { path: patchPath, attempt });
    }
    return {
      success: false,
      agentId: def.id,
      deployMode: 'dsh-yaml-patch',
      error: 'concurrent modification detected; aborting after retry',
    };
  }

  async undeploy(def: AgentDefinition): Promise<boolean> {
    const cfg = def.dshYamlPatch;
    if (!cfg) return false;
    const patchPath = this.resolvePatchPath(cfg);

    for (let attempt = 0; attempt < 2; attempt++) {
      const originalBytes = await this.readBytes(patchPath);
      const existedBefore = originalBytes.length > 0 || (await fileExists(patchPath));
      if (!existedBefore) return true;
      const h0 = this.sha256Bytes(originalBytes);
      const mode = await this.resolveMode(patchPath, true);

      const parsed = this.splitOnPilotBlock(originalBytes, cfg.marker);
      if (parsed.conflictBlock) {
        logger.warn('undeploy refused: existing block marker mismatch', { path: patchPath });
        return false;
      }
      if (!parsed.existingBlock) {
        return true;
      }

      const createdFile = this.extractCreatedFlag(parsed.existingBlock);
      const nextBytes = Buffer.concat([parsed.before, parsed.after]);

      if (createdFile === 'true' && nextBytes.toString('utf-8').trim().length === 0) {
        const changed = await this.deleteIfUnchanged(patchPath, h0);
        if (changed) return true;
        logger.warn('concurrent modification during undeploy delete, retrying', { path: patchPath, attempt });
        continue;
      }

      const wrote = await this.atomicWriteIfUnchanged(patchPath, nextBytes, h0, mode);
      if (wrote) return true;
      logger.warn('concurrent modification during undeploy, retrying', { path: patchPath, attempt });
    }
    return false;
  }

  // ─── Block composition / parsing ───

  private composePilotBlock(cfg: DshYamlPatchConfig, pluginHash: string, createdFile?: boolean): string {
    const pluginUrl = pathToFileURL(this.resolvePluginPath(cfg)).href;
    const flag = createdFile === undefined ? '' : ` (created-file: ${createdFile ? 'true' : 'false'})`;
    return [
      `${BEGIN_PREFIX}${cfg.marker}${flag}`,
      `# entryId=${cfg.entryId}`,
      `# pluginSource=${pluginUrl}`,
      `# pluginHash=${pluginHash}`,
      '- insert:',
      `  - id: 'loongsuite-pilot-observability'`,
      `    name: ${pluginUrl}`,
      `${END_PREFIX}${cfg.marker}`,
      '',
    ].join('\n');
  }

  private findPilotBlock(bytes: Buffer, marker: string): string | null {
    const text = bytes.toString('utf-8');
    const beginIdx = text.indexOf(`${BEGIN_PREFIX}${marker}`);
    if (beginIdx < 0) return null;
    const endIdx = text.indexOf(`${END_PREFIX}${marker}`, beginIdx);
    if (endIdx < 0) return null;
    return text.slice(beginIdx, endIdx + `${END_PREFIX}${marker}`.length);
  }

  private splitOnPilotBlock(
    bytes: Buffer,
    marker: string,
  ): { before: Buffer; existingBlock: string | null; after: Buffer; conflictBlock: boolean } {
    const text = bytes.toString('utf-8');
    const beginMarker = `${BEGIN_PREFIX}${marker}`;
    const endMarker = `${END_PREFIX}${marker}`;
    const beginIdx = text.indexOf(beginMarker);
    if (beginIdx < 0) {
      return { before: bytes, existingBlock: null, after: Buffer.alloc(0), conflictBlock: false };
    }
    const endIdx = text.indexOf(endMarker, beginIdx);
    if (endIdx < 0) {
      return { before: bytes, existingBlock: null, after: Buffer.alloc(0), conflictBlock: false };
    }
    let blockEnd = endIdx + endMarker.length;
    if (text[blockEnd] === '\n') blockEnd += 1;
    const block = text.slice(beginIdx, blockEnd);
    const conflict = !block.includes(`# entryId=`) || !block.includes(`# pluginSource=`) || !block.includes(`# pluginHash=`);
    const before = text.slice(0, beginIdx);
    const after = text.slice(blockEnd);
    return {
      before: Buffer.from(before, 'utf-8'),
      existingBlock: block,
      after: Buffer.from(after, 'utf-8'),
      conflictBlock: conflict,
    };
  }

  private extractCreatedFlag(block: string): 'true' | 'false' | null {
    const m = block.match(/created-file:\s*(true|false)/);
    return m ? (m[1] as 'true' | 'false') : null;
  }

  // ─── File I/O ───

  private resolvePluginPath(cfg: DshYamlPatchConfig): string {
    return resolveHome(cfg.pluginSource);
  }

  private resolvePatchPath(cfg: DshYamlPatchConfig): string {
    const fromEnv = process.env.DSH_HOME;
    if (cfg.patchPath) return resolveHome(cfg.patchPath);
    if (fromEnv) return path.join(fromEnv, 'cordis.patch.yml');
    return DEFAULT_PATCH_PATH;
  }

  private async readBytes(p: string): Promise<Buffer> {
    try {
      return await fs.readFile(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0);
      throw err;
    }
  }

  private async resolveMode(p: string, existed: boolean): Promise<number | undefined> {
    if (!existed) return 0o644;
    try {
      const stat = await fs.stat(p);
      return stat.mode & 0o777;
    } catch {
      return 0o644;
    }
  }

  private async sha256File(p: string): Promise<string | null> {
    try {
      const buf = await fs.readFile(p);
      return this.sha256Bytes(buf);
    } catch {
      return null;
    }
  }

  private sha256Bytes(buf: Buffer): string {
    return crypto.createHash('sha256').update(buf).digest('hex');
  }

  /**
   * Atomic write guarded by byte-hash. Returns false if the file changed
   * between read and write (caller may retry). tmpfile → fsync → rename.
   */
  private async atomicWriteIfUnchanged(
    target: string,
    nextBytes: Buffer,
    h0: string,
    mode: number | undefined,
  ): Promise<boolean> {
    const currentBytes = await this.readBytes(target);
    const h1 = this.sha256Bytes(currentBytes);
    if (h1 !== h0) return false;

    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    const handle = await fs.open(tmp, 'w', mode ?? 0o644);
    try {
      await handle.write(nextBytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, target);
    return true;
  }

  private async deleteIfUnchanged(target: string, h0: string): Promise<boolean> {
    const currentBytes = await this.readBytes(target);
    const h1 = this.sha256Bytes(currentBytes);
    if (h1 !== h0) return false;
    await fs.unlink(target);
    return true;
  }
}
