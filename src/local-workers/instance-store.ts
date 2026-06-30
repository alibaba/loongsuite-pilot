import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ensureDir, readJsonFile, resolveHome, writeJsonFile } from '../utils/fs-utils.js';

export type RuntimeOptionValue = string | boolean;
export type RuntimeOptions = Record<string, RuntimeOptionValue>;

export interface LocalWorkerInstance {
  schemaVersion: 'loongsuite.localWorker.v1';
  id: string;
  runtime: string;
  workDir: string;
  bootstrapTokenRef: string;
  runtimeOptions: RuntimeOptions;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectLocalWorkerOptions {
  dataDir: string;
  runtime: string;
  bootstrapToken: string;
  workDir?: string;
  runtimeOptions?: RuntimeOptions;
}

export interface ReconnectLocalWorkerOptions {
  dataDir: string;
  instanceId: string;
  bootstrapToken?: string;
  workDir?: string;
  runtimeOptions?: RuntimeOptions;
}

export interface LocalWorkerView {
  id: string;
  runtime: string;
  workDir: string;
  enabled: boolean;
  state: string;
  pid?: number;
  workerName?: string;
  teamName?: string;
  matrix?: string;
  roomId?: string;
  heartbeat?: string;
  updatedAt: string;
  logPath: string;
}

const LOCAL_WORKER_HEARTBEAT_STALE_MS = 120_000;

export function localWorkerRoot(dataDir: string): string {
  return path.join(resolveHome(dataDir), 'local-workers');
}

export function instanceDir(dataDir: string, instanceId: string): string {
  return path.join(localWorkerRoot(dataDir), instanceId);
}

export function instanceConfigPath(dataDir: string, instanceId: string): string {
  return path.join(instanceDir(dataDir, instanceId), 'instance.json');
}

export function bootstrapTokenPath(dataDir: string, instance: LocalWorkerInstance): string {
  return path.join(instanceDir(dataDir, instance.id), instance.bootstrapTokenRef);
}

export function stateDir(dataDir: string, instanceId: string): string {
  return path.join(instanceDir(dataDir, instanceId), 'state');
}

export function logDir(dataDir: string, instanceId: string): string {
  return path.join(instanceDir(dataDir, instanceId), 'logs');
}

export function bundleDir(dataDir: string, instanceId: string): string {
  return path.join(instanceDir(dataDir, instanceId), 'bundle');
}

export async function deleteLocalWorkerInstance(dataDir: string, instanceId: string): Promise<void> {
  const instance = await readLocalWorkerInstance(dataDir, instanceId);
  if (!instance) throw new Error(`local worker not found: ${instanceId}`);
  if (instance.enabled) {
    throw new Error(`local worker must be disconnected before delete: ${instanceId}`);
  }

  if (await hasRunningLocalWorkerProcess(dataDir, instanceId)) {
    throw new Error(`local worker is still running, retry after disconnect stops it: ${instanceId}`);
  }
  await fs.rm(instanceDir(dataDir, instanceId), { recursive: true, force: true });
}

export async function connectLocalWorker(opts: ConnectLocalWorkerOptions): Promise<LocalWorkerInstance> {
  const runtime = opts.runtime.trim();
  if (!runtime) throw new Error('runtime is required');

  const token = opts.bootstrapToken.trim();
  if (!token) throw new Error('bootstrap token is required');

  const id = await createInstanceId(opts.dataDir);
  const dir = instanceDir(opts.dataDir, id);
  const now = new Date().toISOString();

  await ensureDir(stateDir(opts.dataDir, id));
  await ensureDir(logDir(opts.dataDir, id));
  await writeBootstrapToken(dir, token);

  const instance: LocalWorkerInstance = {
    schemaVersion: 'loongsuite.localWorker.v1',
    id,
    runtime,
    workDir: path.resolve(opts.workDir ?? process.cwd()),
    bootstrapTokenRef: 'credentials/bootstrap-token',
    runtimeOptions: normalizeRuntimeOptions(opts.runtimeOptions),
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };

  await writeJsonFile(instanceConfigPath(opts.dataDir, id), instance);
  return instance;
}

export async function reconnectLocalWorker(opts: ReconnectLocalWorkerOptions): Promise<LocalWorkerInstance> {
  const instance = await readLocalWorkerInstance(opts.dataDir, opts.instanceId);
  if (!instance) throw new Error(`local worker not found: ${opts.instanceId}`);

  const token = opts.bootstrapToken?.trim();
  if (token === '') throw new Error('bootstrap token is required');

  const dir = instanceDir(opts.dataDir, instance.id);
  await ensureDir(stateDir(opts.dataDir, instance.id));
  await ensureDir(logDir(opts.dataDir, instance.id));
  if (token) await writeBootstrapToken(dir, token);

  const updated: LocalWorkerInstance = {
    ...instance,
    workDir: opts.workDir ? path.resolve(opts.workDir) : instance.workDir,
    runtimeOptions: opts.runtimeOptions !== undefined
      ? normalizeRuntimeOptions(opts.runtimeOptions)
      : instance.runtimeOptions,
    enabled: true,
    updatedAt: new Date().toISOString(),
  };

  await writeJsonFile(instanceConfigPath(opts.dataDir, instance.id), updated);
  return updated;
}

export async function readLocalWorkerInstance(
  dataDir: string,
  instanceId: string,
): Promise<LocalWorkerInstance | null> {
  const instance = await readJsonFile<LocalWorkerInstance>(instanceConfigPath(dataDir, instanceId));
  if (!instance) return null;
  return {
    ...instance,
    runtimeOptions: normalizeRuntimeOptions(instance.runtimeOptions),
  };
}

function normalizeRuntimeOptions(value: unknown): RuntimeOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: RuntimeOptions = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!key) continue;
    if (typeof raw === 'boolean') {
      out[key] = raw;
    } else if (raw !== undefined && raw !== null) {
      out[key] = String(raw);
    }
  }
  return out;
}

