import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  AgentDefinition,
  DeployResult,
  DeployStrategy,
  DeployedAgentRecord,
  DshYamlPatchConfig,
} from '../types/index.js';
import { fileExists, resolveHome } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';
import { DshRuntimeLocator, type DshRuntimeTarget } from './dsh-runtime-locator.js';

const logger = createLogger('DshYamlPatchStrategy');

export const DSH_ENABLED_MARKER = '.collection-enabled';

const BEGIN_PREFIX = '# BEGIN ';
const END_PREFIX = '# END ';
const LOCK_SUFFIX = '.loongsuite-pilot.lock';
const LOCK_GATE_SUFFIX = '.reclaim';
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 25;
const STALE_LOCK_MS = 30_000;

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
 *   - Pilot writers share a bounded, stale-recoverable owner-token lock.
 *     Each write reads original bytes → sha256 h0, writes and fsyncs a temp
 *     file, then performs a second byte-hash check immediately before atomic
 *     rename. If the target changed, the temp is removed and composition is
 *     retried once from the newest bytes. Non-cooperating external editors do
 *     not honor the lock, so the final read/rename pair is deliberately not
 *     described as a formal cross-process CAS.
 */
export class DshYamlPatchStrategy implements DeployStrategy {
  private readonly dataDir: string;
  private readonly runtimeLocator: DshRuntimeLocator;

  constructor(dataDir: string, runtimeLocator = new DshRuntimeLocator()) {
    this.dataDir = dataDir;
    this.runtimeLocator = runtimeLocator;
  }

  resolveTarget(def: AgentDefinition, record?: DeployedAgentRecord): Promise<DshRuntimeTarget | null> {
    return this.runtimeLocator.locate(def, record);
  }

  async detect(def: AgentDefinition, record?: DeployedAgentRecord): Promise<boolean> {
    return (await this.resolveTarget(def, record)) !== null;
  }

  async needsDeploy(def: AgentDefinition, record?: DeployedAgentRecord): Promise<boolean> {
    if (!def.dshYamlPatch) return false;
    const target = await this.resolveTarget(def, record);
    if (!target) return true;
    return this.needsDeployAt(def, target);
  }

  async needsDeployAt(def: AgentDefinition, target: DshRuntimeTarget): Promise<boolean> {
    const cfg = def.dshYamlPatch;
    if (!cfg) return false;
    const pluginPath = this.resolvePluginPath(cfg);
    const pluginHash = await this.sha256File(pluginPath);
    if (!pluginHash) return true;
    if (!(await fileExists(this.resolveEnabledMarkerPath(cfg)))) return true;
    const pluginUrl = pathToFileURL(pluginPath).href;
    const fileBytes = await this.readBytes(target.patchPath);
    const parsed = this.splitOnPilotBlock(fileBytes, cfg.marker);
    const block = parsed.existingBlock;
    if (parsed.conflictBlock || !block) return true;
    if (!this.hasMetadataLine(block, `# entryId=${cfg.entryId}`)) return true;
    if (!this.hasMetadataLine(block, `# pluginSource=${pluginUrl}`)) return true;
    if (!this.hasMetadataLine(block, `# pluginHash=${pluginHash}`)) return true;
    return false;
  }

  async deploy(def: AgentDefinition, record?: DeployedAgentRecord): Promise<DeployResult> {
    if (!def.dshYamlPatch) {
      return { success: false, agentId: def.id, deployMode: 'dsh-yaml-patch', error: 'missing dshYamlPatch config' };
    }
    const target = await this.resolveTarget(def, record);
    if (!target) {
      return {
        success: false,
        agentId: def.id,
        deployMode: 'dsh-yaml-patch',
        error: 'DSH runtime target is unavailable',
      };
    }
    return this.deployAt(def, target);
  }

