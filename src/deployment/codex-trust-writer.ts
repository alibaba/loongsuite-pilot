import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

export const CODEX_HOOK_EVENT_KEYS: Record<string, string> = {
  PreToolUse: 'pre_tool_use',
  PermissionRequest: 'permission_request',
  PostToolUse: 'post_tool_use',
  PostToolUseFailure: 'post_tool_use_failure',
  PreCompact: 'pre_compact',
  PostCompact: 'post_compact',
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  UserPromptSubmit: 'user_prompt_submit',
  SubagentStart: 'subagent_start',
  SubagentStop: 'subagent_stop',
  Stop: 'stop',
};

const MATCHER_EVENTS = new Set([
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SessionStart',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop',
]);

const ADDITIONAL_CONTEXT_EVENTS = new Set([
  'PreToolUse',
  'PostToolUse',
  'SessionStart',
  'UserPromptSubmit',
  'SubagentStart',
]);

const DEFAULT_ADDITIONAL_CONTEXT_LIMIT = 2_500;

export interface InstalledCodexCommandHandler {
  type: 'command';
  command: string;
  commandWindows?: string;
  timeout?: number;
  async?: boolean;
  statusMessage?: string;
  additionalContextLimit?: number;
}

/** Exact location and source config of one handler in the installed hooks.json. */
export interface InstalledCodexHookLocation {
  eventName: string;
  eventKey: string;
  groupIndex: number;
  handlerIndex: number;
  matcher?: string;
  handler: InstalledCodexCommandHandler;
}

