import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ROOT_CONTEXT, context, trace, createTraceState, type Context, type SpanContext } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import type { HeadersInit } from 'undici';

export interface TurnIdentity {
  agentType: string;
  sessionId: string;
  turnId?: string;
  inputHash?: string;
}

export interface TraceBinding extends TurnIdentity {
  schema: 1;
  bindingId: string;
  traceId: string;
  entrySpanId: string;
  agentSpanId: string;
  flags: number;
  tracestate?: string;
  upstreamSpanId?: string;
  createdAtMs: number;
  expiresAtMs: number;
  closedAtMs?: number;
}

export interface OperationContext {
  schema: 1;
  bindingId: string;
  kind: 'tool' | 'llm';
  operationId: string;
  attemptId: string;
  spanId: string;
  traceparent: string;
  tracestate?: string;
  expiresAtMs: number;
}

const MAX_BYTES = 16 * 1024;
const MAX_FILES = 1024;
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const propagator = new W3CTraceContextPropagator();
const scope = new AsyncLocalStorage<Context>();
const getter = { keys: (carrier: Record<string, string>) => Object.keys(carrier), get: (carrier: Record<string, string>, key: string) => carrier[key] };
const setter = { set: (carrier: Record<string, string>, key: string, value: string) => { carrier[key] = value; } };

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function validId(value: unknown, size: number): value is string {
  return typeof value === 'string' && new RegExp(`^[0-9a-f]{${size}}$`).test(value) && !/^0+$/.test(value);
}
function validKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
}
function identityValid(identity: TurnIdentity): boolean {
  return validKey(identity.agentType) && validKey(identity.sessionId)
    && (identity.turnId === undefined || validKey(identity.turnId))
    && (identity.inputHash === undefined || /^[0-9a-f]{16}$/.test(identity.inputHash));
}

export function inputHash(text: string): string { return digest(text).slice(0, 16); }

export function extractTraceContext(carrier: Record<string, string | undefined>): SpanContext | undefined {
  if (typeof carrier.traceparent !== 'string' || carrier.traceparent.length > 512) return undefined;
  const sanitized = { traceparent: carrier.traceparent.trim().toLowerCase() };
  const state = carrier.tracestate;
  if (typeof state === 'string' && Buffer.byteLength(state) <= 512 && !/[\x00-\x1f\x7f]/.test(state)) {
    Object.assign(sanitized, { tracestate: state });
  }
  const extracted = trace.getSpanContext(propagator.extract(ROOT_CONTEXT, sanitized, getter));
  return extracted && validId(extracted.traceId, 32) && validId(extracted.spanId, 16) ? extracted : undefined;
}

export function bindingContext(binding: TraceBinding, spanId = binding.agentSpanId): Context {
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: binding.traceId, spanId, traceFlags: binding.flags, isRemote: false,
    ...(binding.tracestate ? { traceState: createTraceState(binding.tracestate) } : {}),
  });
}

export function activeContext(): Context { return scope.getStore() ?? context.active(); }

export function withTraceContext<Result>(value: Context, action: () => Result): Result {
  return context.with(value, () => scope.run(value, action));
}

export function injectCarrier(value: Context, original: Record<string, string> = {}): Record<string, string> {
  const outgoing = { ...original };
  if (Object.keys(original).some(key => key.toLowerCase() === 'traceparent')) return outgoing;
  delete outgoing.tracestate;
  propagator.inject(value, outgoing, setter);
  return outgoing;
}

export function injectHttpHeaders(value: Context, original?: HeadersInit): Headers {
  const outgoing = new Headers(original);
  if (outgoing.has('traceparent')) return outgoing;
  outgoing.delete('tracestate');
  const carrier = injectCarrier(value);
  for (const [key, field] of Object.entries(carrier)) outgoing.set(key, field);
  return outgoing;
}

export function injectMetadata<Params extends Record<string, unknown>>(value: Context, original: Params): Params {
  const metadata = original._meta;
  if (metadata !== undefined && (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))) return original;
  const outgoing = { ...(metadata as Record<string, unknown> ?? {}) };
  if (Object.keys(outgoing).some(key => key.toLowerCase() === 'traceparent')) return original;
  delete outgoing.tracestate;
  Object.assign(outgoing, injectCarrier(value));
  return { ...original, _meta: outgoing };
}

