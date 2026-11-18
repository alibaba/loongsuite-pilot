import { gunzipSync } from 'node:zlib';
import protobuf from 'protobufjs/light.js';
import { SourceError } from './http.js';
import { digest, safeScalar } from './records.js';
import type { CollectionResult, MulticaInputConfig, MulticaRecord } from './types.js';

// Wire-compatible subset of google/pprof proto/profile.proto (Apache-2.0).
// Ignore labels, comments and mapping paths: these are unnecessary for a flame
// graph and may contain arbitrary application annotations.
const repeated = (type: string, id: number) => ({type, id, rule: 'repeated'});
const field = (type: string, id: number) => ({type, id});
const profileType = protobuf.Root.fromJSON({nested: {
  Profile: {fields: {
    sampleType: repeated('ValueType', 1), sample: repeated('Sample', 2),
    location: repeated('Location', 4), function: repeated('Function', 5),
    stringTable: repeated('string', 6), timeNanos: field('int64', 9),
    durationNanos: field('int64', 10), periodType: field('ValueType', 11), period: field('int64', 12),
  }},
  ValueType: {fields: {type: field('int64', 1), unit: field('int64', 2)}},
  Sample: {fields: {locationId: repeated('uint64', 1), value: repeated('int64', 2)}},
  Location: {fields: {id: field('uint64', 1), address: field('uint64', 3), line: repeated('Line', 4)}},
  Line: {fields: {functionId: field('uint64', 1), line: field('int64', 2)}},
  Function: {fields: {id: field('uint64', 1), name: field('int64', 2), filename: field('int64', 4)}},
}}).lookupType('Profile');

type Integer = number | {toString(): string};
interface ValueType { type: Integer; unit: Integer }
interface Profile {
  sampleType: ValueType[];
  sample: {locationId: Integer[]; value: Integer[]}[];
  location: {id: Integer; address: Integer; line: {functionId: Integer; line: Integer}[]}[];
  function: {id: Integer; name: Integer; filename: Integer}[];
  stringTable: string[];
  timeNanos: Integer;
  durationNanos: Integer;
  periodType?: ValueType;
  period: Integer;
}
interface Node { name: string; self: number; total: number; children: Map<string, Node> }
export type PprofKind = 'cpu' | 'allocs';
export interface Flamebearer {
  version: number;
  flamebearer: {names: string[]; levels: number[][]; numTicks: number; maxSelf: number};
  metadata: {format: string; sampleRate: number; spyName: string; units: string; name: string};
}
export interface ConvertedProfile { profile: Flamebearer; timeMs: number; durationSeconds: number }

const MAX_TABLE_ROWS = 100_000;
const MAX_STACK_FRAMES = 512;
const MAX_TREE_NODES = 100_000;
const MAX_FLAMEBEARER_BYTES = 8 * 1024 * 1024;

function number(value: Integer | undefined): number {
  const result = Number(value ?? 0);
  if (!Number.isSafeInteger(result) || result < 0) throw new SourceError('pprof_invalid_integer');
  return result;
}

function milliseconds(value: Integer): number {
  let raw: bigint;
  try { raw = BigInt(String(value ?? 0)); } catch { throw new SourceError('pprof_invalid_time'); }
  const ms = Number(raw / 1_000_000n);
  if (raw < 0n || !Number.isSafeInteger(ms)) throw new SourceError('pprof_invalid_time');
  return ms;
}

function add(a: number, b: number): number {
  const value = a + b;
  if (!Number.isSafeInteger(value)) throw new SourceError('pprof_sample_overflow');
  return value;
}

