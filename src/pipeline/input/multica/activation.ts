import { performance } from 'node:perf_hooks';
import { fetchBounded, SourceError } from './http.js';
import { parsePrometheus } from './parsers.js';
import type { MulticaInputConfig } from './types.js';

export type MulticaCollectionMode = 'on' | 'off';

export interface MulticaActivationResult {
  enabled: boolean;
  mode: MulticaCollectionMode;
  reason: string;
  consecutiveMisses: number;
  stopped: boolean;
}

const PROBE_BUDGET_MS = 5_000;
const PROBE_TIMEOUT_MS = 1_000;
const PROBE_MAX_BYTES = 256 * 1024;

export function parseMulticaCollectionMode(value: unknown): MulticaCollectionMode {
  if (value === undefined) return 'off';
  if (typeof value === 'string') {
    const mode = value.trim().toLowerCase();
    if (mode === 'on' || mode === 'off') return mode;
  }
  throw new SourceError('invalid_collection_mode');
}

type ProbeKind = 'api' | 'daemon' | 'metrics';
interface Probe { kind: ProbeKind; url: string }
interface DetectionResult { detected: boolean; reason: string }

function jsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* A successful HTTP response alone is not a product fingerprint. */ }
  return undefined;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function daemonFingerprint(text: string): boolean {
  const row = jsonObject(text);
  if (!row) return false;
  // These fields were present in the original daemon health response. Newer
  // counters and CLI version fields are deliberately not required.
  return (row.status === 'running' || row.status === 'starting')
    && Number.isSafeInteger(row.pid) && Number(row.pid) > 0
    && typeof row.uptime === 'string' && row.uptime.length > 0
    && typeof row.daemon_id === 'string' && row.daemon_id.length > 0
    && typeof row.device_name === 'string'
    && typeof row.server_url === 'string' && /^https?:\/\//.test(row.server_url)
    && stringArray(row.agents)
    && (row.workspaces === null || (Array.isArray(row.workspaces) && row.workspaces.every(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const workspace = value as Record<string, unknown>;
      return typeof workspace.id === 'string' && (workspace.runtimes === null || stringArray(workspace.runtimes));
    })));
}

function apiFingerprint(text: string): boolean {
  const row = jsonObject(text);
  if (!row || typeof row.allow_signup !== 'boolean' || typeof row.cdn_domain !== 'string') return false;
  // /api/config is public. The setup target was added later than the two
  // capability fields, so accept either product-specific response shape.
  return row.daemon_setup_target === 'cloud' || row.daemon_setup_target === 'self_host'
    || (typeof row.local_worktree_supported === 'boolean' && typeof row.agent_conversation_starters_supported === 'boolean');
}

function matches(probe: Probe, text: string): boolean {
  if (probe.kind === 'api') return apiFingerprint(text);
  if (probe.kind === 'daemon') return daemonFingerprint(text);
  return parsePrometheus(text).some(row => row.metric_name.startsWith('multica_') && Number.isFinite(Number(row.metric_value)));
}

export class MulticaActivationGate {
  private lastMode?: MulticaCollectionMode;
  private detected = false;
  private consecutiveMisses = 0;
  private stopped = false;
  private probeOffset = 0;

  constructor(private readonly input: MulticaInputConfig, private readonly defaultMode?: MulticaCollectionMode) {}

