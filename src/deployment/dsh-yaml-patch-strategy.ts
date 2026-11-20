import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { JSON_SCHEMA, Type, load } from 'js-yaml';
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
import { agentConfigOwner, ensureAgentConfigDirectory } from './agent-config-owner.js';

const logger = createLogger('DshYamlPatchStrategy');

export const DSH_ENABLED_MARKER = '.collection-enabled';

const BEGIN_PREFIX = '# BEGIN ';
const END_PREFIX = '# END ';
const ADDED_SEPARATOR = '# addedSeparator=lf';
const LOCK_SUFFIX = '.loongsuite-pilot.lock';
const LOCK_GATE_SUFFIX = '.reclaim';
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 25;
const STALE_LOCK_MS = 30_000;

// DSH 0.2.2 reads patch layers with the Cordis entry-list schema. Retain
// expression nodes for comparison without evaluating their contents.
const patchSchema = JSON_SCHEMA.extend(new Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (value: unknown) => typeof value === 'string',
  construct: (value: unknown) => ({ __jsExpr: value }),
}));
const patchTrivia = /^(?:(?:[ \t]*(?:#[^\r\n]*)?|%[^\r\n]*)\r?\n)*[ \t]*/;
const documentStart = /^---(?=[ \t\r\n]|$)[ \t]*(?:(?:#[^\r\n]*)?\r?\n)?/;
const rootProperty = /^[&!][^ \t\r\n]+[ \t\r\n]+/;
const documentEnd = /^\.\.\.(?=[ \t]*(?:#|\r?$))/m;

interface DshPatch {
  rows: unknown[];
  rootOffset: number;
  emptyDocument: boolean;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readPatch(bytes: Buffer, allowEmpty: boolean): DshPatch {
  const text = bytes.toString('utf8');
  let rootOffset = text.startsWith('\uFEFF') ? 1 : 0;
  rootOffset += patchTrivia.exec(text.slice(rootOffset))![0].length;
  const start = documentStart.exec(text.slice(rootOffset));
  if (start) {
    rootOffset += start[0].length;
    rootOffset += patchTrivia.exec(text.slice(rootOffset))![0].length;
  }
  let property = rootProperty.exec(text.slice(rootOffset));
  while (property) {
    rootOffset += property[0].length;
    rootOffset += patchTrivia.exec(text.slice(rootOffset))![0].length;
    property = rootProperty.exec(text.slice(rootOffset));
  }
  let parsed: unknown;
  try {
    parsed = load(text, { schema: patchSchema });
  } catch {
    throw new Error('DSH patch must be valid single-document YAML');
  }
  const root = text.slice(rootOffset);
  const emptyDocument = parsed == null && (!root || root.startsWith('#') || documentEnd.exec(root)?.index === 0);
  if (allowEmpty && emptyDocument) return { rows: [], rootOffset, emptyDocument };
  if (!Array.isArray(parsed) || !parsed.every(isMapping)) {
    throw new Error('DSH patch must be a YAML sequence of mappings');
  }
  if (parsed.some(({ insert }) => insert != null && (!Array.isArray(insert) || !insert.every(isMapping)))) {
    throw new Error('DSH patch insert must be a sequence of mappings');
  }
  return { rows: parsed, rootOffset, emptyDocument: false };
}

/**
 * Manages a single marked YAML block inside deepseek-harness's machine-wide
 * user patch layer (`$DSH_HOME/cordis.patch.yml`). The block carries one
 * `- insert:` row that loads the Pilot plugin via a `file://` URL.
 *
 * Concurrency / safety contract (architect APPROVED comment 1083c086):
 *   - Only the Pilot-managed BEGIN/END block is ever appended or removed.
 *     Non-Pilot bytes (user rows, comments, formatting) are preserved
 *     verbatim. Parse the original and composed document with DSH's schema
 *     before writing, keeping user rows in the same order and unchanged.
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
    try {
      const outside = Buffer.concat([parsed.before, parsed.after]);
      return !this.hasManagedRow(fileBytes, readPatch(outside, true).rows, pluginUrl);
    } catch {
      return true;
    }
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
        const outside = Buffer.concat([parsed.before, parsed.after]);
        const nextBytes = this.composePatch(outside, parsed.existingBlock ? parsed.before.length : undefined,
          cfg, pluginHash, createdFileFlag);

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
    } catch (error) {
      return { success: false, agentId: def.id, deployMode: 'dsh-yaml-patch', error: String(error) };
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
    // A stale deployment record may outlive a user-removed DSH home. Check the
    // target before acquiring the in-directory lock so disable/undeploy remains
    // a true no-op instead of recreating that home as an empty directory.
    const initialBytes = await this.readBytes(patchPath);
    if (initialBytes.length === 0 && !(await fileExists(patchPath))) return true;

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
        const outside = Buffer.concat([parsed.before, parsed.after]);

        if (createdFile === 'true' && outside.toString('utf-8').trim().length === 0) {
          const changed = await this.deleteIfUnchanged(patchPath, h0);
          if (changed) return true;
          logger.warn('concurrent modification during undeploy delete, retrying', { path: patchPath, attempt });
          continue;
        }

        let nextBytes: Buffer = outside;
        if (outside.length > 0) {
          try {
            if (readPatch(outside, true).emptyDocument) {
              nextBytes = this.insertBlock(outside, this.appendOffset(outside), Buffer.from('[]\n'));
              readPatch(nextBytes, false);
            }
          } catch (error) {
            logger.warn('undeploy refused: invalid DSH patch outside managed block', { error: String(error) });
            return false;
          }
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

  private composePatch(outside: Buffer, previousOffset: number | undefined, cfg: DshYamlPatchConfig,
    pluginHash: string, createdFile: boolean): Buffer {
    const patch = readPatch(outside, true);
    const text = outside.toString('utf8');
    const root = text.slice(patch.rootOffset);
    const pluginUrl = pathToFileURL(this.resolvePluginPath(cfg)).href;
    if (root.startsWith('[')) {
      if (patch.rows.length) throw new Error('Non-empty flow-style DSH patch is unsupported; original preserved. Use a block sequence.');
      const offset = Buffer.byteLength(text.slice(0, patch.rootOffset)) + 1;
      if (previousOffset !== undefined && previousOffset !== offset && previousOffset !== outside.length) {
        throw new Error('Managed DSH patch is outside the empty flow sequence');
      }
      const block = Buffer.from(this.composePilotBlock(cfg, pluginHash, createdFile, true));
      const composed = Buffer.concat([outside.subarray(0, offset), block, outside.subarray(offset)]);
      if (this.hasManagedRow(composed, patch.rows, pluginUrl)) return composed;
      throw new Error('Could not compose a valid DSH flow patch without changing user rows');
    }

    const rootLineStart = text.lastIndexOf('\n', patch.rootOffset - 1) + 1;
    const rootLinePrefix = text.slice(rootLineStart, patch.rootOffset).replace(/^\uFEFF/, '');
    const sequenceIndent = /^-(?=[ \t\r\n]|$)/.test(root) ? rootLinePrefix.length : 0;
    const append = this.appendOffset(outside);
    const offset = previousOffset ?? append;
    const offsets = [offset];
    // A legacy append at EOF may have placed the row after the end marker.
    // Do not reorder documents or discard bytes from a user's malformed file.
    if (offset === outside.length && append !== offset) offsets.push(append);
    for (const position of offsets) {
      const addedSeparator = position === outside.length && position > 0 && outside[position - 1] !== 0x0a;
      const block = Buffer.from(this.composePilotBlock(cfg, pluginHash, createdFile, false, sequenceIndent, addedSeparator));
      const composed = this.insertBlock(outside, position, block);
      if (this.hasManagedRow(composed, patch.rows, pluginUrl)) return composed;
    }
    throw new Error('Could not compose a valid DSH patch without changing user rows');
  }

  private appendOffset(bytes: Buffer): number {
    const text = bytes.toString('utf8');
    const match = documentEnd.exec(text);
    return match ? Buffer.byteLength(text.slice(0, match.index)) : bytes.length;
  }

  private insertBlock(bytes: Buffer, offset: number, block: Buffer): Buffer {
    const separator = offset > 0 && bytes[offset - 1] !== 0x0a ? '\n' : '';
    return Buffer.concat([bytes.subarray(0, offset), Buffer.from(separator), block, bytes.subarray(offset)]);
  }

  private hasManagedRow(bytes: Buffer, userRows: unknown[], pluginUrl: string): boolean {
    try {
      const { rows } = readPatch(bytes, false);
      if (rows.length !== userRows.length + 1) return false;
      const managed = { insert: [{ id: 'loongsuite-pilot-observability', name: pluginUrl }] };
      return rows.some((row, index) => isDeepStrictEqual(row, managed)
        && isDeepStrictEqual([...rows.slice(0, index), ...rows.slice(index + 1)], userRows));
    } catch {
      return false;
    }
  }

  private composePilotBlock(cfg: DshYamlPatchConfig, pluginHash: string, createdFile: boolean,
    flow: boolean, indent = 0, addedSeparator = false): string {
    const pluginUrl = pathToFileURL(this.resolvePluginPath(cfg)).href;
    const flag = ` (created-file: ${createdFile ? 'true' : 'false'})`;
    const entry = flow
      ? [`{insert: [{id: "loongsuite-pilot-observability", name: ${JSON.stringify(pluginUrl)}}]}`]
      : ['- insert:', `  - id: 'loongsuite-pilot-observability'`, `    name: ${pluginUrl}`];
    return (flow ? ' ' : '') + [
      `${BEGIN_PREFIX}${cfg.marker}${flag}`,
      `# entryId=${cfg.entryId}`,
      `# pluginSource=${pluginUrl}`,
      `# pluginHash=${pluginHash}`,
      ...(addedSeparator ? [ADDED_SEPARATOR] : []),
      ...entry.map(line => ' '.repeat(indent) + line),
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
    const beginLine = bytes.subarray(beginIdx, beginLineEnd).toString('utf-8').replace(/\r$/, '').trimStart();
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
    // Track the separator added before a managed EOF block so undeploy
    // also restores user files whose last line originally had no newline.
    const ownsSeparator = !conflict && blockEnd === bytes.length && beginIdx > 0
      && bytes[beginIdx - 1] === 0x0a && this.hasMetadataLine(block, ADDED_SEPARATOR);
    return {
      before: bytes.subarray(0, beginIdx - (ownsSeparator ? 1 : 0)),
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
      const flowBegin = marker.startsWith(BEGIN_PREFIX) && index >= 2
        && bytes[index - 2] === 0x5b && bytes[index - 1] === 0x20;
      const next = index + needle.length;
      const boundary = next === bytes.length
        || bytes[next] === 0x20
        || bytes[next] === 0x09
        || bytes[next] === 0x0d
        || bytes[next] === 0x0a;
      if ((atLineStart || flowBegin) && boundary) offsets.push(flowBegin ? index - 1 : index);
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
    await ensureAgentConfigDirectory(path.dirname(target));
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      const currentBytes = await this.readBytes(target);
      if (this.sha256Bytes(currentBytes) !== h0) return false;

      const handle = await fs.open(tmp, 'wx', mode ?? 0o644);
      try {
        // A privileged installer must not replace a user's private YAML with
        // a root-owned inode: the original CLI still needs to read it.
        if (process.getuid?.() === 0) {
          const owner = await agentConfigOwner(target);
          if (owner.uid !== process.getuid() || owner.gid !== process.getgid?.()) await handle.chown(owner.uid, owner.gid);
        }
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
    await ensureAgentConfigDirectory(path.dirname(lockPath));
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