  async deployAt(def: AgentDefinition, target: DshRuntimeTarget): Promise<DeployResult> {
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

    const patchPath = target.patchPath;
    const lockToken = await this.acquirePatchLock(patchPath);
    if (!lockToken) {
      return {
        success: false,
        agentId: def.id,
        deployMode: 'dsh-yaml-patch',
        error: 'timed out waiting for DSH patch lock',
      };
    }

    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const originalBytes = await this.readBytes(patchPath);
        const existedBefore = originalBytes.length > 0 || (await fileExists(patchPath));
        const h0 = this.sha256Bytes(originalBytes);
        const mode = await this.resolveMode(patchPath, existedBefore);

        const parsed = this.splitOnPilotBlock(originalBytes, cfg.marker);
        if (
          parsed.conflictBlock
          || (parsed.existingBlock && !this.hasMetadataLine(parsed.existingBlock, `# entryId=${cfg.entryId}`))
        ) {
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
        if (wrote) {
          try {
            await this.createEnabledMarker(cfg);
          } catch (err) {
            logger.error('failed to enable DSH collection marker', { error: String(err) });
            return {
              success: false,
              agentId: def.id,
              deployMode: 'dsh-yaml-patch',
              error: `failed to create DSH collection marker: ${String(err)}`,
            };
          }
          return { success: true, agentId: def.id, deployMode: 'dsh-yaml-patch' };
        }
        logger.warn('concurrent modification detected, retrying once', { path: patchPath, attempt });
      }
      return {
        success: false,
        agentId: def.id,
        deployMode: 'dsh-yaml-patch',
        error: 'concurrent modification detected; aborting after retry',
      };
    } finally {
      await this.releasePatchLock(patchPath, lockToken);
    }
  }

  async undeploy(def: AgentDefinition, record?: DeployedAgentRecord): Promise<boolean> {
    const cfg = def.dshYamlPatch;
    if (!cfg) return false;
    const target = await this.resolveTarget(def, record);
    if (!target) return false;
    try {
      await this.removeEnabledMarker(cfg);
    } catch (err) {
      logger.warn('failed to disable DSH collection marker', { error: String(err) });
      return false;
    }
    const patchPath = target.patchPath;
    const lockToken = await this.acquirePatchLock(patchPath);
    if (!lockToken) return false;

    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const originalBytes = await this.readBytes(patchPath);
        const existedBefore = originalBytes.length > 0 || (await fileExists(patchPath));
        if (!existedBefore) return true;
        const h0 = this.sha256Bytes(originalBytes);
        const mode = await this.resolveMode(patchPath, true);

        const parsed = this.splitOnPilotBlock(originalBytes, cfg.marker);
        if (
          parsed.conflictBlock
          || (parsed.existingBlock && !this.hasMetadataLine(parsed.existingBlock, `# entryId=${cfg.entryId}`))
        ) {
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
    } finally {
      await this.releasePatchLock(patchPath, lockToken);
    }
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

  private splitOnPilotBlock(
    bytes: Buffer,
    marker: string,
  ): { before: Buffer; existingBlock: string | null; after: Buffer; conflictBlock: boolean } {
    const beginMarker = `${BEGIN_PREFIX}${marker}`;
    const endMarker = `${END_PREFIX}${marker}`;
    const beginOffsets = this.findLineMarkerOffsets(bytes, beginMarker);
    const endOffsets = this.findLineMarkerOffsets(bytes, endMarker);
    if (beginOffsets.length === 0 && endOffsets.length === 0) {
      return { before: bytes, existingBlock: null, after: Buffer.alloc(0), conflictBlock: false };
    }
    if (beginOffsets.length !== 1 || endOffsets.length !== 1) {
      return { before: bytes, existingBlock: null, after: Buffer.alloc(0), conflictBlock: true };
    }

    const beginIdx = beginOffsets[0];
    const endIdx = endOffsets[0];
    if (endIdx <= beginIdx) {
      return { before: bytes, existingBlock: null, after: Buffer.alloc(0), conflictBlock: true };
    }

    const beginLineEnd = this.lineEndOffset(bytes, beginIdx);
    const endLineEnd = this.lineEndOffset(bytes, endIdx);
    const beginLine = bytes.subarray(beginIdx, beginLineEnd).toString('utf-8').replace(/\r$/, '');
    const endLine = bytes.subarray(endIdx, endLineEnd).toString('utf-8').replace(/\r$/, '');
    const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const validBegin = new RegExp(`^${BEGIN_PREFIX}${escapedMarker}(?: \\(created-file: (?:true|false)\\))?$`)
      .test(beginLine);
    const validEnd = endLine === endMarker;
    let blockEnd = endLineEnd;
    if (bytes[blockEnd] === 0x0a) blockEnd += 1;
    const block = bytes.subarray(beginIdx, blockEnd).toString('utf-8');
    const conflict = !validBegin
      || !validEnd
      || !this.hasMetadataPrefix(block, '# entryId=')
      || !this.hasMetadataPrefix(block, '# pluginSource=')
      || !this.hasMetadataPrefix(block, '# pluginHash=');
    return {
      before: bytes.subarray(0, beginIdx),
      existingBlock: block,
      after: bytes.subarray(blockEnd),
      conflictBlock: conflict,
    };
  }

  private findLineMarkerOffsets(bytes: Buffer, marker: string): number[] {
    const needle = Buffer.from(marker, 'utf-8');
    const offsets: number[] = [];
    let from = 0;
    while (from < bytes.length) {
      const index = bytes.indexOf(needle, from);
      if (index < 0) break;
      const atLineStart = index === 0 || bytes[index - 1] === 0x0a;
      const next = index + needle.length;
      const boundary = next === bytes.length
        || bytes[next] === 0x20
        || bytes[next] === 0x09
        || bytes[next] === 0x0d
        || bytes[next] === 0x0a;
      if (atLineStart && boundary) offsets.push(index);
      from = index + needle.length;
    }
    return offsets;
  }

  private lineEndOffset(bytes: Buffer, lineStart: number): number {
    const newline = bytes.indexOf(0x0a, lineStart);
    return newline < 0 ? bytes.length : newline;
  }

  private hasMetadataPrefix(block: string, prefix: string): boolean {
    return block.split(/\r?\n/).some(line => line.startsWith(prefix) && line.length > prefix.length);
  }

  private hasMetadataLine(block: string, expected: string): boolean {
    return block.split(/\r?\n/).includes(expected);
  }

  private extractCreatedFlag(block: string): 'true' | 'false' | null {
    const m = block.match(/created-file:\s*(true|false)/);
    return m ? (m[1] as 'true' | 'false') : null;
  }

  // ─── File I/O ───

  private resolvePluginPath(cfg: DshYamlPatchConfig): string {
    return resolveHome(cfg.pluginSource);
  }

  private resolveEnabledMarkerPath(cfg: DshYamlPatchConfig): string {
    return path.join(path.dirname(this.resolvePluginPath(cfg)), DSH_ENABLED_MARKER);
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
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      const currentBytes = await this.readBytes(target);
      if (this.sha256Bytes(currentBytes) !== h0) return false;

      const handle = await fs.open(tmp, 'wx', mode ?? 0o644);
      try {
        await handle.write(nextBytes);
        await handle.sync();
      } finally {
        await handle.close();
      }

      // Re-check after the temp file is durable. This closes the previous
      // deterministic TOCTOU window where an external edit made during fsync
      // was unconditionally overwritten by rename. A non-cooperating writer
      // can still race the final read/rename pair; Pilot writers share the lock.
      const finalBytes = await this.readBytes(target);
      if (this.sha256Bytes(finalBytes) !== h0) return false;
      await fs.rename(tmp, target);
      await this.syncDirectory(path.dirname(target));
      return true;
    } finally {
      await fs.unlink(tmp).catch(err => {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.warn('failed to remove DSH YAML temp file', { path: tmp, error: String(err) });
        }
      });
    }
  }

  private async deleteIfUnchanged(target: string, h0: string): Promise<boolean> {
    const currentBytes = await this.readBytes(target);
    if (this.sha256Bytes(currentBytes) !== h0) return false;
    const finalBytes = await this.readBytes(target);
    if (this.sha256Bytes(finalBytes) !== h0) return false;
    await fs.unlink(target);
    await this.syncDirectory(path.dirname(target));
    return true;
  }

  private async createEnabledMarker(cfg: DshYamlPatchConfig): Promise<void> {
    const marker = this.resolveEnabledMarkerPath(cfg);
    await fs.mkdir(path.dirname(marker), { recursive: true });
    const tmp = `${marker}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      const handle = await fs.open(tmp, 'wx', 0o600);
      try {
        await handle.write('enabled\n');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tmp, marker);
      if (process.platform !== 'win32') await fs.chmod(marker, 0o600);
      await this.syncDirectory(path.dirname(marker));
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
  }

  private async removeEnabledMarker(cfg: DshYamlPatchConfig): Promise<void> {
    const marker = this.resolveEnabledMarkerPath(cfg);
    try {
      await fs.unlink(marker);
      await this.syncDirectory(path.dirname(marker));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  private async acquirePatchLock(target: string): Promise<string | null> {
    const lockPath = `${target}${LOCK_SUFFIX}`;
    const gatePath = `${lockPath}${LOCK_GATE_SUFFIX}`;
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    const token = `${process.pid}:${crypto.randomBytes(12).toString('hex')}`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (Date.now() <= deadline) {
      const gateToken = await this.acquireOwnerFile(gatePath, deadline);
      if (!gateToken) return null;
      let acquired = false;
      try {
        try {
          const handle = await fs.open(lockPath, 'wx', 0o600);
          try {
            await handle.write(token);
            await handle.sync();
          } finally {
            await handle.close();
          }
          acquired = true;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
          try {
            const stat = await fs.stat(lockPath);
            if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
              // Every cooperating creator, releaser, and stale reclaimer holds
              // gatePath while mutating lockPath. A prior stat can therefore
              // never authorize deletion of a newly-created owner's lock.
              await fs.unlink(lockPath);
            }
          } catch (statErr) {
            if ((statErr as NodeJS.ErrnoException).code !== 'ENOENT') throw statErr;
          }
        }
      } finally {
        await this.releaseOwnerFile(gatePath, gateToken);
      }
      if (acquired) return token;
      await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
    }
    return null;
  }

  private async acquireOwnerFile(filePath: string, deadline: number): Promise<string | null> {
    const token = `${process.pid}:${crypto.randomBytes(12).toString('hex')}`;
    while (Date.now() <= deadline) {
      try {
        const handle = await fs.open(filePath, 'wx', 0o600);
        try {
          await handle.write(token);
          await handle.sync();
        } finally {
          await handle.close();
        }
        return token;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
      }
    }
    return null;
  }

  private async releasePatchLock(target: string, token: string): Promise<void> {
    const lockPath = `${target}${LOCK_SUFFIX}`;
    const gatePath = `${lockPath}${LOCK_GATE_SUFFIX}`;
    const gateToken = await this.acquireOwnerFile(gatePath, Date.now() + LOCK_TIMEOUT_MS);
    if (!gateToken) {
      logger.warn('failed to acquire DSH lock release gate', { path: gatePath });
      return;
    }
    try {
      const owner = await fs.readFile(lockPath, 'utf-8');
      if (owner === token) await fs.unlink(lockPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('failed to release DSH patch lock', { path: lockPath, error: String(err) });
      }
    } finally {
      await this.releaseOwnerFile(gatePath, gateToken);
    }
  }

  private async releaseOwnerFile(filePath: string, token: string): Promise<void> {
    try {
      const owner = await fs.readFile(filePath, 'utf-8');
      if (owner === token) await fs.unlink(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('failed to release DSH owner file', { path: filePath, error: String(err) });
      }
    }
  }

  private async syncDirectory(dir: string): Promise<void> {
    try {
      const handle = await fs.open(dir, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
    } catch {
      // Directory fsync is unsupported on some platforms/filesystems. The
      // temp file itself is already durable, so keep deployment fail-open.
    }
  }
}
