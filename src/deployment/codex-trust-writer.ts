import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { parse as parseToml } from 'smol-toml';

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

function asTable(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Locate editable lines without mistaking text in multiline strings or arrays
 * for config. This scanner only finds boundaries; smol-toml decodes keys and
 * validates the complete document. Keep original lines so unrelated formatting
 * and comments do not go through a TOML serialization round trip.
 */
function configLines(content: string): Array<{ text: string; editable: boolean }> {
  let quote = '';
  let multiline = false;
  let depth = 0;
  return content.split('\n').map(text => {
    const editable = !quote && depth === 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (quote) {
        if (quote === '"' && ch === '\\') { i++; continue; }
        if (ch !== quote) continue;
        if (!multiline) { quote = ''; continue; }
        if (text.slice(i, i + 3) !== quote.repeat(3)) continue;
        // A multiline closing delimiter may have one or two literal quotes.
        while (text[i + 1] === quote) i++;
        quote = '';
        multiline = false;
      } else if (ch === '#') {
        break;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        multiline = text.slice(i, i + 3) === ch.repeat(3);
        if (multiline) i += 2;
      } else if (ch === '[' || ch === '{') {
        depth++;
      } else if (ch === ']' || ch === '}') {
        depth--;
      }
    }
    return { text, editable };
  });
}

