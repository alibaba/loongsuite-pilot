import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ClientType, CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import { enrichCanonicalEntryWithGit } from '../../normalization/enrich-git-context.js';
import { resolveHome, directoryExists, ensureDir } from '../../utils/fs-utils.js';
import { getTodayDateString } from '../../utils/fs-utils.js';
import { parseSdkLogLine, type SdkEvent } from '../qoder-work-log/qoder-work-log-input.js';

const BUFFER_TTL_MS = 24 * 60 * 60 * 1000;

export interface QoderWorkTraceInputOptions extends InputOptions {
  logDir?: string;
  sdkLogDir?: string;
}

interface SdkMessageData {
  messageId: string;
  sessionId: string;
  startTimeMs: number;
  endTimeMs: number;
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
  complete: boolean;
  createdAtMs: number; // 用于 eviction
}

/**
 * QoderWork CN TraceInput — multi-source merge.
 *
 * Reads hook JSONL (messages + structure, produced by the rewritten
 * qoderwork-hook-processor.mjs) and SDK log (tokens from message_delta).
 * Merges tokens into the hook's llm.response events, injects trace_id.
 *
 * When enabled, supersedes qoder-work-hook / qoder-work-log / qoder-work-sqlite.
 */
export class QoderWorkTraceInput extends BaseInput {
  readonly id = 'qoder-work-trace';
  readonly agentType = ClientType.QoderWork;
  readonly collectionMethod = CollectionMethod.HookJsonl;

  private readonly logDir: string;
  private readonly sdkLogDir: string;
  private readonly logPrefix = 'qoder-work';

  // SDK log 状态机缓冲 — 实例级持久化，跨 collect() 周期存活
  private sdkMessageBuffer: Map<string, SdkMessageData[]> = new Map();
  private sdkInFlightMessages: Map<string, SdkMessageData> = new Map();

  // Model policy 按文件路径隔离，防止不同 SDK 进程的 model 交叉污染
  private fileModelPolicies: Map<string, { chat: string; compact: string; scene: string }> = new Map();
  private currentModelPolicy: { chat: string; compact: string; scene: string } = { chat: '', compact: '', scene: '' };

