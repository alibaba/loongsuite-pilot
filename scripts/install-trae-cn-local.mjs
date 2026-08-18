#!/usr/bin/env node
// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal local TRAE-CN probe installer for OTLP viewer validation.
 *
 * It follows the repo's normal local flow:
 *   1. npm run build
 *   2. npm run postinstall  (copies assets/hooks to ~/.loongsuite-pilot/hooks)
 *   3. merge ~/.loongsuite-pilot/config.json with local OTLP trace output
 *   4. merge ~/.trae-cn/hooks.json with the TRAE-CN hook entries
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const args = process.argv.slice(2);

function has(flag) { return args.includes(flag); }
function val(flag, fallback) {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : fallback;
}
function homePath(p) {
  if (!p || p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}
function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return fallback;
  return JSON.parse(raw);
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
function run(cmd, cmdArgs, opts = {}) {
  console.log(`$ ${cmd} ${cmdArgs.join(' ')}`);
  const r = spawnSync(cmd, cmdArgs, { cwd: repoRoot, stdio: 'inherit', env: process.env, ...opts });
  if (r.status !== 0) process.exit(r.status || 1);
}

const dataDir = homePath(val('--data-dir', process.env.LOONGSUITE_PILOT_DATA_DIR || '~/.loongsuite-pilot'));
const otlpEndpoint = val('--otlp-endpoint', process.env.LOONGSUITE_PILOT_OTLP_ENDPOINT || 'http://127.0.0.1:4318');
const serviceName = val('--service-name', 'loongsuite-pilot-trae-cn-local');
const skipBuild = has('--skip-build');
const skipPostinstall = has('--skip-postinstall');
const skipHooks = has('--skip-hooks');
const keepLogExport = has('--keep-log-export');

if (has('--help')) {
  console.log(`Usage: node scripts/install-trae-cn-local.mjs [options]\n\nOptions:\n  --otlp-endpoint <url>     Default: http://127.0.0.1:4318\n  --service-name <name>     Default: loongsuite-pilot-trae-cn-local\n  --data-dir <dir>          Default: ~/.loongsuite-pilot\n  --skip-build              Do not run npm run build\n  --skip-postinstall        Do not run npm run postinstall\n  --skip-hooks              Do not edit ~/.trae-cn/hooks.json\n  --keep-log-export         Keep existing SLS/log export settings\n`);
  process.exit(0);
}

if (!skipBuild) run('npm', ['run', 'build']);
if (!skipPostinstall) run('npm', ['run', 'postinstall'], { env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: dataDir } });

const configPath = path.join(dataDir, 'config.json');
const config = readJson(configPath, {});
config.enabled = true;
config.dataDir = dataDir;
config.collectTrace = true;
if (!keepLogExport) {
  config.collectLog = false;
  config.sls = { enabled: false };
} else {
  config.collectLog = config.collectLog ?? true;
}
config.serviceName = serviceName;
config.otlpTrace = {
  ...(config.otlpTrace || {}),
  endpoint: otlpEndpoint,
  compression: 'none',
  captureMessageContent: true,
  debug: true,
  // 空闲超时只作安全兜底：TRAE 一轮的真正终止信号是 Notification(idle_prompt)。
  // 必须远大于 trae-cn 输入的 30s 轮询间隔 + 轮内最长间隔（长 RunCommand/WebSearch 可达 30s+），
  // 否则第一次轮询只读到 prompt+首个工具就会被提前 flush，后续工具因 flushedTurnKeys 被丢弃而截断整轮 trace。
  turnIdleTimeoutMs: 300000,
  resourceAttributes: {
    ...((config.otlpTrace || {}).resourceAttributes || {}),
    'deployment.environment': 'local',
  },
};
writeJson(configPath, config);
console.log(`[local-trae-cn] wrote ${configPath}`);

if (!skipHooks) {
  const hooksPath = path.join(os.homedir(), '.trae-cn', 'hooks.json');
  const hooksCfg = readJson(hooksPath, {});
  hooksCfg.version = hooksCfg.version ?? 1;
  hooksCfg.hooks = hooksCfg.hooks && typeof hooksCfg.hooks === 'object' ? hooksCfg.hooks : {};
  const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification'];
  const hookScript = path.join(dataDir, 'hooks', 'trae-cn-loongsuite-pilot-hook.sh');
  if (!fs.existsSync(hookScript)) {
    console.warn(`[local-trae-cn] warning: hook script not found yet: ${hookScript}`);
    console.warn('[local-trae-cn] run npm run postinstall or rerun without --skip-postinstall.');
  }
  for (const event of events) {
    const command = `${hookScript} ${event}`;
    const arr = Array.isArray(hooksCfg.hooks[event]) ? hooksCfg.hooks[event] : [];
    const cleaned = arr.filter(entry => {
      const text = JSON.stringify(entry || {});
      return !text.includes('trae-cn-loongsuite-pilot-hook');
    });
    cleaned.push({
      matcher: '*',
      hooks: [{ type: 'command', command }],
    });
    hooksCfg.hooks[event] = cleaned;
  }
  writeJson(hooksPath, hooksCfg);
  console.log(`[local-trae-cn] wrote ${hooksPath}`);
}

console.log('\nNext steps:');
console.log('1. Start local OTEL UI:');
console.log('   npm run otel:local');
console.log('2. Start Pilot collector:');
console.log(`   LOONGSUITE_PILOT_OTLP_LOCAL_ONLY=true LOONGSUITE_PILOT_OTLP_ENDPOINT=${otlpEndpoint} npm start`);
console.log('3. Restart TRAE CN window, then send one message with a tool call.');
console.log(`4. Open ${otlpEndpoint.replace(/\/$/, '')}/`);
