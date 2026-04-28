#!/usr/bin/env node
/**
 * Post-install script for ai-agent-collector
 * 
 * This script runs automatically after `npm install` and:
 * 1. Copies hook scripts from assets/hooks/ to ~/.ai-agent-collector/hooks/
 * 2. Sets permissions with least-privilege defaults
 * 
 * This mirrors the approach used by @ali/ai-agent-collector
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve paths
const PROJECT_ROOT = path.resolve(__dirname, '..');
const HOOKS_SOURCE_DIR = path.join(PROJECT_ROOT, 'assets', 'hooks');
const AI_AGENT_COLLECTOR_DIR = process.env.AAC_DATA_DIR || path.join(process.env.HOME || '', '.ai-agent-collector');
const HOOKS_TARGET_DIR = path.join(AI_AGENT_COLLECTOR_DIR, 'hooks');

/**
 * Ensure directory exists
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Copy file and make it executable
 */
function getFileMode(filePath) {
  // Shell/PowerShell scripts need execute bit; processors do not.
  if (filePath.endsWith('.sh') || filePath.endsWith('.ps1')) return 0o755;
  return 0o644;
}

function installHookFile(sourcePath, targetPath) {
  const content = fs.readFileSync(sourcePath);
  fs.writeFileSync(targetPath, content, { mode: getFileMode(sourcePath) });
}

/**
 * Main installation logic
 */
function main() {
  console.log('[ai-agent-collector] Installing hook scripts...');

  // Check if source directory exists
  if (!fs.existsSync(HOOKS_SOURCE_DIR)) {
    console.log('[ai-agent-collector] No hook scripts found, skipping.');
    return;
  }

  // Create target directory
  ensureDir(HOOKS_TARGET_DIR);

  // Copy all hook scripts
  const hookFiles = fs.readdirSync(HOOKS_SOURCE_DIR).filter(
    f => f.endsWith('.sh') || f.endsWith('.ps1') || f.endsWith('.py') || f.endsWith('.mjs')
  );
  
  if (hookFiles.length === 0) {
    console.log('[ai-agent-collector] No hook scripts to install.');
    return;
  }

  let installedCount = 0;
  for (const hookFile of hookFiles) {
    const sourcePath = path.join(HOOKS_SOURCE_DIR, hookFile);
    const targetPath = path.join(HOOKS_TARGET_DIR, hookFile);

    try {
      installHookFile(sourcePath, targetPath);
      console.log(`  ✓ Installed: ${hookFile}`);
      installedCount++;
    } catch (error) {
      console.error(`  ✗ Failed to install ${hookFile}:`, error.message);
    }
  }

  console.log(`[ai-agent-collector] Installed ${installedCount} hook script(s) to ${HOOKS_TARGET_DIR}`);
}

// Run installation
try {
  main();
} catch (error) {
  console.error('[ai-agent-collector] Post-install failed:', error.message);
  // Don't fail the npm install, just warn
  process.exit(0);
}