export async function listLocalWorkerInstances(dataDir: string): Promise<LocalWorkerInstance[]> {
  const root = localWorkerRoot(dataDir);
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }

  const instances: LocalWorkerInstance[] = [];
  for (const entry of entries) {
    if (!entry.startsWith('lw_')) continue;
    const instance = await readLocalWorkerInstance(dataDir, entry);
    if (instance) instances.push(instance);
  }
  return instances.sort((a, b) => a.id.localeCompare(b.id));
}

export async function setLocalWorkerEnabled(
  dataDir: string,
  instanceId: string,
  enabled: boolean,
): Promise<LocalWorkerInstance> {
  const instance = await readLocalWorkerInstance(dataDir, instanceId);
  if (!instance) throw new Error(`local worker not found: ${instanceId}`);
  const updated = { ...instance, enabled, updatedAt: new Date().toISOString() };
  await writeJsonFile(instanceConfigPath(dataDir, instanceId), updated);
  return updated;
}

export async function listLocalWorkerViews(dataDir: string): Promise<LocalWorkerView[]> {
  const instances = await listLocalWorkerInstances(dataDir);
  const views = await Promise.all(instances.map(instance => readLocalWorkerView(dataDir, instance)));
  return views;
}

export async function readLocalWorkerView(
  dataDir: string,
  instance: LocalWorkerInstance,
): Promise<LocalWorkerView> {
  const sDir = stateDir(dataDir, instance.id);
  const lDir = logDir(dataDir, instance.id);
  const supervisor = await readJsonFile<Record<string, unknown>>(path.join(sDir, 'supervisor-status.json'));
  const worker = await readJsonFile<Record<string, unknown>>(path.join(sDir, 'status.json'));
  const runtimeSnapshot = await readJsonFile<Record<string, unknown>>(path.join(sDir, 'runtime-state.json'));
  const matrixSnapshot = await readJsonFile<Record<string, unknown>>(path.join(sDir, 'matrix-state.json'));
  const runtimeMember = readRecord(runtimeSnapshot?.member);
  const pid = readNumber(supervisor?.pid);
  const alive = pid ? isAlive(pid) : false;
  const heartbeatAt = readTimestampMs(worker?.updatedAt ?? worker?.lastHeartbeatAt ?? worker?.heartbeatAt);
  const degraded = isWorkerDegraded(worker)
    || (alive && heartbeatAt !== undefined && Date.now() - heartbeatAt > LOCAL_WORKER_HEARTBEAT_STALE_MS);

  let state = 'pending';
  if (!instance.enabled) {
    state = 'disabled';
  } else if (String(supervisor?.state ?? '') === 'failed') {
    state = 'failed';
  } else if (degraded) {
    state = 'degraded';
  } else if (alive) {
    state = 'running';
  } else if (pid) {
    state = 'stale';
  } else if (typeof supervisor?.state === 'string') {
    state = supervisor.state;
  }

  return {
    id: instance.id,
    runtime: instance.runtime,
    workDir: instance.workDir,
    enabled: instance.enabled,
    state,
    pid,
    workerName: readString(worker?.workerName)
      ?? readString(worker?.runtimeName)
      ?? readString(runtimeMember?.runtimeName)
      ?? readString(runtimeMember?.name),
    teamName: readString(worker?.teamName) ?? readTeamName(runtimeSnapshot, runtimeMember),
    matrix: readDisplayValue(worker?.matrixConnected)
      ?? readDisplayValue(readRecord(worker?.matrix)?.connected)
      ?? readMatrixSnapshot(matrixSnapshot),
    roomId: readString(worker?.teamRoomId)
      ?? readString(worker?.roomId)
      ?? firstRecordKey(matrixSnapshot?.matrixCursors)
      ?? readString(runtimeMember?.teamRoomId)
      ?? readString(runtimeMember?.personalRoomId),
    heartbeat: readString(worker?.lastHeartbeatAt)
      ?? readString(worker?.heartbeatAt)
      ?? readTimestampDisplay(worker?.updatedAt),
    updatedAt: readString(worker?.updatedAt) ?? instance.updatedAt,
    logPath: path.join(lDir, 'worker.log'),
  };
}

