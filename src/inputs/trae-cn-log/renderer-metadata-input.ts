import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import { readBoundedLineTail } from '../base/bounded-line-tail.js';
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';
import { ClientType, CollectionMethod, type AgentActivityEntry } from '../../types/index.js';
import { NativeToolMetadata } from './native-tool-metadata.js';
import { fileIdentity } from '../../utils/file-identity.js';

type Turn = { session: string; turn: string; trace: string; start: number };
type Turns = Record<string, Turn>;

export function rendererLogRoot(): string {
  const appData = process.platform === 'win32' ? process.env.APPDATA :
    process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support') : process.env.XDG_CONFIG_HOME;
  return path.join(appData || path.join(os.homedir(), '.config'), 'Trae CN', 'logs');
}

const messages = /^([^ ]+) \[info\] \[trae-chat-core\] (\[MetadataHandler\] received metadata|\[stream-diagnostics\]\[sse-summary\] plan item first observed|\[stream-diagnostics\]\[done\] done received) (\{.*\})$/;
const messageId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{24}$/.test(v);
const spanId = (trace: string, key: string) => createHash('sha256').update(trace + '/' + key).digest('hex').slice(0, 16);

export function parseRendererLine(line: string, turns: Turns): AgentActivityEntry[] {
  const match = messages.exec(line);
  if (!match) return [];
  const time = Date.parse(match[1]);
  if (!Number.isFinite(time)) return [];
  let data;
  try { data = JSON.parse(match[3]); } catch { return []; }
  const key = data.reply_to_message_id ?? data.replyToMessageId;
  if (!messageId(key)) return [];
  if (match[2].startsWith('[MetadataHandler]')) {
    if (messageId(data.session_id) && messageId(data.turn_id) && typeof data.trace_id === 'string' && /^[0-9a-f]{32}$/.test(data.trace_id)) {
      turns[key] ??= { session: data.session_id, turn: data.turn_id, trace: data.trace_id, start: time };
    }
    return [];
  }
  const turn = turns[key];
  if (!turn) return [];
  const base = {
    trace_id: turn.trace, 'gen_ai.session.id': turn.session, 'gen_ai.turn.id': turn.turn,
    'gen_ai.agent.type': ClientType.TraeCn, 'gen_ai.agent.name': 'trae-cn',
    'gen_ai.system': 'trae', 'agent.trae-cn.source': 'renderer_metadata',
    time_unix_nano: String(BigInt(time) * 1000000n),
  };
  const root = spanId(turn.trace, turn.turn);
  const agent = spanId(turn.trace, 'turn-agent/' + turn.turn);
  if (match[2].includes('[done]')) {
    delete turns[key];
    return [buildAgentActivityEntry({ ...base, 'event.id': agent, 'event.name': 'other',
      span_id: agent, parent_span_id: root, 'gen_ai.span.kind': 'AGENT', 'gen_ai.operation.name': 'invoke_agent',
      startTimeUnixNano: String(BigInt(turn.start) * 1000000n), endTimeUnixNano: base.time_unix_nano }),
      buildAgentActivityEntry({ ...base, 'event.id': root, 'event.name': 'other', 'gen_ai.turn.end': true,
      span_id: root, 'gen_ai.span.kind': 'ENTRY', 'gen_ai.operation.name': 'enter_ai_application_system',
      startTimeUnixNano: String(BigInt(turn.start) * 1000000n), endTimeUnixNano: base.time_unix_nano })];
  }
  // The renderer observes plan items. It does not report tool completion or latency here.
  if (typeof data.planItemId !== 'string' || !/^pi_[0-9a-f]{24}$/.test(data.planItemId) ||
      typeof data.toolCallName !== 'string' || !/^[\w.-]{1,128}$/.test(data.toolCallName)) return [];
  const id = spanId(turn.trace, data.planItemId);
  return [buildAgentActivityEntry({ ...base, 'event.id': id, 'event.name': 'tool.call',
    span_id: id, parent_span_id: agent, 'gen_ai.span.kind': 'TOOL', 'gen_ai.operation.name': 'execute_tool',
    'gen_ai.tool.call.id': data.planItemId, 'gen_ai.tool.name': data.toolCallName,
    startTimeUnixNano: base.time_unix_nano, endTimeUnixNano: base.time_unix_nano })];
}

async function directories(parent: string, pattern: RegExp): Promise<string[]> {
  try {
    return (await fs.readdir(parent, { withFileTypes: true })).filter(d => d.isDirectory() && pattern.test(d.name))
      .map(d => path.join(parent, d.name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export class TraeRendererMetadataInput extends BaseInput {
  readonly id = 'trae-cn-log';
  readonly agentType = ClientType.TraeCn;
  readonly collectionMethod = CollectionMethod.SessionFilePolling;
  private readonly native = new NativeToolMetadata(this.stateStore);
  constructor(opts: InputOptions, private readonly root = rendererLogRoot()) { super(opts); }
  protected override async onStop(): Promise<void> { this.native.close(); }

  protected async collect(): Promise<AgentActivityEntry[]> {
    const entries: AgentActivityEntry[] = [];
    // The first scan establishes a baseline so enabling collection doesn't export prior conversations.
    const initialized = this.stateStore.get(this.id + ':renderer').extra?.initialized === true;
    const nativeKey = this.id + ':native-initialized';
    const nativeInitialized = this.stateStore.get(nativeKey).extra?.initialized === true;
    for (const run of await directories(this.root, /^\d{8}T\d{6}$/)) {
      if (await this.native.collect(run, entries, nativeInitialized)) continue;
      for (const window of await directories(run, /^window\d+$/)) {
        const file = path.join(window, 'renderer.log');
        const stat = await fs.lstat(file).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== 'ENOENT') throw err;
        });
        if (!stat?.isFile()) continue;
        const key = this.id + ':' + file;
        const prev = this.stateStore.get(key);
        const identity = fileIdentity(stat);
        const same = prev.extra?.identity === identity && (prev.lastOffset ?? 0) <= stat.size;
        const offset = same ? prev.lastOffset ?? 0 : initialized ? 0 : stat.size;
        const turns: Turns = same ? { ...(prev.extra?.turns as Turns) } : {};
        if (same && offset === stat.size) continue;
        const tail = offset < stat.size ? await readBoundedLineTail(file, stat, offset,
          same && prev.extra?.skippingLine === true, this.getInputRuntimeAccumulator()) : null;
        if (offset < stat.size && !tail) continue;
        if (tail) for (const line of tail.text.split('\n')) entries.push(...parseRendererLine(line, turns));
        for (const [id, turn] of Object.entries(turns)) {
          if (Date.now() - turn.start > 7 * 86400_000) delete turns[id];
        }
        this.stateStore.update(key, { lastOffset: tail?.offset ?? offset,
          extra: { identity, turns, skippingLine: tail?.skippingLine ?? false } });
      }
    }
    if (!nativeInitialized) this.stateStore.update(nativeKey, { extra: { initialized: true } });
    if (!initialized) this.stateStore.update(this.id + ':renderer', { extra: { initialized: true } });
    return entries;
  }
}
