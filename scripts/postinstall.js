#!/usr/bin/env node
/**
 * Post-install script for loongsuite-pilot
 *
 * This script runs automatically after `npm install` and:
 * 1. Copies hook scripts from assets/hooks/ to ~/.loongsuite-pilot/hooks/
 * 2. Copies skill docs and agent plugins into the same data dir
 * 3. Sets permissions with least-privilege defaults
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
const LOONGSUITE_PILOT_DIR = process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(process.env.HOME || process.env.USERPROFILE || '', '.loongsuite-pilot');
const HOOKS_TARGET_DIR = path.join(LOONGSUITE_PILOT_DIR, 'hooks');
const SKILLS_TARGET_DIR = path.join(LOONGSUITE_PILOT_DIR, 'skills');
const PLUGINS_TARGET_DIR = path.join(LOONGSUITE_PILOT_DIR, 'plugins');
const SHARED_ROOT_RUNTIME = process.platform !== 'win32' && process.getuid?.() === 0
  && /^(1|true|yes|on)$/i.test(String(process.env.LOONGSUITE_PILOT_ROOT_TRIGGER || '').trim());

/**
 * Ensure directory exists
 */
function ensureDir(dirPath, sharedRuntime = false) {
  const created = !fs.existsSync(dirPath);
  if (created) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  if (sharedRuntime && SHARED_ROOT_RUNTIME) {
    const info = fs.lstatSync(dirPath);
    // Only touch Pilot runtime directories, not the data root, configs or logs.
    if (info.isDirectory() && (created || info.uid === 0)) {
      fs.chmodSync(dirPath, (info.mode & 0o7777) | 0o055);
    }
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

let assetWriteSequence = 0;

function installHookFile(sourcePath, targetPath, sharedRuntime = false) {
  const content = fs.readFileSync(sourcePath);
  let previousMode;
  try {
    const previous = fs.lstatSync(targetPath);
    if (previous.isFile()) previousMode = previous.mode & 0o777;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // Agents may load these files while Pilot upgrades. A failed or partial
  // write must leave the previously installed runtime usable.
  const stagedPath = `${targetPath}.${process.pid}.${assetWriteSequence++}.tmp`;
  try {
    fs.writeFileSync(stagedPath, content, { mode: getFileMode(sourcePath), flag: 'wx' });
    if (SHARED_ROOT_RUNTIME && sharedRuntime) {
      fs.chmodSync(stagedPath, getFileMode(sourcePath));
    } else if (process.platform !== 'win32' && previousMode !== undefined) {
      // Rename replaces the inode; preserve the old access mode on upgrade.
      fs.chmodSync(stagedPath, previousMode);
    }
    fs.renameSync(stagedPath, targetPath);
  } finally {
    try { fs.unlinkSync(stagedPath); } catch {}
  }
}

/**
 * Recursively copy a directory tree using only mkdir + read/write.
 *
 * `fs.cpSync` is deliberately NOT used here. On Windows the bundled Node kills
 * the whole process on the very first recursive call: exit 0xC0000409
 * (STATUS_STACK_BUFFER_OVERRUN), no JS exception, no stderr, and nothing copied
 * -- `fs.cpSync` moved to a C++ std::filesystem implementation in Node 22.9,
 * and that implementation fail-fasts on this platform. Reproduced with the
 * bundled node v22.22.2 and with v22.22.3, on a two-file ASCII tree, so it is
 * not about path length or non-ASCII paths; mkdirSync + copyFileSync copy the
 * same tree fine, and the async `fs.cp` is unaffected.
 *
 * Because the process DIES rather than throwing, a try/catch around cpSync
 * never runs. That is what made this silent for so long: the first copy killed
 * the script, so everything after it -- skill docs, agent plugins, the legacy
 * intercept stub, the config migration -- was skipped without a single line of
 * output, while the installer went on to print "Hook scripts deployed". The
 * missing plugins tree in turn failed every dsh deployment with "plugin file
 * not found or unreadable", once per collection cycle, forever.
 */
function copyTree(sourceDir, targetDir, sharedRuntime = false) {
  ensureDir(targetDir, sharedRuntime);
  let count = 0;
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    // AppleDouble sidecars ride along when the release tarball is built on a
    // Mac. They are never runnable content and only confuse anything that
    // enumerates these directories, so drop them at the copy boundary.
    if (entry.name.startsWith('._') || entry.name === '.DS_Store') continue;
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      count += copyTree(sourcePath, targetPath, sharedRuntime);
    } else {
      installHookFile(sourcePath, targetPath, sharedRuntime);
      count++;
    }
  }
  return count;
}

/**
 * Delete AppleDouble sidecars already sitting in a target tree.
 *
 * copyTree refuses to bring new ones in, but every install made before the
 * packaging fix (COPYFILE_DISABLE around the release tar) left ~75 of them in
 * the hooks tree, and they are not self-clearing: nothing else ever
 * deletes a file the current package no longer ships. They matter because these
 * directories are enumerated -- hook-manager and the plugin strategies walk them
 * looking for runnable files.
 *
 * Best-effort by design: an unremovable stray is not worth failing an install.
 */
function pruneSidecars(targetDir) {
  let removed = 0;
  let entries;
  try {
    entries = fs.readdirSync(targetDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      removed += pruneSidecars(full);
    } else if (entry.name.startsWith('._') || entry.name === '.DS_Store') {
      try {
        fs.unlinkSync(full);
        removed++;
      } catch {
        // leave it; it is inert either way
      }
    }
  }
  return removed;
}

/**
 * Main installation logic
 */
/**
 * Copy one asset tree, reporting rather than throwing.
 *
 * Every tree gets its own guard so that one unwritable target can no longer
 * take the remaining trees down with it -- the old shape ran hooks, skills and
 * plugins as one straight line, so whatever failed first ended the script.
 * Returns true when the tree is installed or genuinely absent from the package.
 */
function installTree(label, sourceDir, targetDir, sharedRuntime = false) {
  if (!fs.existsSync(sourceDir)) {
    console.log(`[loongsuite-pilot] No ${label} found in package, skipping.`);
    return true;
  }
  try {
    const count = copyTree(sourceDir, targetDir, sharedRuntime);
    const pruned = pruneSidecars(targetDir);
    const suffix = pruned > 0 ? ` (removed ${pruned} stale sidecar file(s))` : '';
    console.log(`[loongsuite-pilot] Installed ${count} ${label} to ${targetDir}${suffix}`);
    return true;
  } catch (error) {
    console.error(`[loongsuite-pilot] Failed to install ${label}:`, error.message);
    return false;
  }
}

function main() {
  console.log('[loongsuite-pilot] Installing hook scripts...');

  let failed = 0;

  if (!installTree('hook script(s)', HOOKS_SOURCE_DIR, HOOKS_TARGET_DIR, true)) failed++;

  // Ensure .sh/.ps1 files have execute permission (belt-and-suspenders: copyTree
  // already sets the mode at write time, but a pre-existing file keeps its own).
  if (fs.existsSync(HOOKS_TARGET_DIR)) {
    try {
      const fixPermissions = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) fixPermissions(fullPath);
          else if (entry.name.endsWith('.sh') || entry.name.endsWith('.ps1')) {
            try { fs.chmodSync(fullPath, 0o755); } catch {}
          }
        }
      };
      fixPermissions(HOOKS_TARGET_DIR);
    } catch (error) {
      console.error('[loongsuite-pilot] Failed to set hook permissions:', error.message);
    }
  }

  if (!installTree('skill doc(s)', SKILLS_SOURCE_DIR, SKILLS_TARGET_DIR)) failed++;
  if (!installTree('plugin(s)', PLUGINS_SOURCE_DIR, PLUGINS_TARGET_DIR, true)) failed++;

  // Place a no-op intercept.js stub at the legacy path.
  // Old otel-claude-hook versions injected NODE_OPTIONS="--require intercept.js" into shell profiles.
  // After upgrade the real file is removed, but already-open terminals still have NODE_OPTIONS set,
  // causing MODULE_NOT_FOUND errors. This stub prevents that.
  const legacyIntercept = path.join(process.env.HOME || process.env.USERPROFILE || '', '.cache', 'opentelemetry.instrumentation.claude', 'intercept.js');
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

  // Reported, not signalled through the exit code on purpose. This same script is
  // package.json's `postinstall`, so on the installers' `npm install` fallback path
  // a non-zero exit here surfaces as "Dependencies installation failed" and aborts
  // the whole install (the .ps1 installers exit 1 on a non-zero npm exit). A missing
  // skills or plugins tree is not worth failing an install over; the installers
  // check the process exit code to catch a hard crash, and this line to explain a
  // partial result.
  if (failed > 0) {
    console.error(`[loongsuite-pilot] Post-install completed with ${failed} failed asset tree(s).`);
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
    const dataDir = process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(process.env.HOME || process.env.USERPROFILE || '', '.loongsuite-pilot');
    const configPath = path.join(dataDir, 'config.json');
    if (migrate(configPath)) {
      console.log('[loongsuite-pilot] Config migrated: internal SLS moved to configs/inner/data_config.json');
    }
  } catch (err) {
    console.error('[loongsuite-pilot] Config migration failed (non-fatal):', err.message);
  }
}