/** Decode a native gzip pprof, preserving all nonnegative sample weights. */
export function convertPprof(data: Uint8Array, kind: PprofKind, name: string, maxBytes = 16 * 1024 * 1024): ConvertedProfile {
  let raw: Buffer;
  try {
    raw = data[0] === 0x1f && data[1] === 0x8b ? gunzipSync(data, {maxOutputLength: maxBytes}) : Buffer.from(data);
  } catch { throw new SourceError('pprof_invalid_or_oversized_gzip'); }
  if (raw.length > maxBytes) throw new SourceError('pprof_response_too_large');
  let decoded: Profile;
  try { decoded = profileType.decode(raw) as unknown as Profile; }
  catch { throw new SourceError('pprof_invalid_protobuf'); }
  if (decoded.stringTable[0] !== '' || !decoded.sampleType.length
    || [decoded.sample, decoded.location, decoded.function, decoded.stringTable].some(rows => rows.length > MAX_TABLE_ROWS)) {
    throw new SourceError('pprof_invalid_or_oversized_tables');
  }
  const string = (index: Integer): string => {
    const value = decoded.stringTable[number(index)];
    if (value === undefined) throw new SourceError('pprof_invalid_string_reference');
    return value;
  };
  const sampleIndex = decoded.sampleType.findIndex(type => string(type.type) === (kind === 'cpu' ? 'samples' : 'alloc_space')
    && string(type.unit) === (kind === 'cpu' ? 'count' : 'bytes'));
  if (sampleIndex < 0) throw new SourceError('pprof_unsupported_sample_type');
  const period = number(decoded.period);
  if (kind === 'cpu' && (!period || !decoded.periodType || string(decoded.periodType.type) !== 'cpu'
    || string(decoded.periodType.unit) !== 'nanoseconds')) throw new SourceError('pprof_unsupported_cpu_period');
  const functions = new Map<string, Profile['function'][number]>();
  for (const fn of decoded.function) {
    const id = String(fn.id);
    if (id === '0' || functions.has(id)) throw new SourceError('pprof_invalid_function_id');
    functions.set(id, fn);
  }
  const locations = new Map<string, string[]>();
  for (const location of decoded.location) {
    const id = String(location.id);
    if (id === '0' || locations.has(id)) throw new SourceError('pprof_invalid_location_id');
    if (location.line.length > MAX_STACK_FRAMES) throw new SourceError('pprof_stack_too_deep');
    const frames = location.line.map(line => {
      const fn = functions.get(String(line.functionId));
      if (!fn) throw new SourceError('pprof_missing_function');
      const functionName = safeScalar(string(fn.name)) || '[unknown]';
      const filename = safeScalar(string(fn.filename));
      return `${functionName}${filename ? ` ${filename}:${number(line.line)}` : ''}`;
    });
    // Inline frames and locations both arrive leaf first; the tree is root first.
    locations.set(id, frames.length ? frames.reverse() : [`[unknown address ${String(location.address)}]`]);
  }
  const root: Node = {name: 'total', self: 0, total: 0, children: new Map()};
  let treeNodes = 1;
  for (const sample of decoded.sample) {
    if (sample.value.length !== decoded.sampleType.length) throw new SourceError('pprof_sample_type_mismatch');
    const weight = number(sample.value[sampleIndex]);
    if (!weight) continue;
    if (sample.locationId.length > MAX_STACK_FRAMES) throw new SourceError('pprof_stack_too_deep');
    const frames: string[] = [];
    for (let i = sample.locationId.length - 1; i >= 0; i--) {
      const locationFrames = locations.get(String(sample.locationId[i]));
      if (!locationFrames) throw new SourceError('pprof_missing_location');
      frames.push(...locationFrames);
      if (frames.length > MAX_STACK_FRAMES) throw new SourceError('pprof_stack_too_deep');
    }
    let node = root;
    node.total = add(node.total, weight);
    for (const frame of frames) {
      let child = node.children.get(frame);
      if (!child) {
        if (++treeNodes > MAX_TREE_NODES) throw new SourceError('pprof_tree_too_large');
        child = {name: frame, self: 0, total: 0, children: new Map()};
        node.children.set(frame, child);
      }
      child.total = add(child.total, weight);
      node = child;
    }
    node.self = add(node.self, weight);
  }
  const names: string[] = [];
  const nameIds = new Map<string, number>();
  const levels: number[][] = [];
  let maxSelf = 0;
  const walk = (node: Node, depth: number, x: number): void => {
    let id = nameIds.get(node.name);
    if (id === undefined) { id = names.length; names.push(node.name); nameIds.set(node.name, id); }
    (levels[depth] ??= []).push(x, node.total, node.self, id);
    maxSelf = Math.max(maxSelf, node.self);
    x += node.self;
    for (const child of [...node.children.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      walk(child, depth + 1, x);
      x += child.total;
    }
  };
  walk(root, 0, 0);
  for (const level of levels) {
    let previousEnd = 0;
    for (let i = 0; i < level.length; i += 4) {
      const absolute = level[i];
      level[i] -= previousEnd;
      previousEnd = absolute + level[i + 1];
    }
  }
  return {profile: {version: 1, flamebearer: {names, levels, numTicks: root.total, maxSelf},
    metadata: {format: 'single', sampleRate: kind === 'cpu' ? 1e9 / period : 1, spyName: 'go',
      units: kind === 'cpu' ? 'samples' : 'bytes', name}},
    timeMs: milliseconds(decoded.timeNanos), durationSeconds: milliseconds(decoded.durationNanos) / 1000};
}

async function fetchProfile(input: MulticaInputConfig, kind: PprofKind, seconds: number): Promise<Uint8Array> {
  const url = new URL(`/debug/pprof/${kind === 'cpu' ? 'profile' : 'allocs'}`, input.PprofBaseUrl);
  url.searchParams.set('seconds', String(seconds));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), seconds * 1000 + (input.TimeoutMs ?? 10_000));
  try {
    // pprof is separate from the business API. Never read or forward its PAT.
    const response = await fetch(url, {headers: {Accept: 'application/octet-stream'}, signal: controller.signal, redirect: 'manual'});
    if (!response.ok) { await response.body?.cancel(); throw new SourceError(`pprof_http_${response.status}`); }
    const maxBytes = input.PprofMaxBytes ?? 16 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel(); throw new SourceError('pprof_response_too_large');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new SourceError('pprof_empty_response');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maxBytes) throw new SourceError('pprof_response_too_large');
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel(); }
    return Buffer.concat(chunks);
  } finally { clearTimeout(timer); }
}

