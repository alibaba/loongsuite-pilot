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
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve paths
const PROJECT_ROOT = path.resolve(__dirname, '..');
const HOOKS_SOURCE_DIR = path.join(PROJECT_ROOT, 'assets', 'hooks');
const SKILLS_SOURCE_DIR = path.join(PROJECT_ROOT, 'assets', 'skills');
const PLUGINS_SOURCE_DIR = path.join(PROJECT_ROOT, 'assets', 'plugins');
const LOONGSUITE_PILOT_DIR = process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(process.env.HOME || '', '.loongsuite-pilot');
const HOOKS_TARGET_DIR = path.join(LOONGSUITE_PILOT_DIR, 'hooks');
const SKILLS_TARGET_DIR = path.join(LOONGSUITE_PILOT_DIR, 'skills');
const PLUGINS_TARGET_DIR = path.join(LOONGSUITE_PILOT_DIR, 'plugins');

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

  // Recursively copy all hook scripts (including subdirectories: shared/, claude-code/, codex/)
  let copySuccess = false;
  try {
    fs.cpSync(HOOKS_SOURCE_DIR, HOOKS_TARGET_DIR, { recursive: true });
    copySuccess = true;
  } catch (error) {
    console.error('[loongsuite-pilot] Recursive copy failed, falling back to file-by-file:', error.message);
    // Fallback: walk source dir and copy files individually
    try {
      function copyRecursive(src, dest) {
        ensureDir(dest);
        for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
          const srcPath = path.join(src, entry.name);
          const destPath = path.join(dest, entry.name);
          if (entry.isDirectory()) {
            copyRecursive(srcPath, destPath);
          } else {
            installHookFile(srcPath, destPath);
          }
        }
      }
      copyRecursive(HOOKS_SOURCE_DIR, HOOKS_TARGET_DIR);
      copySuccess = true;
    } catch (fallbackError) {
      console.error('[loongsuite-pilot] File-by-file fallback also failed:', fallbackError.message);
    }
  }

  if (!copySuccess) {
    console.error('[loongsuite-pilot] Hook scripts installation failed. Hooks may not work correctly.');
    return;
  }

  // Ensure .sh files have execute permission (cpSync preserves mode on most OS, belt-and-suspenders)
  let installedCount = 0;
  function fixPermissions(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        fixPermissions(fullPath);
      } else if (entry.name.endsWith('.sh') || entry.name.endsWith('.ps1')) {
        try { fs.chmodSync(fullPath, 0o755); } catch {}
        installedCount++;
      } else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.py')) {
        installedCount++;
      }
    }
  }
  fixPermissions(HOOKS_TARGET_DIR);

  console.log(`[loongsuite-pilot] Installed ${installedCount} hook script(s) to ${HOOKS_TARGET_DIR}`);

  if (fs.existsSync(SKILLS_SOURCE_DIR)) {
    try {
      fs.cpSync(SKILLS_SOURCE_DIR, SKILLS_TARGET_DIR, { recursive: true });
      console.log(`[loongsuite-pilot] Installed skill docs to ${SKILLS_TARGET_DIR}`);
    } catch (error) {
      console.error('[loongsuite-pilot] Failed to install skill docs:', error.message);
    }
  }

  if (fs.existsSync(PLUGINS_SOURCE_DIR)) {
    try {
      fs.cpSync(PLUGINS_SOURCE_DIR, PLUGINS_TARGET_DIR, { recursive: true });
      let pluginCount = 0;
      function countPlugins(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            countPlugins(path.join(dir, entry.name));
          } else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.js')) {
            pluginCount++;
          }
        }
      }
      countPlugins(PLUGINS_TARGET_DIR);
      console.log(`[loongsuite-pilot] Installed ${pluginCount} plugin(s) to ${PLUGINS_TARGET_DIR}`);
    } catch (error) {
      console.error('[loongsuite-pilot] Failed to install plugins:', error.message);
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
}

// Run config migrations (if any exist in this package variant)
const migrationScript = path.join(__dirname, 'migrate-internal-config.js');
if (fs.existsSync(migrationScript)) {
  try {
    const { migrate } = await import(pathToFileURL(migrationScript).href);
    const dataDir = process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(process.env.HOME || '', '.loongsuite-pilot');
    const configPath = path.join(dataDir, 'config.json');
    if (migrate(configPath)) {
      console.log('[loongsuite-pilot] Config migrated: internal SLS moved to configs/inner/data_config.json');
    }
  } catch (err) {
    console.error('[loongsuite-pilot] Config migration failed (non-fatal):', err.message);
  }
}