function canonicalJson(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalJson((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function versionForToml(obj: unknown): string {
  const serialized = JSON.stringify(canonicalJson(obj));
  const hex = crypto.createHash('sha256').update(serialized, 'utf-8').digest('hex');
  return `sha256:${hex}`;
}

function normalizedTimeout(eventName: string, configured: number | undefined): number {
  if (eventName === 'SessionEnd') {
    return Math.min(3, Math.max(1, configured ?? 1));
  }
  return Math.max(1, configured ?? 600);
}

/** Mirror Codex discovery.rs handler normalization before trust hashing. */
function normalizeInstalledHandler(
  location: InstalledCodexHookLocation,
  platform: NodeJS.Platform,
): Record<string, unknown> {
  const source = location.handler;
  const command = platform === 'win32'
    ? source.commandWindows ?? source.command
    : source.command;
  const normalized: Record<string, unknown> = {
    type: 'command',
    command,
    timeout: normalizedTimeout(location.eventName, source.timeout),
    async: source.async ?? false,
  };
  if (source.statusMessage !== undefined) normalized.statusMessage = source.statusMessage;
  if (
    ADDITIONAL_CONTEXT_EVENTS.has(location.eventName)
    && source.additionalContextLimit !== undefined
    && source.additionalContextLimit !== DEFAULT_ADDITIONAL_CONTEXT_LIMIT
  ) {
    normalized.additionalContextLimit = source.additionalContextLimit;
  }
  return normalized;
}

/** Compute the hash from the actual installed group and handler. */
export function computeInstalledHookTrustHash(
  location: InstalledCodexHookLocation,
  platform: NodeJS.Platform = process.platform,
): string {
  const expectedKey = CODEX_HOOK_EVENT_KEYS[location.eventName];
  if (!expectedKey || expectedKey !== location.eventKey) {
    throw new Error(`Unknown or inconsistent hook event: ${location.eventName}`);
  }
  const matcher = MATCHER_EVENTS.has(location.eventName) ? location.matcher : undefined;
  return versionForToml({
    event_name: location.eventKey,
    ...(matcher !== undefined ? { matcher } : {}),
    hooks: [normalizeInstalledHandler(location, platform)],
  });
}

/** Compatibility helper for callers that only need Codex's default command identity. */
export function computeHookTrustHash(
  eventName: string,
  command: string,
  matcher?: string,
): string {
  const eventKey = CODEX_HOOK_EVENT_KEYS[eventName];
  if (!eventKey) throw new Error(`Unknown hook event: ${eventName}`);
  return computeInstalledHookTrustHash({
    eventName,
    eventKey,
    groupIndex: 0,
    handlerIndex: 0,
    ...(matcher !== undefined ? { matcher } : {}),
    handler: { type: 'command', command },
  });
}

export function installedHookStateKey(
  hooksJsonAbsPath: string,
  location: InstalledCodexHookLocation,
): string {
  return `${hooksJsonAbsPath}:${location.eventKey}:${location.groupIndex}:${location.handlerIndex}`;
}

export function hookStateKey(
  hooksJsonAbsPath: string,
  eventName: string,
  groupIndex = 0,
  handlerIndex = 0,
): string {
  const eventKey = CODEX_HOOK_EVENT_KEYS[eventName];
  if (!eventKey) throw new Error(`Unknown hook event: ${eventName}`);
  return `${hooksJsonAbsPath}:${eventKey}:${groupIndex}:${handlerIndex}`;
}

function encodeTomlBasicString(value: string): string {
  return JSON.stringify(value);
}

function decodeTomlBasicString(value: string): string | null {
  try {
    const decoded: unknown = JSON.parse(value);
    return typeof decoded === 'string' ? decoded : null;
  } catch {
    return null;
  }
}

function tomlKeyCandidates(value: string): string[] {
  const decoded = decodeTomlBasicString(value);
  const raw = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : null;
  return [...new Set([decoded, raw].filter((candidate): candidate is string => candidate !== null))];
}

interface ParsedTrustSection {
  key: string;
  hash?: string;
  enabledLine?: string;
}

function parseTrustSections(content: string): ParsedTrustSection[] {
  const lines = content.split('\n');
  const sections: ParsedTrustSection[] = [];
  const header = /^\s*\[hooks\.state\.("(?:\\.|[^"\\])*")\]\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]!.match(header);
    if (!match) continue;
    const key = tomlKeyCandidates(match[1]!)[0];
    if (key === undefined) continue;
    const section: ParsedTrustSection = { key };
    for (let j = i + 1; j < lines.length && !/^\s*\[/.test(lines[j]!); j++) {
      const hash = lines[j]!.match(/^\s*trusted_hash\s*=\s*"([^"]+)"/);
      if (hash) section.hash = hash[1];
      if (/^\s*enabled\s*=/.test(lines[j]!)) section.enabledLine = lines[j]!.trim();
    }
    sections.push(section);
  }
  return sections;
}

function removeExactTrustSections(content: string, keys: ReadonlySet<string>): string {
  if (keys.size === 0) return content;
  const lines = content.split('\n');
  const out: string[] = [];
  const header = /^\s*\[hooks\.state\.("(?:\\.|[^"\\])*")\]\s*$/;
  let skipping = false;
  for (const line of lines) {
    const match = line.match(header);
    if (match) {
      skipping = tomlKeyCandidates(match[1]!).some(key => keys.has(key));
      if (!skipping) out.push(line);
      continue;
    }
    if (/^\s*\[/.test(line)) skipping = false;
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

export interface InstalledTrustOpts {
  configPath: string;
  hooksJsonAbsPath: string;
  locations: Record<string, InstalledCodexHookLocation>;
  marker: string;
  forceBypass?: boolean;
}

interface LegacyTrustOpts {
  configPath: string;
  hooksJsonAbsPath: string;
  hookEvents: readonly string[];
  eventToCommand: Record<string, string>;
  eventToGroupIndex: Record<string, number>;
  marker: string;
  forceBypass?: boolean;
}

type TrustOpts = InstalledTrustOpts | LegacyTrustOpts;

function normalizeTrustOpts(opts: TrustOpts): InstalledTrustOpts {
  if ('locations' in opts) return opts;
  const locations: Record<string, InstalledCodexHookLocation> = {};
  for (const eventName of opts.hookEvents) {
    const eventKey = CODEX_HOOK_EVENT_KEYS[eventName];
    const command = opts.eventToCommand[eventName];
    if (!eventKey) throw new Error(`Unknown hook event: ${eventName}`);
    if (!command) throw new Error(`Missing eventToCommand[${eventName}]`);
    locations[eventName] = {
      eventName,
      eventKey,
      groupIndex: opts.eventToGroupIndex[eventName] ?? 0,
      handlerIndex: 0,
      handler: { type: 'command', command },
    };
  }
  return {
    configPath: opts.configPath,
    hooksJsonAbsPath: opts.hooksJsonAbsPath,
    locations,
    marker: opts.marker,
    ...(opts.forceBypass !== undefined ? { forceBypass: opts.forceBypass } : {}),
  };
}

function expectedTrustState(opts: InstalledTrustOpts): Map<string, string> {
  const expected = new Map<string, string>();
  for (const location of Object.values(opts.locations)) {
    expected.set(
      installedHookStateKey(opts.hooksJsonAbsPath, location),
      computeInstalledHookTrustHash(location),
    );
  }
  return expected;
}

/** Exact deterministic verification against the installed hooks.json locations. */
export function verifyTrustHashes(rawOpts: TrustOpts): VerifyResult {
  const opts = normalizeTrustOpts(rawOpts);
  if (!fs.existsSync(opts.configPath)) {
    return { valid: false, mismatches: ['config.toml missing'] };
  }
  const content = fs.readFileSync(opts.configPath, 'utf-8');
  const actual = new Map(parseTrustSections(content).map(section => [section.key, section.hash]));
  const mismatches: string[] = [];
  const bypassPresent = /^\s*bypass_hook_trust\s*=\s*true\s*$/m.test(content);
  if (opts.forceBypass && !bypassPresent) {
    mismatches.push('missing bypass_hook_trust = true');
  } else if (!opts.forceBypass && bypassPresent) {
    mismatches.push('unexpected bypass_hook_trust = true');
  }
  for (const [key, hash] of expectedTrustState(opts)) {
    const current = actual.get(key);
    if (current === undefined) mismatches.push(`missing key=${key}`);
    else if (current !== hash) mismatches.push(`hash mismatch key=${key} (expected=${hash}, got=${current})`);
  }
  return { valid: mismatches.length === 0, mismatches };
}

/**
 * Upsert only Pilot's exact current keys. Marker position is never used to
 * infer ownership, so unrelated hook state survives Codex TOML reserialization.
 * Returns false when the trust state is already correct and no file was written.
 */
export function writeTrustedHashes(rawOpts: TrustOpts): boolean {
  const opts = normalizeTrustOpts(rawOpts);
  const existing = fs.existsSync(opts.configPath)
    ? fs.readFileSync(opts.configPath, 'utf-8')
    : '';
  if (verifyTrustHashes(opts).valid) return false;

  const begin = `# BEGIN ${opts.marker} trust`;
  const end = `# END ${opts.marker} trust`;
  const expected = expectedTrustState(opts);
  // Never infer ownership from marker position: Codex may reserialize TOML and
  // move the END comment past unrelated third-party sections. Until persisted
  // owned-key metadata is introduced, only touch the exact current Pilot keys.
  const exactKeys = new Set(expected.keys());
  const enabledByKey = new Map(
    parseTrustSections(existing)
      .filter(section => (
        section.enabledLine !== undefined
        && expected.get(section.key) === section.hash
      ))
      .map(section => [section.key, section.enabledLine!]),
  );

  let content = existing.split('\n')
    .filter(line => line.trim() !== begin && line.trim() !== end)
    .filter(line => !/^\s*bypass_hook_trust\s*=/.test(line))
    .join('\n');
  content = removeExactTrustSections(content, exactKeys);

  const lines: string[] = [begin];
  if (opts.forceBypass) lines.push('bypass_hook_trust = true', '');
  for (const [key, hash] of expected) {
    lines.push(`[hooks.state.${encodeTomlBasicString(key)}]`);
    const enabled = enabledByKey.get(key);
    if (enabled) lines.push(enabled);
    lines.push(`trusted_hash = "${hash}"`, '');
  }
  lines.push(end);
  const separator = !content || content.endsWith('\n') ? '' : '\n';
  const output = `${content}${separator}\n${lines.join('\n')}\n`.replace(/\n{3,}/g, '\n\n');
  if (output === existing) return false;
  fs.writeFileSync(opts.configPath, output, 'utf-8');
  return true;
}

export function removeTrustBlock(
  configPath: string,
  marker: string,
  ownedHookStateKeys: readonly string[] = [],
): boolean {
  if (!fs.existsSync(configPath)) return false;
  const before = fs.readFileSync(configPath, 'utf-8');
  const begin = `# BEGIN ${marker} trust`;
  const end = `# END ${marker} trust`;
  const owned = new Set(ownedHookStateKeys);
  let content = before.split('\n')
    .filter(line => line.trim() !== begin && line.trim() !== end)
    .filter(line => !/^\s*bypass_hook_trust\s*=/.test(line))
    .join('\n');
  content = removeExactTrustSections(content, owned).replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  if (content === before) return false;
  fs.writeFileSync(configPath, content, 'utf-8');
  return true;
}

/** Remove exact position-based trust entries without touching the active block markers or bypass. */
export function removeTrustStateKeys(
  configPath: string,
  ownedHookStateKeys: readonly string[],
): boolean {
  if (!fs.existsSync(configPath) || ownedHookStateKeys.length === 0) return false;
  const before = fs.readFileSync(configPath, 'utf-8');
  const content = removeExactTrustSections(before, new Set(ownedHookStateKeys))
    .replace(/\n{3,}/g, '\n\n');
  if (content === before) return false;
  fs.writeFileSync(configPath, content, 'utf-8');
  return true;
}

export interface VerifyResult {
  valid: boolean;
  mismatches: string[];
}