export async function readBootstrapToken(dataDir: string, instance: LocalWorkerInstance): Promise<string> {
  return (await fs.readFile(bootstrapTokenPath(dataDir, instance), 'utf-8')).trim();
}

async function hasRunningLocalWorkerProcess(dataDir: string, instanceId: string): Promise<boolean> {
  const pids = new Set<number>();
  const pidFromFile = await readPidFile(path.join(stateDir(dataDir, instanceId), 'worker.pid'));
  if (pidFromFile) pids.add(pidFromFile);

  const supervisor = await readJsonFile<Record<string, unknown>>(
    path.join(stateDir(dataDir, instanceId), 'supervisor-status.json'),
  );
  const pidFromStatus = readNumber(supervisor?.pid);
  if (pidFromStatus) pids.add(pidFromStatus);

  for (const pid of pids) {
    if (isAlive(pid)) return true;
  }
  return false;
}

async function readPidFile(pidPath: string): Promise<number | undefined> {
  try {
    const pid = Number.parseInt((await fs.readFile(pidPath, 'utf-8')).trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function createInstanceId(dataDir: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = `lw_${base32(crypto.randomBytes(10)).slice(0, 16).toLowerCase()}`;
    if (!await readLocalWorkerInstance(dataDir, id)) return id;
  }
  throw new Error('failed to allocate local worker instance id');
}

async function writeBootstrapToken(dir: string, token: string): Promise<void> {
  const tokenPath = path.join(dir, 'credentials', 'bootstrap-token');
  await ensureDir(path.dirname(tokenPath));
  await fs.writeFile(tokenPath, token, { encoding: 'utf-8', mode: 0o600 });
  await fs.chmod(tokenPath, 0o600).catch(() => {});
}

function base32(bytes: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function readDisplayValue(value: unknown): string | undefined {
  if (typeof value === 'boolean') return value ? 'connected' : 'disconnected';
  if (typeof value === 'string' && value !== '') return value;
  return undefined;
}

function isWorkerDegraded(worker: Record<string, unknown> | null): boolean {
  const phase = String(worker?.phase ?? worker?.state ?? '').toLowerCase();
  const reason = String(worker?.reason ?? '').toLowerCase();
  return phase === 'degraded' || reason.includes('degraded');
}

function readTimestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readTimestampDisplay(value: unknown): string | undefined {
  const raw = readString(value);
  if (raw) return raw;
  const ms = readTimestampMs(value);
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readTeamName(
  runtimeSnapshot: Record<string, unknown> | null,
  runtimeMember?: Record<string, unknown>,
): string | undefined {
  const direct = readString(runtimeSnapshot?.teamName)
    ?? readString(runtimeMember?.teamName);
  if (direct) return direct;

  const storage = readRecord(runtimeSnapshot?.storage);
  const storageName = readString(storage?.teamName);
  if (storageName) return storageName;

  const teamPrefix = readString(storage?.teamPrefix);
  if (!teamPrefix) return undefined;
  const match = teamPrefix.match(/(?:^|\/)teams\/([^/]+)/);
  return match?.[1];
}

function readMatrixSnapshot(value: Record<string, unknown> | null): string | undefined {
  if (!value) return undefined;
  if (readString(value.matrixSyncToken)) return 'connected';
  const cursors = readRecord(value.matrixCursors);
  return cursors && Object.keys(cursors).length > 0 ? 'connected' : undefined;
}

function firstRecordKey(value: unknown): string | undefined {
  const record = readRecord(value);
  return record ? Object.keys(record).find(key => key !== '') : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