  async evaluate(): Promise<MulticaActivationResult> {
    let mode: MulticaCollectionMode;
    const legacy = process.env.LOONGSUITE_PILOT_PIPELINE_MULTICA_ENABLED?.trim().toLowerCase();
    if (legacy === 'false' || legacy === '0') return this.disable('legacy_disabled');
    try {
      mode = parseMulticaCollectionMode(process.env.LOONGSUITE_PILOT_MULTICA_COLLECTION_MODE
        ?? this.input.CollectionMode ?? this.defaultMode);
    } catch {
      return this.disable('invalid_collection_mode');
    }
    if (mode === 'off') return this.disable('forced_off');
    if (mode !== this.lastMode) this.resetDetection();
    this.lastMode = mode;
    if (this.stopped) return this.result(false, 'detection_stopped');

    let detection: DetectionResult;
    try { detection = await this.detect(); }
    catch { detection = {detected: false, reason: 'probe_unavailable'}; }
    if (detection.detected) {
      this.detected = true;
      this.consecutiveMisses = 0;
      return this.result(true, detection.reason);
    }
    this.consecutiveMisses++;
    const threshold = this.input.DetectionFailureThreshold ?? 3;
    if (this.consecutiveMisses >= threshold) {
      this.stopped = true;
      return this.result(false, 'detection_failure_threshold');
    }
    // Before the first identification, never collect business data. Once
    // identified, allow a short failure streak to retain outage diagnostics.
    return this.result(this.detected, detection.reason);
  }

  private result(enabled: boolean, reason: string): MulticaActivationResult {
    return {enabled, mode: 'on', reason, consecutiveMisses: this.consecutiveMisses, stopped: this.stopped};
  }

  private resetDetection(): void {
    this.detected = false;
    this.consecutiveMisses = 0;
    this.stopped = false;
    this.probeOffset = 0;
  }

  private disable(reason: string): MulticaActivationResult {
    this.resetDetection();
    this.lastMode = 'off';
    return {enabled: false, mode: 'off', reason, consecutiveMisses: 0, stopped: false};
  }

  private probes(): Probe[] {
    // Round-robin the configured source types so many unreachable metrics URLs
    // cannot consume the budget before the first daemon/API candidate is tried.
    const groups: Probe[][] = [
      this.input.ApiBase ? [{kind: 'api', url: `${this.input.ApiBase.replace(/\/$/, '')}/api/config`}] : [],
      (this.input.DaemonHealthUrls ?? []).map(url => ({kind: 'daemon', url})),
      (this.input.MetricsUrls ?? []).map(url => ({kind: 'metrics', url})),
    ];
    const result: Probe[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < Math.max(...groups.map(group => group.length)); index++) {
      for (const group of groups) {
        const probe = group[index];
        if (!probe || seen.has(`${probe.kind}:${probe.url}`)) continue;
        seen.add(`${probe.kind}:${probe.url}`);
        result.push(probe);
      }
    }
    return result;
  }

  private async detect(): Promise<DetectionResult> {
    const probes = this.probes();
    if (!probes.length) return {detected: false, reason: 'no_probe_sources'};
    const deadline = performance.now() + PROBE_BUDGET_MS;
    const startOffset = this.probeOffset % probes.length;
    let responded = false;
    for (let attempt = 0; attempt < probes.length; attempt++) {
      const index = (startOffset + attempt) % probes.length;
      const probe = probes[index];
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      // If this round exhausts its budget, resume at the next untried
      // candidate instead of repeatedly timing out on the same first URLs.
      this.probeOffset = (index + 1) % probes.length;
      try {
        // No workspace means fetchBounded neither reads nor sends API tokens.
        const response = await fetchBounded(probe.url, {
          ...this.input,
          TimeoutMs: Math.min(this.input.TimeoutMs ?? PROBE_TIMEOUT_MS, PROBE_TIMEOUT_MS, remaining),
          MaxResponseBytes: Math.min(this.input.MaxResponseBytes ?? PROBE_MAX_BYTES, PROBE_MAX_BYTES),
        });
        responded = true;
        if (matches(probe, response.text)) {
          // Prefer the last confirmed endpoint, but rotate past it on failure.
          this.probeOffset = index;
          return {detected: true, reason: `${probe.kind}_detected`};
        }
      } catch { /* Never expose response bodies, configured URLs or errors. */ }
    }
    return {detected: false, reason: responded ? 'not_detected' : 'probe_unavailable'};
  }
}
