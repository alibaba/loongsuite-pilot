#!/usr/bin/env node
/**
 * Post-install script for loongsuite-pilot
 * 
 * This script runs automatically after `npm install` and:
 * 1. Copies hook scripts from assets/hooks/ to ~/.loongsuite-pilot/hooks/
 * 2. Sets permissions with least-privilege defaults
 * 
 * This mirrors the approach used by @ali/loongsuite-pilot
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve paths
const PROJECT_ROOT = path.resolve(__dirname, '..');
const HOOKS_SOURCE_DIR = path.join(PROJECT_ROOT, 'assets', 'hooks');
const SKILLS_SOURCE_DIR = path.join(PROJECT_ROOT, 'assets', 'skills');
const LOONGSUITE_PILOT_DIR = process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(process.env.HOME || '', '.loongsuite-pilot');
const HOOKS_TARGET_DIR = path.join(LOONGSUITE_PILOT_DIR, 'hooks');
const SKILLS_TARGET_DIR = path.join(LOONGSUITE_PILOT_DIR, 'skills');

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
  console.log('[loongsuite-pilot] Installing hook scripts...');

  // Check if source directory exists
  if (!fs.existsSync(HOOKS_SOURCE_DIR)) {
    console.log('[loongsuite-pilot] No hook scripts found, skipping.');
    return;
  }

  // Create target directory
  ensureDir(HOOKS_TARGET_DIR);

  // Copy all hook scripts
  const hookFiles = fs.readdirSync(HOOKS_SOURCE_DIR).filter(
    f => f.endsWith('.sh') || f.endsWith('.ps1') || f.endsWith('.py') || f.endsWith('.mjs')
  );
  
  if (hookFiles.length === 0) {
    console.log('[loongsuite-pilot] No hook scripts to install.');
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

  console.log(`[loongsuite-pilot] Installed ${installedCount} hook script(s) to ${HOOKS_TARGET_DIR}`);

  if (fs.existsSync(SKILLS_SOURCE_DIR)) {
    try {
      fs.cpSync(SKILLS_SOURCE_DIR, SKILLS_TARGET_DIR, { recursive: true });
      console.log(`[loongsuite-pilot] Installed skill docs to ${SKILLS_TARGET_DIR}`);
    } catch (error) {
      console.error('[loongsuite-pilot] Failed to install skill docs:', error.message);
    }
  }

  // Place a no-op intercept.js stub at the legacy path.
  // Old otel-claude-hook versions injected NODE_OPTIONS="--require intercept.js" into shell profiles.
  // After upgrade the real file is removed, but already-open terminals still have NODE_OPTIONS set,
  // causing MODULE_NOT_FOUND errors. This stub prevents that.
  const legacyIntercept = path.join(process.env.HOME || '', '.cache', 'opentelemetry.instrumentation.claude', 'intercept.js');
  if (!fs.existsSync(legacyIntercept)) {
    try {
      ensureDir(path.dirname(legacyIntercept));
      fs.writeFileSync(legacyIntercept, '/* no-op stub for legacy NODE_OPTIONS --require */\n');
      console.log(`  ✓ Created legacy intercept.js stub`);
    } catch (error) {
      // Non-critical, don't fail
      console.error(`  ✗ Failed to create intercept.js stub:`, error.message);
    }
  }
}

// Run installation
try {
  main();
} catch (error) {
  console.error('[loongsuite-pilot] Post-install failed:', error.message);
  // Don't fail the npm install, just warn
  process.exit(0);
}
