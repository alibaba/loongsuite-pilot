import * as path from 'node:path';
import { resolveHome } from '../../utils/fs-utils.js';
import {
  INTERCEPTOR_AGENTS,
  SUPPORTED_HOOK_EVENTS,
  type HookEventName,
  type InterceptorAgent,
  type RuleAction,
} from '../types.js';

export type ManagedShell = 'sh' | 'powershell';

/** Windows uses powershell; macOS and Linux share sh. */
export function platformManagedShell(platform: NodeJS.Platform = process.platform): ManagedShell {
  return platform === 'win32' ? 'powershell' : 'sh';
}

export type ManagedPatternMatch = 'regex' | 'substring';

interface ManagedRuleBase {
  id: string;
  version: string;
  agents: InterceptorAgent[];
  events: HookEventName[];
  action: RuleAction;
  /** Optional risk label; does not affect matching or enforcement. */
  severity?: string;
  /** Display label for local diagnostics. Not shown to the host. */
  title?: string;
  /** Reminder shown to the host/agent when this rule blocks. */
  message?: string;
}

export interface ManagedRegexRule extends ManagedRuleBase {
  kind: 'pattern';
  match: 'regex';
  /** User-authored regex source, run in a terminable Worker. */
  pattern: string;
}

export interface ManagedSubstringRule extends ManagedRuleBase {
  kind: 'pattern';
  match: 'substring';
  /** Case-sensitive literals; any keyword is sufficient to match. */
  keywords: string[];
}

export type ManagedPatternRule = ManagedRegexRule | ManagedSubstringRule;

export interface ManagedScriptRule extends ManagedRuleBase {
  kind: 'script';
  shell: ManagedShell;
}

export interface ManagedHttpRule extends ManagedRuleBase {
  kind: 'http';
  url: string;
}

export type ManagedRule = ManagedPatternRule | ManagedScriptRule | ManagedHttpRule;

export interface ManagedInterceptorConfig {
  rules: ManagedRule[];
  /** Local-only namespace selecting a complete set of script files. */
  scriptCache?: string;
}

export function scriptRulesOf(config: ManagedInterceptorConfig): ManagedScriptRule[] {
  return config.rules.filter((rule): rule is ManagedScriptRule => rule.kind === 'script');
}

export function patternRulesOf(config: ManagedInterceptorConfig): ManagedPatternRule[] {
  return config.rules.filter((rule): rule is ManagedPatternRule => rule.kind === 'pattern');
}

/** id and version become one path segment; neither may contain a separator or `@`. */
const SCRIPT_TOKEN_RE = /^[A-Za-z0-9._-]+$/;
const SHELL_EXTENSIONS: Record<ManagedShell, string> = { sh: 'sh', powershell: 'ps1' };
const HOOK_EVENT_SET = new Set<string>(SUPPORTED_HOOK_EVENTS);
const AGENT_SET = new Set<string>(INTERCEPTOR_AGENTS);

export function managedConfigDir(dataDir: string): string {
  return path.join(resolveHome(dataDir), 'configs', 'managed');
}

export function managedInterceptorPath(dataDir: string): string {
  return path.join(managedConfigDir(dataDir), 'interceptor.json');
}

export function managedScriptsDir(dataDir: string, scriptCache?: string): string {
  const dir = path.join(managedConfigDir(dataDir), 'scripts');
  return scriptCache === undefined ? dir : path.join(dir, parseScriptCache(scriptCache));
}

/** Configuration providers and the engine must agree on this derived file name. */
export function managedScriptFileName(rule: { id: string; version: string; shell: ManagedShell }): string {
  return `${rule.id}@${rule.version}.${SHELL_EXTENSIONS[rule.shell]}`;
}

export class ManagedConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagedConfigError';
  }
}

/** Parses known fields; unknown fields are ignored for forward compatibility. */
export function parseManagedInterceptorConfig(
  value: unknown,
  opts: { allowLocalScriptCache?: boolean } = {},
): ManagedInterceptorConfig {
  const root = asRecord(value, 'document');
  const interceptor = asRecord(root.interceptor, 'interceptor');
  return {
    rules: parseRuleList(interceptor.rules, parseManagedRule),
    ...(opts.allowLocalScriptCache && interceptor.scriptCache !== undefined
      ? { scriptCache: parseScriptCache(interceptor.scriptCache) } : {}),
  };
}

