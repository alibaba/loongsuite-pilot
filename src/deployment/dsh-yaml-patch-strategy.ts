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
import { agentConfigOwner, ensureAgentConfigDirectory } from './agent-config-owner.js';

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
 *   - Appending never creates a second YAML document. DSH parses the file as
 *     a single document whose root must be a sequence, so appending is only
 *     allowed when the existing root is a block sequence (`- ` rows) or the
 *     file carries no meaningful content. The optional document preamble
 *     (`%YAML` directives, a leading `---` marker) and a trailing `...`
 *     document-end marker are recognized in both classification and
 *     post-composition validation: `---\n- insert: []` is a valid block
 *     sequence, and an append is inserted before a trailing `...` so the
 *     explicit document end stays the file's last line. A bare `[]`
 *     placeholder (how DSH serializes an empty patch list) is dropped before
 *     appending: an empty flow sequence followed by block-sequence rows
 *     would parse as two documents and crash DSH at startup (js-yaml
 *     "document separator is expected"). A non-sequence root refuses
 *     deployment instead of corrupting the file, and a file already broken
 *     by an older append is repaired on the next deploy cycle.
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
    const flowOffset = this.emptyFlowPatchOffset(Buffer.concat([parsed.before, parsed.after]));
    if (flowOffset !== undefined && !block.startsWith(' ')) return true;
    if (!this.hasMetadataLine(block, `# entryId=${cfg.entryId}`)) return true;
    if (!this.hasMetadataLine(block, `# pluginSource=${pluginUrl}`)) return true;
    if (!this.hasMetadataLine(block, `# pluginHash=${pluginHash}`)) return true;
    // The block itself is up to date, but the surrounding file may still be a
    // two-document YAML that an older Pilot appended next to a `[]` placeholder.
    // That crashes DSH at startup, so flag it for repair via a fresh deploy.
    // A flow-root file (empty `[]` with our entry inserted inside the brackets)
    // is a valid single document and is exempt from the block-sequence check.
    if (flowOffset !== undefined) return false;
    return this.composedPatchInvalidReason(fileBytes) !== null;
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
        const flowOffset = this.emptyFlowPatchOffset(outside);
        const newBlock = this.composePilotBlock(cfg, pluginHash, createdFileFlag, flowOffset !== undefined);
        let nextBytes: Buffer;
        if (flowOffset !== undefined) {
          nextBytes = Buffer.concat([outside.subarray(0, flowOffset), Buffer.from(newBlock), outside.subarray(flowOffset)]);
        } else if (parsed.existingBlock) {
          // A bare `[]` line outside the block can only be a leftover root
          // placeholder (it would already form a second YAML document next to
          // the block's sequence rows), so dropping it is always a repair.
          nextBytes = Buffer.concat([
            this.withoutBareEmptySeqLines(parsed.before),
            Buffer.from(newBlock),
            this.withoutBareEmptySeqLines(parsed.after),
          ]);
        } else {
          const rootKind = this.classifyExistingRoot(originalBytes);
          if (rootKind === 'refuse') {
            return {
              success: false,
              agentId: def.id,
              deployMode: 'dsh-yaml-patch',
              error: `refusing to append to ${patchPath}: existing root is not a YAML block sequence`
                + ' (appending would produce two YAML documents and crash DSH at startup);'
                + ' fix the file manually so its root is a sequence',
            };
          }
          const base = rootKind === 'empty-flow-seq'
            ? this.withoutBareEmptySeqLines(originalBytes)
            : originalBytes;
          // An explicit document-end marker (`...`) must stay the file's
          // last line: insert our block before it. Appending after it would
          // start a second document and crash DSH at startup.
          const docEnd = this.splitTrailingDocumentEnd(base);
          const head = docEnd ? docEnd.head : base;
          const sep = head.length > 0 && !head.toString('utf-8').endsWith('\n')
            ? Buffer.from('\n')
            : Buffer.alloc(0);
          nextBytes = Buffer.concat([
            head,
            sep,
            Buffer.from(newBlock),
            docEnd ? docEnd.tail : Buffer.alloc(0),
          ]);
        }
        // Final guard: never write a file DSH would fail to parse. This also
        // covers the empty-flow-seq replacement above, which must yield a
        // single block-sequence root. The empty-flow insertion path keeps a
        // flow-sequence root (our entry goes inside its brackets), so the
        // block-sequence guard does not apply there.
        if (flowOffset === undefined) {
          const invalidReason = this.composedPatchInvalidReason(nextBytes);
          if (invalidReason) {
            return {
              success: false,
              agentId: def.id,
              deployMode: 'dsh-yaml-patch',
              error: `composed patch ${patchPath} would fail DSH patch parsing: ${invalidReason}`,
            };
          }
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
        const nextBytes = Buffer.concat([parsed.before, parsed.after]);

        if (createdFile === 'true' && nextBytes.toString('utf-8').trim().length === 0) {
          const changed = await this.deleteIfUnchanged(patchPath, h0);
          if (changed) return true;
          logger.warn('concurrent modification during undeploy delete, retrying', { path: patchPath, attempt });
          continue;
        }

        // Deploy may have dropped the bare `[]` placeholder to make room for
        // the block, so a pre-existing comments-only remainder would parse to
        // a null root. Restore the empty-sequence placeholder DSH itself
        // writes, keeping the file a valid single document. A truly empty
        // (0-byte) pre-existing file stays empty, per the created-file
        // contract above. A remainder that is only document preamble (e.g. a
        // bare leading `---` kept from `---\n[]\n`) also parses to a null
        // root, so the placeholder is restored there too.
        if (
          nextBytes.length > 0
          && this.withoutDocumentPreamble(this.meaningfulRawLines(nextBytes)).length === 0
        ) {
          const restored = nextBytes.toString('utf-8').endsWith('\n')
            ? `${nextBytes.toString('utf-8')}[]\n`
            : `${nextBytes.toString('utf-8')}\n[]\n`;
          const wrote = await this.atomicWriteIfUnchanged(patchPath, Buffer.from(restored), h0, mode);
          if (wrote) return true;
          logger.warn('concurrent modification during undeploy restore, retrying', { path: patchPath, attempt });
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

  /** Empty flow sequences need an entry inside their brackets, not another YAML root. */
  private emptyFlowPatchOffset(bytes: Buffer): number | undefined {
    const text = bytes.toString('utf8');
    const prefix = /^(?:\uFEFF)?(?:[ \t]*(?:#[^\r\n]*|---)?\r?\n)*[ \t]*/.exec(text)![0];
    const body = text.slice(prefix.length);
    if (!body.startsWith('[')) return undefined;
    const empty = /^\[\s*\]/.exec(body);
    if (!empty || body.slice(empty[0].length).split(/\r?\n/).some(line => line.trim() && !line.trimStart().startsWith('#'))) {
      throw new Error('Non-empty flow-style DSH patch is unsupported; original preserved. Use a block sequence.');
    }
    return Buffer.byteLength(prefix) + 1;
  }

  /**
   * Classify the root of existing non-Pilot content before appending our
   * block-sequence entry:
   *   - `empty`: only comments/blank lines/document preamble (`%YAML`, `---`)
   *     — safe to append.
   *   - `block-seq`: first meaningful line starts with `- ` — the existing
   *     root is a block sequence, so our row continues it. The optional
   *     document start marker (`---`, optionally preceded by directives) is
   *     skipped: `---\n- insert: []` is a valid block sequence.
   *   - `empty-flow-seq`: the only meaningful line is a column-0 bare `[]`,
   *     the placeholder DSH writes for an empty patch list — drop it and
   *     append (an empty flow sequence followed by block rows would parse as
   *     two documents and crash DSH).
   *   - `refuse`: any other root (flow sequence with content, mapping,
   *     scalar) — appending would break the file, so deployment must fail.
   *
   * The placeholder check requires the `[]` to sit at column 0: block-scalar
   * content is always indented deeper than its parent key, so an indented
   * `[]` line is user data (e.g. the literal body of `value: |`) and must
   * never be treated as the root placeholder.
   */
  private classifyExistingRoot(bytes: Buffer): 'empty' | 'block-seq' | 'empty-flow-seq' | 'refuse' {
    const lines = this.withoutDocumentPreamble(this.meaningfulRawLines(bytes));
    if (lines.length === 0) return 'empty';
    if (lines[0].startsWith('- ')) return 'block-seq';
    if (lines.length === 1 && this.isColumn0EmptyFlowSeq(lines[0])) return 'empty-flow-seq';
    return 'refuse';
  }

  /** A root placeholder is only proven when it is the entire line at column 0. */
  private isColumn0EmptyFlowSeq(line: string): boolean {
    return /^\[\][ \t]*$/.test(line);
  }

  /**
   * Split off a trailing column-0 standalone `...` document-end line (with
   * everything from it to EOF — normally just the trailing newline) so an
   * append can be inserted before it, keeping the explicit document end the
   * file's last line. Returns undefined when the last meaningful line is not
   * `...`.
   */
  private splitTrailingDocumentEnd(bytes: Buffer): { head: Buffer; tail: Buffer } | undefined {
    const text = bytes.toString('utf-8');
    const lines = text.split('\n');
    let last = lines.length - 1;
    while (last >= 0 && lines[last].replace(/\r$/, '').trim().length === 0) last -= 1;
    if (last < 0 || !/^\.\.\.[ \t]*$/.test(lines[last].replace(/\r$/, ''))) return undefined;
    let headLen = 0;
    for (let i = 0; i < last; i++) headLen += Buffer.byteLength(lines[i], 'utf-8') + 1;
    return { head: bytes.subarray(0, headLen), tail: bytes.subarray(headLen) };
  }

  /** Non-blank, non-comment raw lines with indentation preserved. */
  private meaningfulRawLines(bytes: Buffer): string[] {
    return bytes.toString('utf-8')
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .map(line => line.replace(/\r$/, ''))
      .filter(line => line.trim().length > 0 && !line.trimStart().startsWith('#'));
  }

  /**
   * Strip the optional YAML document preamble: `%DIRECTIVE` lines and the
   * document start marker `---` (both column 0), so classification sees the
   * actual root node. A standalone `---` line (even with a trailing comment)
   * is dropped; content sharing the marker line (`--- - foo`, `--- []`) keeps
   * the remainder as the first content line. Block-scalar content is always
   * indented, so a column-0 `---` can only be a real document marker.
   */
  private withoutDocumentPreamble(lines: string[]): string[] {
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.startsWith('%')) {
        i += 1;
        continue;
      }
      const match = /^---(?:[ \t]+(.*))?$/.exec(line);
      if (!match) return lines.slice(i);
      const rest = (match[1] ?? '').trim();
      if (rest.length > 0 && !rest.startsWith('#')) {
        return [rest, ...lines.slice(i + 1)];
      }
      i += 1;
    }
    return [];
  }

  /**
   * Remove column-0 bare `[]` lines, keeping every other byte verbatim.
   * Indented `[]` lines are block-scalar content (user data) and survive.
   */
  private withoutBareEmptySeqLines(bytes: Buffer): Buffer {
    const text = bytes.toString('utf-8');
    const lines = text.split('\n');
    const kept = lines.filter(line => {
      const raw = line.replace(/\r$/, '');
      return !this.isColumn0EmptyFlowSeq(raw);
    });
    if (kept.length === lines.length) return bytes;
    return Buffer.from(kept.join('\n'));
  }

  /**
   * Validate the composed patch file the way DSH reads it: a single YAML
   * document whose root is a block sequence of patch rows. Returns a reason
   * string when the bytes would crash `parsePatchList`, or null when valid.
   *
   * The optional document preamble (`%YAML` directives, a leading `---`
   * marker) is skipped before reading the root: `---\n- insert: []` is a
   * valid single block-sequence document.
   *
   * Second-root detection is indentation-aware: only a column-0 `[]`/`{}`
   * line, or a column-0 `---` after the root began, can start a second
   * document. Indented occurrences are block-scalar content inside a user
   * row (e.g. `value: |` + `      []`), which is a perfectly valid single
   * document and must not be rejected. A column-0 `...` (document end) is
   * only valid as the very last line: content after it would form a second
   * document and crash DSH.
   */
  private composedPatchInvalidReason(bytes: Buffer): string | null {
    const lines = this.withoutDocumentPreamble(this.meaningfulRawLines(bytes));
    if (lines.length === 0) return 'no patch rows';
    if (!lines[0].startsWith('- ')) {
      return `root is not a block sequence (${lines[0].trim().slice(0, 40)})`;
    }
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (/^(?:\[\]|\{\})[ \t]*$/.test(line) || /^---(?:[ \t]|$)/.test(line)) {
        return `second document root (${line.trim().slice(0, 40)})`;
      }
      if (/^\.\.\.[ \t]*$/.test(line) && i < lines.length - 1) {
        return `content after document end marker (${line.trim().slice(0, 40)})`;
      }
    }
    return null;
  }

  private composePilotBlock(cfg: DshYamlPatchConfig, pluginHash: string, createdFile?: boolean, flow = false): string {
    const pluginUrl = pathToFileURL(this.resolvePluginPath(cfg)).href;
    const flag = createdFile === undefined ? '' : ` (created-file: ${createdFile ? 'true' : 'false'})`;
    const entry = flow
      ? [`{insert: [{id: "loongsuite-pilot-observability", name: ${JSON.stringify(pluginUrl)}}]}`]
      : ['- insert:', `  - id: 'loongsuite-pilot-observability'`, `    name: ${pluginUrl}`];
    return (flow ? ' ' : '') + [
      `${BEGIN_PREFIX}${cfg.marker}${flag}`,
      `# entryId=${cfg.entryId}`,
      `# pluginSource=${pluginUrl}`,
      `# pluginHash=${pluginHash}`,
      ...entry,
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