  constructor(opts: QoderWorkTraceInputOptions) {
    super({ ...opts, pollIntervalMs: opts.pollIntervalMs ?? 30_000 });
    this.logDir = opts.logDir ?? resolveHome('~/.loongsuite-pilot/logs/qoder-work/history');
    this.sdkLogDir = opts.sdkLogDir ?? resolveQoderWorkSdkLogDir();
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome('~/.qoderwork'));
  }

  static getWatchPaths(): string[] {
    return [
      resolveHome('~/.loongsuite-pilot/logs/qoder-work/history'),
      resolveQoderWorkSdkLogDir(),
    ];
  }

  protected override async onStart(): Promise<void> {
    await ensureDir(this.logDir);
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    // 1. 读取 SDK log 状态（token + timing + model），积累到实例级缓冲
    await this.readSdkLogState();

    // 2. 读取 hook JSONL 条目
    const rawEntries = await this.readHookJsonl();
    if (rawEntries.length === 0) return [];

    // 3. 按 turn.id 分组
    const turnGroups = this.groupByTurn(rawEntries);

    // 4. 对每个 turn 进行全量 enrichment（token + timing + model + git context）
    const allEntries: AgentActivityEntry[] = [];
    for (const [, turnEntries] of turnGroups) {
      this.enrichTurn(turnEntries);
      this.injectTraceId(turnEntries);
      for (const entry of turnEntries) {
        await enrichCanonicalEntryWithGit(
          entry as Record<string, unknown>,
          entry as Record<string, unknown>,
          'qoder-work',
        );
      }
      allEntries.push(...turnEntries);
    }

    // 5. 清理超过 24 小时未消费的缓冲条目
    this.evictStaleBuffers();

    return allEntries;
  }

  // ─── Hook JSONL reading ────────────────────────────────────────────────────

  private async readHookJsonl(): Promise<AgentActivityEntry[]> {
    const today = getTodayDateString();
    const logFileName = `${this.logPrefix}-${today}.jsonl`;
    const logFile = path.join(this.logDir, logFileName);

    let stat;
    try {
      stat = await fs.stat(logFile);
    } catch {
      return [];
    }

    const state = this.getState();
    let offset = state.lastFile === logFileName ? (state.lastOffset ?? 0) : 0;

    if (offset > 0 && stat.size < offset) {
      this.logger.info('file truncated, resetting offset', { file: logFile });
      offset = 0;
    }
    if (stat.size <= offset) return [];

    const handle = await fs.open(logFile, 'r');
    const entries: AgentActivityEntry[] = [];
    try {
      const maxReadSize = 16 * 1024 * 1024;
      const readSize = Math.min(stat.size - offset, maxReadSize);
      const buf = Buffer.alloc(readSize);
      await handle.read(buf, 0, readSize, offset);
      let text = buf.toString('utf-8');
      let consumedBytes = readSize;
      if (readSize < stat.size - offset) {
        const lastNL = text.lastIndexOf('\n');
        if (lastNL >= 0) { text = text.substring(0, lastNL); consumedBytes = Buffer.byteLength(text, 'utf-8') + 1; }
      }
      this.setState({ lastFile: logFileName, lastOffset: offset + consumedBytes });

      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as AgentActivityEntry;
          if (record['event.name']) entries.push(record);
        } catch {
          this.logger.warn('invalid JSONL line');
        }
      }
    } finally {
      await handle.close();
    }

    return entries;
  }

  // ─── SDK Log state reading ──────────────────────────────────────────────────

  private async readSdkLogState(): Promise<void> {
    const stateKey = `${this.id}:sdk-log`;

    let logFiles: string[];
    try {
      logFiles = await this.discoverSdkLogFiles();
    } catch {
      return;
    }

    for (const filePath of logFiles) {
      // 恢复该文件的 model policy 快照，防止跨文件污染
      this.currentModelPolicy = this.fileModelPolicies.get(filePath)
        ?? { chat: '', compact: '', scene: '' };

      const fileStateKey = `${stateKey}:${filePath}`;
      let stat;
      try { stat = await fs.stat(filePath); } catch { continue; }

      const prevState = this.stateStore.get(fileStateKey);
      const prevInode = prevState.extra?.inode as number | undefined;
      const currentInode = (stat as unknown as { ino: number }).ino;
      let cachedSig: string | undefined;

      if (prevInode !== undefined && prevInode !== currentInode) {
        this.stateStore.setOffset(fileStateKey, 0);
        cachedSig = await computeFileSignature(filePath);
        this.stateStore.update(fileStateKey, { extra: { inode: currentInode, signatureHash: cachedSig } });
      } else if (prevInode === undefined) {
        cachedSig = await computeFileSignature(filePath);
        this.stateStore.update(fileStateKey, { extra: { inode: currentInode, signatureHash: cachedSig } });
      }

      let offset = this.stateStore.getOffset(fileStateKey);
      if (offset > 0 && stat.size < offset) {
        this.logger.info('SDK log truncated or rotated, resetting offset', { file: filePath });
        offset = 0;
        this.stateStore.setOffset(fileStateKey, 0);
      }

      // Signature-based rotation detection: handles inode reuse on tmpfs (Linux CI)
      if (offset > 0 && stat.size > 0) {
        const currentSig = cachedSig ?? await computeFileSignature(filePath);
        cachedSig = currentSig;
        const prevSig = prevState.extra?.signatureHash as string | undefined;
        if (prevSig && currentSig && prevSig !== currentSig) {
          this.logger.info('SDK log content signature changed (inode reused), resetting offset', { file: filePath });
          offset = 0;
          this.stateStore.setOffset(fileStateKey, 0);
        }
      }
      if (stat.size <= offset) {
        this.fileModelPolicies.set(filePath, { ...this.currentModelPolicy });
        continue;
      }

      const handle = await fs.open(filePath, 'r');
      try {
        const readSize = Math.min(stat.size - offset, 16 * 1024 * 1024);
        const buf = Buffer.alloc(readSize);
        await handle.read(buf, 0, readSize, offset);
        let text = buf.toString('utf-8');

        let consumedBytes = readSize;
        if (readSize < stat.size - offset) {
          const lastNL = text.lastIndexOf('\n');
          if (lastNL >= 0) { text = text.substring(0, lastNL); consumedBytes = Buffer.byteLength(text, 'utf-8') + 1; }
        }
        this.stateStore.setOffset(fileStateKey, offset + consumedBytes);
        const sig = cachedSig ?? await computeFileSignature(filePath);
        this.stateStore.update(fileStateKey, { extra: { inode: currentInode, signatureHash: sig } });

        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          const event = parseSdkLogLine(line);
          if (!event) continue;
          this.handleSdkEvent(event);
        }
      } finally {
        await handle.close();
      }

      // 保存该文件处理后的 model policy 快照
      this.fileModelPolicies.set(filePath, { ...this.currentModelPolicy });
    }
  }

  private handleSdkEvent(event: SdkEvent): void {
    switch (event.kind) {
      case 'set_model_policy':
        if (event.chatModel) this.currentModelPolicy.chat = event.chatModel;
        if (event.compactModel) this.currentModelPolicy.compact = event.compactModel;
        if (event.sceneModel) this.currentModelPolicy.scene = event.sceneModel;
        return;

      case 'message_start': {
        const existing = this.sdkInFlightMessages.get(event.sessionId);
        if (existing) {
          this.logger.debug('overwriting incomplete in-flight message', {
            droppedMessageId: existing.messageId,
            sessionId: event.sessionId,
          });
        }
        const msg: SdkMessageData = {
          messageId: event.messageId,
          sessionId: event.sessionId,
          startTimeMs: event.ts,
          endTimeMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          stopReason: '',
          complete: false,
          createdAtMs: Date.now(),
        };
        this.sdkInFlightMessages.set(event.sessionId, msg);
        return;
      }

      case 'message_delta': {
        const inFlight = this.sdkInFlightMessages.get(event.sessionId);
        if (!inFlight) return;
        inFlight.endTimeMs = event.ts;
        inFlight.inputTokens = event.inputTokens;
        inFlight.outputTokens = event.outputTokens;
        inFlight.stopReason = event.stopReason;
        inFlight.complete = true;
        // 移入完成缓冲
        this.sdkInFlightMessages.delete(event.sessionId);
        const list = this.sdkMessageBuffer.get(event.sessionId) ?? [];
        list.push(inFlight);
        this.sdkMessageBuffer.set(event.sessionId, list);
        return;
      }

      // message_stop / 其他事件类型不需要特殊处理
      default:
        return;
    }
  }

  private async discoverSdkLogFiles(): Promise<string[]> {
    const files: string[] = [];
    let entries;
    try {
      entries = await fs.readdir(this.sdkLogDir, { withFileTypes: true });
    } catch {
      return files;
    }

    for (const dir of entries) {
      if (!dir.isDirectory()) continue;
      const sessionPath = path.join(this.sdkLogDir, dir.name);
      const mainLogPath = path.join(sessionPath, 'main.log');
      try {
        const st = await fs.stat(mainLogPath);
        if (st.isFile()) { files.push(mainLogPath); continue; }
      } catch { /* fall through */ }
      const mainDir = path.join(sessionPath, 'main');
      let subEntries;
      try { subEntries = await fs.readdir(mainDir, { withFileTypes: true }); } catch { continue; }
      for (const entry of subEntries) {
        if (entry.isFile() && entry.name.startsWith('sdk-') && entry.name.endsWith('.log')) {
          files.push(path.join(mainDir, entry.name));
        }
      }
    }
    return files.sort();
  }

  // ─── Enrichment ─────────────────────────────────────────────────────────────

  private enrichTurn(entries: AgentActivityEntry[]): void {
    const sessionId = entries.find(e => e['gen_ai.session.id'])?.['gen_ai.session.id'] as string || '';
    if (!sessionId) return;

    const buffer = this.sdkMessageBuffer.get(sessionId);
    const steps = this.groupByStep(entries);
    const stepOrder = [...steps.keys()].filter((k): k is string => k !== undefined);

    for (const [stepId, stepEntries] of steps) {
      if (!stepId) continue;

      const response = stepEntries.find(e => e['event.name'] === 'llm.response');
      const request = stepEntries.find(e => e['event.name'] === 'llm.request');
      if (!response) continue;

      // FIFO 消费一个 SdkMessageData
      const sdkData = buffer?.length ? buffer.shift() : undefined;
      if (sdkData) {
        // Token enrichment — only set when SDK reports non-zero values.
        // QoderWork message_delta always carries positive token counts;
        // 0 means the SDK event was malformed, so we skip to avoid
        // overwriting with misleading zeros.
        if (sdkData.inputTokens > 0) {
          (response as Record<string, unknown>)['gen_ai.usage.input_tokens'] = sdkData.inputTokens;
        }
        if (sdkData.outputTokens > 0) {
          (response as Record<string, unknown>)['gen_ai.usage.output_tokens'] = sdkData.outputTokens;
        }
        if (sdkData.inputTokens > 0 || sdkData.outputTokens > 0) {
          (response as Record<string, unknown>)['gen_ai.usage.total_tokens'] =
            (sdkData.inputTokens || 0) + (sdkData.outputTokens || 0);
        }

        // Timing enrichment — 用 SDK log 的精确时间戳覆盖 hook 的粗粒度时间戳
        if (sdkData.startTimeMs > 0 && request) {
          (request as Record<string, unknown>)['time_unix_nano'] = String(BigInt(sdkData.startTimeMs) * 1_000_000n);
        }
        if (sdkData.endTimeMs > 0) {
          const endNano = String(BigInt(sdkData.endTimeMs) * 1_000_000n);
          (response as Record<string, unknown>)['time_unix_nano'] = endNano;
          // tool.call 时间戳跟随 response（LLM 声明 tool_use 的时刻）
          for (const e of stepEntries) {
            if (e['event.name'] === 'tool.call') {
              (e as Record<string, unknown>)['time_unix_nano'] = endNano;
            }
          }
        }
      }

      // Model enrichment — uses currentModelPolicy which reflects the last
      // processed SDK log file. This assumes a single active QoderWork process
      // (single SDK log directory). If multiple workspaces run in parallel in
      // the future, model policy should be keyed by sessionId instead.
      const resolvedModel = this.resolveModel();
      if (resolvedModel && resolvedModel !== 'unknown') {
        for (const e of stepEntries) {
          if (!e['gen_ai.request.model'] || e['gen_ai.request.model'] === 'auto') {
            (e as Record<string, unknown>)['gen_ai.request.model'] = resolvedModel;
          }
          if (e['event.name'] === 'llm.response') {
            (e as Record<string, unknown>)['gen_ai.response.model'] = resolvedModel;
          }
        }
      }
    }

    // Fix STEP overlap: cap tool.result 时间戳使其不超过下一个 step 的 llm.request 开始时间
    for (let i = 0; i < stepOrder.length - 1; i++) {
      const currentStepEntries = steps.get(stepOrder[i]);
      const nextStepEntries = steps.get(stepOrder[i + 1]);
      if (!currentStepEntries || !nextStepEntries) continue;

      const nextRequest = nextStepEntries.find(e => e['event.name'] === 'llm.request');
      if (!nextRequest) continue;
      const nextStartNano = nextRequest['time_unix_nano'] as string | undefined;
      if (!nextStartNano) continue;
      const nextStartBig = BigInt(nextStartNano);
      const capNano = String(nextStartBig - 1_000_000n); // 减 1ms

      for (const e of currentStepEntries) {
        if (e['event.name'] !== 'tool.result') continue;
        const ts = e['time_unix_nano'] as string | undefined;
        if (ts && BigInt(ts) > nextStartBig) {
          (e as Record<string, unknown>)['time_unix_nano'] = capNano;
        }
      }
    }

    // 清理空 buffer
    if (buffer && buffer.length === 0) {
      this.sdkMessageBuffer.delete(sessionId);
    }
  }

  private resolveModel(): string {
    const policy = this.currentModelPolicy;
    return policy.chat || policy.scene || policy.compact || '';
  }

  private groupByStep(entries: AgentActivityEntry[]): Map<string | undefined, AgentActivityEntry[]> {
    const groups = new Map<string | undefined, AgentActivityEntry[]>();
    for (const entry of entries) {
      const stepId = (entry['gen_ai.step.id'] as string) || undefined;
      const group = groups.get(stepId) ?? [];
      group.push(entry);
      groups.set(stepId, group);
    }
    return groups;
  }

  private evictStaleBuffers(): void {
    const now = Date.now();
    for (const [sessionId, list] of this.sdkMessageBuffer) {
      const filtered = list.filter(m => now - m.createdAtMs < BUFFER_TTL_MS);
      if (filtered.length === 0) {
        this.sdkMessageBuffer.delete(sessionId);
      } else if (filtered.length < list.length) {
        this.sdkMessageBuffer.set(sessionId, filtered);
      }
    }
    // 同时清理停滞的 in-flight messages
    for (const [sessionId, msg] of this.sdkInFlightMessages) {
      if (now - msg.createdAtMs > BUFFER_TTL_MS) {
        this.sdkInFlightMessages.delete(sessionId);
      }
    }
  }

  // ─── Trace ID injection ────────────────────────────────────────────────────

  private injectTraceId(entries: AgentActivityEntry[]): void {
    if (entries.length === 0) return;
    const traceId = crypto.randomBytes(16).toString('hex');
    for (const entry of entries) {
      (entry as Record<string, unknown>).trace_id = traceId;
    }
  }

  // ─── Grouping ──────────────────────────────────────────────────────────────

  private groupByTurn(entries: AgentActivityEntry[]): Map<string, AgentActivityEntry[]> {
    const groups = new Map<string, AgentActivityEntry[]>();
    for (const entry of entries) {
      const turnId = (entry['gen_ai.turn.id'] as string) || 'unknown';
      const group = groups.get(turnId) ?? [];
      group.push(entry);
      groups.set(turnId, group);
    }
    return groups;
  }
}

const SIGNATURE_BYTES = 1024;

async function computeFileSignature(filePath: string): Promise<string> {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const buf = Buffer.alloc(SIGNATURE_BYTES);
    const { bytesRead } = await handle.read(buf, 0, SIGNATURE_BYTES, 0);
    if (bytesRead === 0) return '';
    return crypto.createHash('md5').update(buf.subarray(0, bytesRead)).digest('hex');
  } catch {
    return '';
  } finally {
    await handle?.close();
  }
}

function resolveQoderWorkSdkLogDir(): string {
  if (process.platform === 'darwin') {
    return resolveHome('~/Library/Application Support/QoderWork/logs');
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, 'QoderWork', 'logs');
  return resolveHome('~/.config/QoderWork/logs');
}