function parseScriptCache(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new ManagedConfigError('interceptor.scriptCache must be a SHA-256 digest');
  }
  return value;
}

export const MAX_RULE_TITLE_CHARS = 128;
export const MAX_RULE_SEVERITY_CHARS = 128;
export const MAX_RULE_MESSAGE_CHARS = 2000;
export const MAX_RULE_PATTERN_CHARS = 2000;
export const PATTERN_BLOCKED_REASON = '[PATTERN_BLOCKED]';

function parseRuleList<T extends { id: string }>(
  value: unknown,
  parseOne: (raw: unknown, where: string) => T,
  where = 'interceptor.rules',
): T[] {
  if (!Array.isArray(value)) throw new ManagedConfigError(`${where} must be an array`);
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const rule = parseOne(raw, `${where}[${index}]`);
    if (seen.has(rule.id)) throw new ManagedConfigError(`duplicate rule id ${rule.id}`);
    seen.add(rule.id);
    return rule;
  });
}

function parseManagedRule(value: unknown, where: string): ManagedRule {
  const rule = asRecord(value, where);
  if (rule.kind === 'pattern') return parsePatternRule(rule, where);
  if (rule.kind === 'script') return parseScriptRule(rule, where);
  if (rule.kind === 'http') return parseHttpRule(rule, where);
  throw new ManagedConfigError(`${where}.kind must be "pattern", "script", or "http"`);
}

function parseScriptRule(value: Record<string, unknown>, where: string): ManagedScriptRule {
  if (value.shell !== 'sh' && value.shell !== 'powershell') {
    throw new ManagedConfigError(`${where}.shell must be "sh" or "powershell"`);
  }
  return { kind: 'script', ...parseRuleBase(value, where), shell: value.shell };
}

function parsePatternRule(value: Record<string, unknown>, where: string): ManagedPatternRule {
  if (value.match !== 'regex' && value.match !== 'substring') {
    throw new ManagedConfigError(`${where}.match must be "regex" or "substring"`);
  }
  if (value.match === 'substring') {
    if (!Array.isArray(value.keywords) || value.keywords.length === 0) {
      throw new ManagedConfigError(`${where}.keywords must be a non-empty array`);
    }
    const keywords = value.keywords.map((keyword, index) => {
      const key = `${where}.keywords[${index}]`;
      if (typeof keyword !== 'string') throw new ManagedConfigError(`${key} must be a string`);
      if (keyword.length === 0) throw new ManagedConfigError(`${key} must not be empty`);
      if (keyword.length > MAX_RULE_PATTERN_CHARS) {
        throw new ManagedConfigError(`${key} is longer than ${MAX_RULE_PATTERN_CHARS} characters`);
      }
      return keyword;
    });
    return { kind: 'pattern', ...parseRuleBase(value, where), match: 'substring', keywords };
  }
  if (typeof value.pattern !== 'string') throw new ManagedConfigError(`${where}.pattern must be a string`);
  const pattern = value.pattern;
  if (pattern.length === 0) throw new ManagedConfigError(`${where}.pattern must not be empty`);
  if (pattern.length > MAX_RULE_PATTERN_CHARS) {
    throw new ManagedConfigError(`${where}.pattern is longer than ${MAX_RULE_PATTERN_CHARS} characters`);
  }
  compileManagedRegex(pattern, where);
  return { kind: 'pattern', ...parseRuleBase(value, where), match: 'regex', pattern };
}

function parseHttpRule(value: Record<string, unknown>, where: string): ManagedHttpRule {
  return { kind: 'http', ...parseRuleBase(value, where), url: parseHttpsUrl(value.url, `${where}.url`) };
}