export async function collectPprof(input: MulticaInputConfig, kind: PprofKind): Promise<CollectionResult> {
  const seconds = kind === 'cpu' ? input.PprofCpuSeconds ?? 30 : input.PprofAllocsSeconds ?? 10;
  const requestedAt = Date.now();
  const binary = await fetchProfile(input, kind, seconds);
  const receivedAt = Date.now();
  const converted = convertPprof(binary, kind, `${safeScalar(input.Instance) ?? 'multica'} ${kind}`, input.PprofMaxBytes);
  // net/http/pprof encodes CPU time as interval start, but delta allocs as end.
  // An old server ignoring ?seconds returns a cumulative profile (duration=0).
  if (converted.durationSeconds <= 0) throw new SourceError('pprof_missing_interval');
  const durationMs = converted.durationSeconds * 1000;
  const endedAt = converted.timeMs > 0 ? converted.timeMs + (kind === 'cpu' ? durationMs : 0) : receivedAt;
  const startedAt = converted.timeMs > 0 ? endedAt - durationMs : requestedAt;
  const raw = JSON.stringify(converted.profile).replace(/[\u0080-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  if (raw.length > MAX_FLAMEBEARER_BYTES) throw new SourceError('pprof_flamegraph_too_large');
  const sha = digest(raw);
  const id = `${kind}-${digest(`${input.PprofBaseUrl}:${endedAt}:${sha}`).slice(0, 24)}`;
  const count = Math.ceil(raw.length / 1800);
  const records: MulticaRecord[] = [];
  for (let i = 0; i < count; i++) records.push({record_type: 'pprof_profile_chunk', source_type: 'pprof',
    entity_id: `${id}:${i}`, profile_id: id, profile_type: kind, profile_json_part: raw.slice(i * 1800, (i + 1) * 1800),
    profile_part_index: String(i), profile_part_count: String(count), profile_sha256: sha,
    profile_unit: converted.profile.metadata.units, profile_total: String(converted.profile.flamebearer.numTicks),
    profile_started_at: new Date(startedAt).toISOString(), profile_ended_at: new Date(endedAt).toISOString(),
    profile_end_ms: String(endedAt), profile_duration_seconds: String(converted.durationSeconds),
    profile_metadata_source: converted.timeMs > 0 ? 'native_pprof' : 'collector_clock',
    source_version: safeScalar(input.PprofSourceVersion) ?? '', pod_name: safeScalar(input.PprofPodName) ?? ''});
  return {records, checkpoint: {pprofNextCaptureAtMs: receivedAt + (input.PprofIntervalSeconds ?? 900) * 1000}};
}
