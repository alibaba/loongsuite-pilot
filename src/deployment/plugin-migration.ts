/**
 * plugin-migration.ts — 清理老 Claude plugin 残留。
 *
 * 在 DeploymentManager.deployAll() 入口最先跑(Phase 0)。Q15 决策:每次启动扫描,
 * 不写 marker 文件;若 cache 目录不存在则快速跳过(纳秒级 fs.exists 调用)。
 *
 * 完全 fail-open:任何一步失败 logger.warn + 继续,不阻断 deployAll。
 *
 * Claude 清理(R10):
 *   1. ~/.cache/opentelemetry.instrumentation.claude/ 存在 → 进入清理
 *   2. parse ~/.claude/settings.json,删 hooks.* 中含 "otel-claude-hook" 或
 *      "/.cache/opentelemetry.instrumentation.claude" 的 command
 *   3. rm ~/.claude/otel-config.json
 *   4. 扫 ~/.bashrc / ~/.zshrc / ~/.bash_profile,删 # BEGIN otel-claude-hook ... # END 段
 *   5. rm -rf ~/.cache/opentelemetry.instrumentation.claude/
 *
 * Codex 的旧 OTel 资产不在这里迁移。该路径和 `otel-codex-hook`
 * 同时被其他产品使用，不能仅凭通用名称推断它们属于 Pilot。
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('PluginMigration');

export interface PluginMigrationStepReport {
  stage: string;
  ok: boolean;
  detail?: string;
}

export interface PluginMigrationReport {
  claude: { migrated: boolean; steps: PluginMigrationStepReport[] };
  codex: { migrated: boolean; steps: PluginMigrationStepReport[] };
}

function home(): string { return process.env.HOME || os.homedir(); }

function safeExistsSync(p: string): boolean {
  try { return fs.existsSync(p); } catch { return false; }
}

async function safeRmRf(p: string, steps: PluginMigrationStepReport[], stage: string): Promise<void> {
  try {
    if (safeExistsSync(p)) {
      await fsp.rm(p, { recursive: true, force: true });
      steps.push({ stage, ok: true, detail: `removed ${p}` });
    } else {
      steps.push({ stage, ok: true, detail: `not present ${p}` });
    }
  } catch (err) {
    steps.push({ stage, ok: false, detail: `${p}: ${(err as Error).message}` });
    logger.warn('rm -rf failed', { path: p, error: String(err) });
  }
}

async function safeUnlink(p: string, steps: PluginMigrationStepReport[], stage: string): Promise<void> {
  try {
    if (safeExistsSync(p)) {
      await fsp.unlink(p);
      steps.push({ stage, ok: true, detail: `removed ${p}` });
    } else {
      steps.push({ stage, ok: true, detail: `not present ${p}` });
    }
  } catch (err) {
    steps.push({ stage, ok: false, detail: `${p}: ${(err as Error).message}` });
    logger.warn('unlink failed', { path: p, error: String(err) });
  }
}

// ─── Claude 清理 ───

function isClaudeOldPath(s: string): boolean {
  return typeof s === 'string'
    && (s.includes('otel-claude-hook') || s.includes('.cache/opentelemetry.instrumentation.claude'));
}

async function cleanClaudeSettings(steps: PluginMigrationStepReport[]): Promise<void> {
  const settingsPath = path.join(home(), '.claude', 'settings.json');
  if (!safeExistsSync(settingsPath)) {
    steps.push({ stage: 'claude_settings', ok: true, detail: 'settings.json not present' });
    return;
  }
  try {
    const raw = await fsp.readFile(settingsPath, 'utf-8');
    let data: any;
    try { data = JSON.parse(raw); } catch {
      steps.push({ stage: 'claude_settings', ok: false, detail: 'settings.json invalid JSON' });
      return;
    }
    if (!data || !data.hooks || typeof data.hooks !== 'object') {
      steps.push({ stage: 'claude_settings', ok: true, detail: 'no hooks section' });
      return;
    }
    let removed = 0;
    for (const event of Object.keys(data.hooks)) {
      const arr = data.hooks[event];
      if (!Array.isArray(arr)) continue;
      const filtered = arr
        .map((entry: any) => {
          // nested: {hooks: [{command}]}
          if (Array.isArray(entry?.hooks)) {
            const subFiltered = entry.hooks.filter((h: any) => !isClaudeOldPath(h?.command));
            if (subFiltered.length === entry.hooks.length) return entry;
            removed += entry.hooks.length - subFiltered.length;
            return subFiltered.length === 0 ? null : { ...entry, hooks: subFiltered };
          }
          // flat: {command}
          if (isClaudeOldPath(entry?.command)) {
            removed++;
            return null;
          }
          return entry;
        })
        .filter((e: any) => e !== null);
      if (filtered.length === 0) {
        delete data.hooks[event];
      } else {
        data.hooks[event] = filtered;
      }
    }
    if (removed === 0) {
      steps.push({ stage: 'claude_settings', ok: true, detail: 'no otel-claude-hook entries' });
      return;
    }
    await fsp.writeFile(settingsPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    steps.push({ stage: 'claude_settings', ok: true, detail: `removed ${removed} entries` });
  } catch (err) {
    steps.push({ stage: 'claude_settings', ok: false, detail: (err as Error).message });
    logger.warn('claude settings cleanup failed', { error: String(err) });
  }
}

async function cleanClaudeShellAliases(steps: PluginMigrationStepReport[]): Promise<void> {
  const targets = ['.bashrc', '.zshrc', '.bash_profile'];
  const re = /\n?# BEGIN otel-claude-hook\n[\s\S]*?# END otel-claude-hook\n?/g;
  for (const f of targets) {
    const p = path.join(home(), f);
    if (!safeExistsSync(p)) continue;
    try {
      const content = await fsp.readFile(p, 'utf-8');
      if (!content.includes('# BEGIN otel-claude-hook')) continue;
      const replaced = content.replace(re, '\n');
      await fsp.writeFile(p, replaced, 'utf-8');
      steps.push({ stage: 'claude_alias', ok: true, detail: `cleaned ${p}` });
    } catch (err) {
      steps.push({ stage: 'claude_alias', ok: false, detail: `${p}: ${(err as Error).message}` });
      logger.warn('claude alias cleanup failed', { path: p, error: String(err) });
    }
  }
}

async function migrateClaude(): Promise<{ migrated: boolean; steps: PluginMigrationStepReport[] }> {
  const cacheDir = path.join(home(), '.cache', 'opentelemetry.instrumentation.claude');
  const steps: PluginMigrationStepReport[] = [];
  if (!safeExistsSync(cacheDir)) {
    return { migrated: false, steps: [{ stage: 'detect', ok: true, detail: 'no claude plugin residue' }] };
  }
  logger.info('cleaning up old claude plugin residue');
  await cleanClaudeSettings(steps);
  await safeUnlink(path.join(home(), '.claude', 'otel-config.json'), steps, 'claude_otel_config');
  await cleanClaudeShellAliases(steps);
  await safeRmRf(cacheDir, steps, 'claude_cache_dir');
  return { migrated: true, steps };
}

async function migrateCodex(): Promise<{ migrated: boolean; steps: PluginMigrationStepReport[] }> {
  return {
    migrated: false,
    steps: [{
      stage: 'detect',
      ok: true,
      detail: 'skipped: legacy Codex OTel assets are not exclusively owned by Pilot',
    }],
  };
}

// ─── public API ───

export async function runPluginMigration(): Promise<PluginMigrationReport> {
  const claude = await migrateClaude();
  const codex = await migrateCodex();
  if (claude.migrated || codex.migrated) {
    logger.info('plugin migration complete', {
      claude_migrated: claude.migrated,
      codex_migrated: codex.migrated,
    });
  }
  return { claude, codex };
}
