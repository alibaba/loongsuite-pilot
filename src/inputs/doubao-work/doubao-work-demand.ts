import { doubaoDigest } from './doubao-work-log.js';

/** Native assignment prefixes may contain execution-mode context which the
 * client removes from its user trajectory row. Normalize only complete leading
 * blocks for matching; never rewrite the captured messages or exported IDs. */
function withoutNativeReminderPrefix(value: string): string {
  const open = '<system-reminder>', close = '</system-reminder>';
  let cursor = 0, removed = false;
  while (cursor < value.length) {
    let start = cursor;
    while (start < value.length && /\s/.test(value[start])) start++;
    if (!value.startsWith(open, start)) break;
    const body = start + open.length, end = value.indexOf(close, body);
    const nested = value.indexOf(open, body);
    if (end < 0 || (nested >= 0 && nested < end)) return value;
    const next = end + close.length;
    if (next < value.length && !/\s/.test(value[next])) return value;
    cursor = next; removed = true;
  }
  return removed ? value.slice(cursor) : value;
}

export function nativeReminderOnly(value: string): boolean {
  const remaining = withoutNativeReminderPrefix(value);
  return remaining !== value && remaining.trim().length === 0;
}

/** Match only observed Skill URI/local-path variants and native reminder
 * prefixes. Labels, instructions, spaces and exported source text are kept.
 * Blank prefix separators are absent in some native user rows. */
export function nativeDemandKey(value: string): string {
  value = withoutNativeReminderPrefix(value).replace(/^(?:\r?\n)+/, '');
  const parts: (string | { skill: string; label: string })[] = [];
  const links = /\[([^\]\r\n]*)\]\((?:<([^<>\r\n]+)>|([^\s()<>]+))\)/g;
  let cursor = 0;
  for (const match of value.matchAll(links)) {
    const target = match[2] ?? match[3];
    const uri = /^skill:\/\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})(?:\?[^\s<>]*)?$/.exec(target);
    const local = /^(?:[a-zA-Z]:\/|\/)[^\r\n<>]*\/\.doubao(?:work)?\/agent_mode\/workspace\/\.skills\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})\/SKILL\.md$/.exec(target.replace(/\\/g, '/'));
    const skill = uri?.[1] ?? local?.[1];
    if (!skill) continue;
    parts.push(value.slice(cursor, match.index), { skill, label: match[1] });
    cursor = match.index! + match[0].length;
  }
  parts.push(value.slice(cursor));
  return JSON.stringify(parts);
}

/** Reader-private lookup key, never an exported identity or message body. */
export function nativeDemandFingerprint(value: string): string { return doubaoDigest(nativeDemandKey(value)); }