export function injectEnvironment(value: Context, original: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const outgoing = { ...original };
  delete outgoing.TRACEPARENT;
  delete outgoing.TRACESTATE;
  const carrier = injectCarrier(value);
  for (const [key, field] of Object.entries(carrier)) outgoing[key.toUpperCase()] = field;
  return outgoing;
}

function readRecord(file: string): unknown {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_BYTES) return undefined;
    return JSON.parse(fs.readFileSync(descriptor, 'utf8'));
  } catch { return undefined; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function publish(file: string, record: unknown): boolean {
  const serialized = JSON.stringify(record);
  if (Buffer.byteLength(serialized) > MAX_BYTES) return false;
  const temporary = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, serialized, { flag: 'wx', mode: 0o600 });
    fs.linkSync(temporary, file);
    return true;
  } catch { return false; }
  finally { try { fs.unlinkSync(temporary); } catch {} }
}

function validBinding(value: unknown, now = Date.now()): value is TraceBinding {
  if (!value || typeof value !== 'object') return false;
  const binding = value as TraceBinding;
  return binding.schema === 1 && identityValid(binding) && validId(binding.bindingId, 64)
    && validId(binding.traceId, 32) && validId(binding.entrySpanId, 16) && validId(binding.agentSpanId, 16)
    && binding.entrySpanId !== binding.agentSpanId && binding.upstreamSpanId !== binding.entrySpanId
    && (binding.upstreamSpanId === undefined || validId(binding.upstreamSpanId, 16))
    && Number.isInteger(binding.flags) && binding.flags >= 0 && binding.flags <= 255
    && (binding.tracestate === undefined || (typeof binding.tracestate === 'string'
      && binding.tracestate.length <= 512 && !/[\x00-\x1f\x7f]/.test(binding.tracestate)))
    && Number.isSafeInteger(binding.createdAtMs) && binding.createdAtMs > 0 && binding.createdAtMs <= now + 5000
    && Number.isSafeInteger(binding.expiresAtMs) && binding.expiresAtMs > now
    && binding.expiresAtMs - binding.createdAtMs <= MAX_TTL_MS;
}

export class TraceContextRuntime {
  private readonly base: string;
  private pruneCursor = '';

  constructor(dataDir: string) { this.base = path.join(dataDir, 'trace-context', 'turns'); }

  private directory(identity: TurnIdentity): string {
    if (!identityValid(identity)) throw new Error('Invalid trace context identity');
    return path.join(this.base, digest(JSON.stringify([identity.agentType, identity.sessionId])));
  }

  lookup(identity: TurnIdentity, bindingId: string): TraceBinding | undefined {
    try { return this.readBinding(identity, bindingId); } catch { return undefined; }
  }

  private lookupFile(identity: TurnIdentity, bindingId: string): string {
    if (!validId(bindingId, 64)) throw new Error('Invalid binding identity');
    return path.join(this.directory(identity), `${bindingId}.json`);
  }

  private readBinding(identity: TurnIdentity, bindingId: string): TraceBinding | undefined {
    const file = this.lookupFile(identity, bindingId);
    const binding = readRecord(file);
    if (!validBinding(binding) || binding.bindingId !== bindingId
      || binding.agentType !== identity.agentType || binding.sessionId !== identity.sessionId) return undefined;
    const closed = readRecord(file + '.closed') as { closedAtMs?: number } | undefined;
    return { ...binding, ...(Number.isSafeInteger(closed?.closedAtMs) ? { closedAtMs: closed!.closedAtMs } : {}) };
  }