function trustSectionKey(header: string): string | undefined {
  // Only a table declaration, never an assignment or an array of tables.
  if (!/^\s*\[(?!\[)/.test(header)) return undefined;
  try {
    const parsed = parseToml(header);
    const hooks = asTable(parsed.hooks);
    const state = asTable(hooks?.state);
    if (!state || Object.keys(parsed).length !== 1 || Object.keys(hooks!).length !== 1) {
      return undefined;
    }
    const keys = Object.keys(state);
    const table = keys.length === 1 ? asTable(state[keys[0]!]) : undefined;
    return table && Object.keys(table).length === 0 ? keys[0] : undefined;
  } catch {
    // Recover the exact malformed Windows path emitted by old Pilot versions.
    // Never use the raw spelling as an alternative when TOML decoding succeeds:
    // an escaped key can name a different, third-party handler.
    const legacy = header.match(/^\s*\[hooks\.state\."([^"\r\n]+)"\]\s*$/);
    return legacy?.[1];
  }
}

interface ParsedTrustSection {
  key: string;
  hash?: string;
  enabled?: boolean;
}

interface TrustSectionRange {
  key: string;
  start: number;
  end: number;
}

function trustSectionRanges(content: string): TrustSectionRange[] {
  const lines = configLines(content);
  const sections: TrustSectionRange[] = [];
  let current: TrustSectionRange | undefined;
  for (let i = 0; i < lines.length; i++) {
    const { text, editable } = lines[i]!;
    if (!editable || !/^\s*\[/.test(text)) continue;
    if (current) current.end = i;
    const key = trustSectionKey(text);
    current = key === undefined ? undefined : { key, start: i, end: lines.length };
    if (current) sections.push(current);
  }
  return sections;
}

function parseTrustSections(content: string): ParsedTrustSection[] {
  const lines = content.split('\n');
  return trustSectionRanges(content).map(({ key, start, end }) => {
    try {
      const fields = parseToml(lines.slice(start + 1, end).join('\n'), { integersAsBigInt: true });
      return {
        key,
        hash: typeof fields.trusted_hash === 'string' ? fields.trusted_hash : undefined,
        enabled: typeof fields.enabled === 'boolean' ? fields.enabled : undefined,
      };
    } catch {
      return { key };
    }
  });
}

function removeExactTrustSections(content: string, keys: ReadonlySet<string>): string {
  if (keys.size === 0) return content;
  const lines = content.split('\n');
  const keep = lines.map(() => true);
  for (const { key, start, end } of trustSectionRanges(content)) {
    if (!keys.has(key)) continue;
    // An unclosed value in an owned section can hide subsequent user tables.
    // Refuse to delete an ambiguous range, even if its removal would produce
    // syntactically valid output. Legacy malformed Windows *headers* remain
    // repairable because only the body is checked here.
    validateConfig(lines.slice(start + 1, end).join('\n'));
    keep.fill(false, start, end);
  }
  return lines.filter((_, i) => keep[i]).join('\n');
}

function removeLegacyTrustMarkers(content: string, marker: string): string {
  return configLines(content).filter(({ text, editable }) => !editable || (
    text.trim() !== `# BEGIN ${marker} trust`
    && text.trim() !== `# END ${marker} trust`
    && !/^\s*bypass_hook_trust\s*=/.test(text)
  )).map(line => line.text).join('\n');
}

class InvalidCodexConfigError extends Error {}

function validateConfig(content: string): void {
  try {
    parseToml(content, { integersAsBigInt: true });
  } catch {
    // Parser error messages include source excerpts, potentially credentials.
    throw new InvalidCodexConfigError('Refusing to write invalid Codex config.toml; original file left unchanged');
  }
}

function writeValidatedConfig(configPath: string, content: string): void {
  validateConfig(content);
  fs.writeFileSync(configPath, content, 'utf-8');
}

export interface InstalledTrustOpts {
  configPath: string;
  hooksJsonAbsPath: string;
  locations: Record<string, InstalledCodexHookLocation>;
  marker: string;
}

interface LegacyTrustOpts {
  configPath: string;
  hooksJsonAbsPath: string;
  hookEvents: readonly string[];
  eventToCommand: Record<string, string>;
  eventToGroupIndex: Record<string, number>;
  marker: string;
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
  let state: Record<string, unknown> | undefined;
  try {
    const parsed = parseToml(content, { integersAsBigInt: true });
    state = asTable(asTable(parsed.hooks)?.state);
  } catch {
    return { valid: false, mismatches: ['invalid Codex config.toml'] };
  }
  const mismatches: string[] = [];
  // Pilot briefly wrote this as an emergency bypass, but Codex only supports
  // bypassing trust via the per-invocation --dangerously-bypass-hook-trust flag.
  // Treat the unsupported legacy field as repairable state so deployment removes it.
  if (configLines(content).some(line => line.editable && /^\s*bypass_hook_trust\s*=/.test(line.text))) {
    mismatches.push('unsupported config field bypass_hook_trust');
  }
  for (const [key, hash] of expectedTrustState(opts)) {
    const current = asTable(state?.[key])?.trusted_hash;
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
  const enabledByKey = new Map<string, boolean>();
  for (const section of parseTrustSections(existing)) {
    if (section.enabled === undefined || expected.get(section.key) !== section.hash) continue;
    // If old Pilot produced conflicting copies, an explicit disable wins.
    enabledByKey.set(section.key, enabledByKey.get(section.key) === false ? false : section.enabled);
  }

  let content = removeLegacyTrustMarkers(existing, opts.marker);
  content = removeExactTrustSections(content, exactKeys);

  const lines: string[] = [begin];
  for (const [key, hash] of expected) {
    lines.push(`[hooks.state.${encodeTomlBasicString(key)}]`);
    const enabled = enabledByKey.get(key);
    if (enabled !== undefined) lines.push(`enabled = ${enabled}`);
    lines.push(`trusted_hash = "${hash}"`, '');
  }
  lines.push(end);
  const separator = !content || content.endsWith('\n') ? '' : '\n';
  const output = `${content}${separator}\n${lines.join('\n')}\n`;
  if (output === existing) return false;
  writeValidatedConfig(opts.configPath, output);
  return true;
}

export function removeTrustBlock(
  configPath: string,
  marker: string,
  ownedHookStateKeys: readonly string[] = [],
): boolean {
  if (!fs.existsSync(configPath)) return false;
  const before = fs.readFileSync(configPath, 'utf-8');
  const owned = new Set(ownedHookStateKeys);
  const content = removeExactTrustSections(removeLegacyTrustMarkers(before, marker), owned);
  if (content === before) return false;
  writeValidatedConfig(configPath, content);
  return true;
}

/**
 * Remove exact position-based trust entries without touching the active markers.
 * Retired-key cleanup runs before current trust repair: leave invalid TOML
 * unchanged and return false so that repair still gets a chance to run.
 * Filesystem errors still propagate to the caller's deployment error handler.
 */
export function removeTrustStateKeys(
  configPath: string,
  ownedHookStateKeys: readonly string[],
): boolean {
  if (!fs.existsSync(configPath) || ownedHookStateKeys.length === 0) return false;
  const before = fs.readFileSync(configPath, 'utf-8');
  try {
    const content = removeExactTrustSections(before, new Set(ownedHookStateKeys));
    if (content === before) return false;
    writeValidatedConfig(configPath, content);
    return true;
  } catch (err) {
    if (err instanceof InvalidCodexConfigError) return false;
    throw err;
  }
}

export interface VerifyResult {
  valid: boolean;
  mismatches: string[];
}