function parseRuleBase(value: Record<string, unknown>, where: string): ManagedRuleBase {
  if ('enforcement' in value) throw new ManagedConfigError(`${where} has unknown keys: enforcement`);
  const action = value.action === undefined ? 'block' : value.action;
  if (action !== 'block' && action !== 'log') {
    throw new ManagedConfigError(`${where}.action must be "block" or "log"`);
  }
  return {
    id: parseToken(value.id, `${where}.id`),
    version: parseToken(value.version, `${where}.version`),
    agents: parseIdList(value.agents, `${where}.agents`, AGENT_SET) as InterceptorAgent[],
    events: parseIdList(value.events, `${where}.events`, HOOK_EVENT_SET) as HookEventName[],
    action,
    ...optionalText(value.severity, `${where}.severity`, MAX_RULE_SEVERITY_CHARS, 'severity'),
    ...optionalText(value.title, `${where}.title`, MAX_RULE_TITLE_CHARS, 'title'),
    ...optionalText(value.message, `${where}.message`, MAX_RULE_MESSAGE_CHARS, 'message'),
  };
}

function optionalText(
  value: unknown,
  where: string,
  maxChars: number,
  key: 'title' | 'message' | 'severity',
): Partial<Record<'title' | 'message' | 'severity', string>> {
  const text = parseOptionalText(value, where, maxChars);
  return text ? { [key]: text } : {};
}

/** An empty list would make the rule silently never fire, so it is rejected like an unknown entry. */
function parseIdList(value: unknown, where: string, allowed: ReadonlySet<string>): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ManagedConfigError(`${where} must be a non-empty array`);
  }
  const items = value.map((item) => {
    if (typeof item !== 'string' || !allowed.has(item)) {
      throw new ManagedConfigError(`${where} has unsupported value ${String(item)}`);
    }
    return item;
  });
  return [...new Set(items)];
}

/** Compile a rule regex. Lookaround is rejected so Windows and Unix stay aligned. */
export function compileManagedRegex(pattern: string, where = 'pattern'): RegExp {
  if (hasLookaround(pattern)) {
    throw new ManagedConfigError(`${where} must not use lookahead or lookbehind`);
  }
  try {
    return new RegExp(pattern);
  } catch (err) {
    throw new ManagedConfigError(`${where} is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** No Unicode flag: matching preserves String.includes UTF-16 code-unit semantics. */
export function substringRegexSource(keywords: readonly string[]): string {
  if (keywords.length === 0) return '[]';
  return keywords.map(keyword => keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
}

export function patternRuleMatches(rule: ManagedPatternRule, text: string): boolean {
  if (rule.match === 'substring') return new RegExp(substringRegexSource(rule.keywords)).test(text);
  return compileManagedRegex(rule.pattern).test(text);
}

function hasLookaround(pattern: string): boolean {
  let escaped = false;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === '\\') {
      escaped = true;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') {
      inClass = true;
      continue;
    }
    if (c !== '(' || pattern[i + 1] !== '?') continue;
    const a = pattern[i + 2];
    const b = pattern[i + 3];
    if (a === '=' || a === '!') return true;
    if (a === '<' && (b === '=' || b === '!')) return true;
  }
  return false;
}

function parseOptionalText(value: unknown, where: string, maxChars: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ManagedConfigError(`${where} must be a string`);
  const text = value.trim();
  if (text.length === 0) throw new ManagedConfigError(`${where} must not be empty`);
  if (text.length > maxChars) {
    throw new ManagedConfigError(`${where} is longer than ${maxChars} characters`);
  }
  return text;
}

function parseToken(value: unknown, where: string): string {
  if (typeof value !== 'string' || !SCRIPT_TOKEN_RE.test(value) || value === '.' || value === '..') {
    throw new ManagedConfigError(`${where} must match ${SCRIPT_TOKEN_RE.source}`);
  }
  return value;
}

function parseHttpsUrl(value: unknown, where = 'interceptor.url'): string {
  if (typeof value !== 'string') throw new ManagedConfigError(`${where} must be a string`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ManagedConfigError(`${where} is not a valid URL`);
  }
  if (url.protocol !== 'https:') throw new ManagedConfigError(`${where} must be https`);
  return url.toString();
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ManagedConfigError(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}