  private list(identity: TurnIdentity): TraceBinding[] | undefined {
    const directory = this.directory(identity);
    let iterator: fs.Dir | undefined;
    try {
      iterator = fs.opendirSync(directory);
      const bindings: TraceBinding[] = [];
      for (let count = 0; count < MAX_FILES; count += 1) {
        const entry = iterator.readSync();
        if (!entry) return bindings;
        if (!/^[0-9a-f]{64}\.json$/.test(entry.name) || !entry.isFile()) continue;
        const binding = this.readBinding(identity, entry.name.slice(0, -5));
        if (binding) bindings.push(binding);
      }
      return undefined;
    } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : undefined; }
    finally { iterator?.closeSync(); }
  }

  bindTurn(identity: TurnIdentity, incoming: Record<string, string | undefined> = {}, options: { generate?: boolean; ttlMs?: number } = {}): TraceBinding | undefined {
    try {
      if (!identityValid(identity) || (!identity.turnId && !identity.inputHash)) return undefined;
      const parent = extractTraceContext(incoming);
      if (incoming.traceparent && !parent) return undefined;
      const existing = this.findTurn(identity, { activeOnly: !identity.turnId });
      if (existing) {
        if (existing.closedAtMs !== undefined) return undefined;
        if (identity.inputHash && existing.inputHash && identity.inputHash !== existing.inputHash) return undefined;
        if (parent && (parent.traceId !== existing.traceId || parent.spanId !== existing.upstreamSpanId
          || parent.traceFlags !== existing.flags || (parent.traceState?.serialize() || undefined) !== existing.tracestate)) return undefined;
        return existing;
      }
      if (identity.turnId && fs.existsSync(this.lookupFile(identity, digest(JSON.stringify(['turn', identity.turnId]))))) return undefined;
      if (!parent && !options.generate) return undefined;
      const directory = this.directory(identity);
      if (!this.ensureDirectory(directory)) return undefined;
      this.pruneSession(identity);
      const bindings = this.list(identity);
      if (!bindings || bindings.length >= 128) return undefined;
      if (!identity.turnId && bindings.some(binding => binding.inputHash === identity.inputHash && binding.closedAtMs === undefined)) return undefined;
      const bindingId = digest(identity.turnId ? JSON.stringify(['turn', identity.turnId]) : randomUUID());
      const createdAtMs = Date.now();
      const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
      if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS) return undefined;
      const binding: TraceBinding = {
        ...identity, schema: 1, bindingId, traceId: parent?.traceId ?? randomBytes(16).toString('hex'),
        entrySpanId: randomBytes(8).toString('hex'), agentSpanId: randomBytes(8).toString('hex'),
        flags: parent?.traceFlags ?? 1,
        ...(parent ? { upstreamSpanId: parent.spanId } : {}),
        ...(parent?.traceState?.serialize() ? { tracestate: parent.traceState.serialize() } : {}),
        createdAtMs, expiresAtMs: createdAtMs + ttlMs,
      };
      const file = this.lookupFile(binding, bindingId);
      if (publish(file, binding)) return binding;
      const winner = this.readBinding(identity, bindingId);
      return winner && (!parent || winner.traceId === binding.traceId) && winner.upstreamSpanId === binding.upstreamSpanId
        && winner.flags === binding.flags && winner.tracestate === binding.tracestate ? winner : undefined;
    } catch { return undefined; }
  }

  findTurn(identity: TurnIdentity, { activeOnly = true }: { activeOnly?: boolean } = {}): TraceBinding | undefined {
    try {
      if (!identityValid(identity)) return undefined;
      if (identity.turnId) {
        const exact = this.readBinding(identity, digest(JSON.stringify(['turn', identity.turnId])));
        if (exact) return !activeOnly || exact.closedAtMs === undefined ? exact : undefined;
        if (!identity.inputHash) return undefined;
      }
      const bindings = this.list(identity);
      if (!bindings) return undefined;
      const matches = bindings.filter(binding => (!activeOnly || binding.closedAtMs === undefined)
        && (identity.turnId ? !binding.turnId : true)
        && (!identity.inputHash || binding.inputHash === identity.inputHash));
      return matches.length === 1 ? matches[0] : undefined;
    } catch { return undefined; }
  }

  resolveTurn(identity: TurnIdentity, canonicalTurnId: string, bindingId?: string): TraceBinding | undefined {
    try {
      if (!validKey(canonicalTurnId)) return undefined;
      const directory = this.directory(identity);
      const decision = path.join(directory, `.turn-${digest(canonicalTurnId)}.decision`);
      const previous = readRecord(decision) as { bindingId?: string; local?: boolean } | undefined;
      if (previous) return previous.bindingId ? this.readBinding(identity, previous.bindingId) : undefined;
      let binding = bindingId ? this.readBinding(identity, bindingId) : this.findTurn(identity, { activeOnly: false });
      if (!binding && !bindingId && identity.inputHash) {
        const candidates = this.list(identity)?.filter(candidate => candidate.inputHash === identity.inputHash
          && !candidate.turnId && !fs.existsSync(this.lookupFile(candidate, candidate.bindingId) + '.claim'));
        if (candidates?.length === 1) binding = candidates[0];
      }
      if (!binding) return undefined;
      if ((identity.turnId && binding.turnId && identity.turnId !== binding.turnId)
        || (identity.inputHash && binding.inputHash && identity.inputHash !== binding.inputHash)) return undefined;
      const claim = this.lookupFile(binding, binding.bindingId) + '.claim';
      const owner = readRecord(claim) as { turnId?: string } | undefined;
      if (owner?.turnId !== canonicalTurnId && !publish(claim, { turnId: canonicalTurnId })) return undefined;
      if (!publish(decision, { bindingId: binding.bindingId })) {
        const winner = readRecord(decision) as { bindingId?: string } | undefined;
        if (winner?.bindingId !== binding.bindingId) return undefined;
      }
      return binding;
    } catch { return undefined; }
  }

  freezeLocal(identity: TurnIdentity, canonicalTurnId: string): void {
    try {
      if (!validKey(canonicalTurnId)) return;
      const directory = this.directory(identity);
      if (!this.ensureDirectory(directory)) return;
      if (!this.hasCapacity(directory)) return;
      publish(path.join(directory, `.turn-${digest(canonicalTurnId)}.decision`), { local: true, expiresAtMs: Date.now() + DEFAULT_TTL_MS });
    } catch {}
  }

  reserveOperation(binding: TraceBinding, kind: OperationContext['kind'], operationId: string, attemptId = '0'): OperationContext | undefined {
    try {
      if (!validBinding(binding) || !validKey(operationId) || !validKey(attemptId) || !['tool', 'llm'].includes(kind)) return undefined;
      const authoritative = this.readBinding(binding, binding.bindingId);
      if (!authoritative || authoritative.traceId !== binding.traceId || authoritative.agentSpanId !== binding.agentSpanId
        || authoritative.entrySpanId !== binding.entrySpanId || authoritative.flags !== binding.flags
        || authoritative.tracestate !== binding.tracestate || authoritative.upstreamSpanId !== binding.upstreamSpanId) return undefined;
      const directory = this.directory(binding);
      const file = path.join(directory, `${binding.bindingId}.${digest(JSON.stringify([kind, operationId, attemptId]))}.operation`);
      const existing = readRecord(file) as OperationContext | undefined;
      if (existing) return this.validOperation(existing, binding, kind, operationId, attemptId) ? existing : undefined;
      if (authoritative.closedAtMs !== undefined || !this.hasCapacity(directory)) return undefined;
      const spanId = randomBytes(8).toString('hex');
      const carrier = injectCarrier(bindingContext(binding, spanId));
      const operation: OperationContext = { schema: 1, bindingId: binding.bindingId, kind, operationId, attemptId,
        spanId, traceparent: carrier.traceparent, ...(carrier.tracestate ? { tracestate: carrier.tracestate } : {}), expiresAtMs: binding.expiresAtMs };
      if (publish(file, operation)) return operation;
      const winner = readRecord(file) as OperationContext | undefined;
      return winner && this.validOperation(winner, binding, kind, operationId, attemptId) ? winner : undefined;
    } catch { return undefined; }
  }

  private validOperation(operation: OperationContext, binding: TraceBinding, kind: OperationContext['kind'], operationId: string, attemptId: string): boolean {
    const parsed = extractTraceContext({ traceparent: operation.traceparent, tracestate: operation.tracestate });
    return operation.schema === 1 && operation.bindingId === binding.bindingId && operation.kind === kind
      && operation.operationId === operationId && operation.attemptId === attemptId && validId(operation.spanId, 16)
      && parsed?.traceId === binding.traceId && parsed.spanId === operation.spanId && parsed.traceFlags === binding.flags
      && operation.expiresAtMs === binding.expiresAtMs && operation.tracestate === binding.tracestate;
  }

  private hasCapacity(directory: string): boolean {
    const entries = fs.opendirSync(directory);
    let count = 0;
    try { while (count < MAX_FILES && entries.readSync()) count += 1; } finally { entries.closeSync(); }
    return count < MAX_FILES;
  }

  private ensureDirectory(directory: string): boolean {
    fs.mkdirSync(this.base, { recursive: true, mode: 0o700 });
    if (fs.existsSync(directory)) return fs.lstatSync(directory).isDirectory();
    if (!this.hasCapacity(this.base)) return false;
    fs.mkdirSync(directory, { mode: 0o700 });
    return true;
  }

  completeTurn(binding: TraceBinding, closedAtMs = Date.now()): void {
    try {
      if (!Number.isSafeInteger(closedAtMs) || closedAtMs < binding.createdAtMs) return;
      publish(this.lookupFile(binding, binding.bindingId) + '.closed', { closedAtMs });
    } catch {}
  }

  pruneSession(identity: TurnIdentity): void {
    try {
      const directory = this.directory(identity);
      const entries = fs.opendirSync(directory);
      try {
        for (let count = 0; count < MAX_FILES; count += 1) {
          const entry = entries.readSync();
          if (!entry) break;
          if (!entry.isFile()) continue;
          const file = path.join(directory, entry.name);
          const record = readRecord(file) as { expiresAtMs?: number } | undefined;
          if ((Number.isSafeInteger(record?.expiresAtMs) && record!.expiresAtMs! < Date.now())
            || Date.now() - fs.lstatSync(file).mtimeMs > MAX_TTL_MS) fs.unlinkSync(file);
        }
      } finally { entries.closeSync(); }
    } catch {}
  }

  pruneExpired(): void {
    let entries: fs.Dir | undefined;
    try {
      entries = fs.opendirSync(this.base);
      const names: string[] = [];
      for (let count = 0; count < MAX_FILES; count += 1) {
        const entry = entries.readSync();
        if (!entry) break;
        if (entry.isDirectory() && /^[0-9a-f]{64}$/.test(entry.name)) names.push(entry.name);
      }
      names.sort();
      const next = names.filter(name => name > this.pruneCursor);
      const selected = [...next, ...names.filter(name => name <= this.pruneCursor)].slice(0, 32);
      for (const name of selected) {
        this.pruneCursor = name;
        const directory = path.join(this.base, name);
        const records = fs.opendirSync(directory);
        try {
          for (let index = 0; index < MAX_FILES; index += 1) {
            const record = records.readSync();
            if (!record) break;
            const file = path.join(directory, record.name);
            if (!record.isFile()) continue;
            const value = readRecord(file) as { expiresAtMs?: number } | undefined;
            if ((Number.isSafeInteger(value?.expiresAtMs) && value!.expiresAtMs! < Date.now())
              || Date.now() - fs.lstatSync(file).mtimeMs > MAX_TTL_MS) fs.unlinkSync(file);
          }
        } finally { records.closeSync(); }
        try { fs.rmdirSync(directory); } catch {}
      }
    } catch {}
    finally { entries?.closeSync(); }
  }
}

export function bindingFields(binding: TraceBinding): Record<string, string | number> {
  return {
    trace_id: binding.traceId,
    'agent.pilot.context.binding_id': binding.bindingId,
    'agent.pilot.context.native_session_id': binding.sessionId,
    'agent.pilot.context.entry_span_id': binding.entrySpanId,
    'agent.pilot.context.agent_span_id': binding.agentSpanId,
    'agent.pilot.context.flags': binding.flags,
    'agent.pilot.context.started_ms': binding.createdAtMs,
    ...(binding.turnId ? { 'agent.pilot.correlation.native_turn_id': binding.turnId } : {}),
    ...(binding.upstreamSpanId ? { 'agent.pilot.context.upstream_span_id': binding.upstreamSpanId } : {}),
    ...(binding.tracestate ? { 'agent.pilot.context.tracestate': binding.tracestate } : {}),
  };
}
