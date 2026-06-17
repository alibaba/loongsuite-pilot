#!/usr/bin/env node

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

const mode = args.mode || process.env.LOONGSUITE_RELEASE_MODE || 'internal';
const suffix = mode.toUpperCase();
const webhook =
  args.webhook ||
  process.env[`DINGTALK_RELEASE_WEBHOOK_${suffix}`] ||
  process.env.DINGTALK_RELEASE_WEBHOOK;
const secret =
  args.secret ||
  process.env[`DINGTALK_RELEASE_SECRET_${suffix}`] ||
  process.env.DINGTALK_RELEASE_SECRET;

if (!webhook) {
  console.warn(`[dingtalk] skip: DINGTALK_RELEASE_WEBHOOK_${suffix} or DINGTALK_RELEASE_WEBHOOK is not set`);
  process.exit(0);
}

const title = args.title || `Loongsuite Pilot ${args.status || '发布通知'}`;
const text = buildMarkdown({
  title,
  action: args.action,
  mode,
  version: args.version,
  prevVersion: args.prevVersion,
  rollout: args.rollout,
  branch: args.branch,
  tag: args.tag,
  cr: args.cr,
  operator: args.operator || getOperator(),
  next: args.next,
  status: args.status || '成功',
  message: args.message,
});

const url = new URL(webhook);
if (secret) {
  const timestamp = Date.now().toString();
  const stringToSign = `${timestamp}\n${secret}`;
  const sign = crypto.createHmac('sha256', secret).update(stringToSign).digest('base64');
  url.searchParams.set('timestamp', timestamp);
  url.searchParams.set('sign', sign);
}

const response = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    msgtype: 'markdown',
    markdown: {
      title,
      text,
    },
  }),
});

const body = await response.text();
let payload;
try {
  payload = JSON.parse(body);
} catch {
  payload = { errmsg: body };
}

if (!response.ok || payload.errcode !== 0) {
  console.warn(`[dingtalk] send failed: HTTP ${response.status} ${body}`);
  process.exit(0);
}

console.log('[dingtalk] notification sent');

function buildMarkdown(fields) {
  const lines = [`### ${fields.title}`, ''];
  lines.push(`- 状态：${fields.status}`);
  addLine(lines, '动作', fields.action);
  addLine(lines, '目标', formatMode(fields.mode));
  addLine(lines, '版本', fields.version);
  addLine(lines, '上一版本', fields.prevVersion);
  addLine(lines, '灰度比例', fields.rollout);
  addLine(lines, '分支', fields.branch);
  addLine(lines, 'Tag', fields.tag);
  addLine(lines, 'CR', fields.cr);
  addLine(lines, '操作人', fields.operator);
  addLine(lines, '下一步', fields.next);

  if (fields.message) {
    lines.push('', `> ${fields.message}`);
  }

  return lines.join('\n');
}

function addLine(lines, label, value) {
  if (value === undefined || value === null || value === '') {
    return;
  }
  lines.push(`- ${label}：${value}`);
}

function formatMode(value) {
  if (value === 'external') {
    return 'external（商业版）';
  }
  return 'internal（集团版）';
}

function getOperator() {
  const gitName = readGitConfig('user.name');
  const gitEmail = readGitConfig('user.email');
  if (gitName && gitEmail) {
    return `${gitName} <${gitEmail}>`;
  }
  return gitName || gitEmail || process.env.GIT_AUTHOR_NAME || process.env.USER || process.env.LOGNAME || 'unknown';
}

function readGitConfig(key) {
  try {
    return execFileSync('git', ['config', '--get', key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      parsed[toCamel(arg.slice(2, eq))] = arg.slice(eq + 1);
      continue;
    }
    const key = toCamel(arg.slice(2));
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    i += 1;
  }
  return parsed;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function printHelp() {
  console.log(`Usage:
  node scripts/notify-dingtalk-release.mjs --mode internal --action "canary release" --version v1.2.3

Environment:
  DINGTALK_RELEASE_WEBHOOK_INTERNAL / DINGTALK_RELEASE_SECRET_INTERNAL
  DINGTALK_RELEASE_WEBHOOK_EXTERNAL / DINGTALK_RELEASE_SECRET_EXTERNAL
  DINGTALK_RELEASE_WEBHOOK / DINGTALK_RELEASE_SECRET
`);
}
