#!/usr/bin/env node
/**
 * Build the macOS status bar app (Swift).
 *
 * Usage:
 *   node scripts/build-status-bar-app.mjs [--arch arm64|x64|universal]
 *
 * Requires macOS with Xcode or matching Command Line Tools.
 * Best-effort: exits 0 even on build failure (logs warning).
 */
import { execSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const sourceDir = path.join(repoRoot, 'app', 'macos-status-bar', 'Sources', 'LoongSuitePilotMenuBarApp');
const binaryName = 'LoongSuitePilotMenuBarApp';

if (process.platform !== 'darwin') {
  console.log('[status-bar-app] skipped: not macOS');
  process.exit(0);
}

if (!existsSync(path.join(sourceDir, 'AppDelegate.swift'))) {
  console.log('[status-bar-app] skipped: source not found');
  process.exit(0);
}

const requestedArch = process.argv.includes('--arch')
  ? process.argv[process.argv.indexOf('--arch') + 1]
  : process.arch === 'arm64' ? 'arm64' : 'x64';

const archTarget = requestedArch === 'x64' ? 'x86_64-apple-macosx13.0' : 'arm64-apple-macosx13.0';
const outDirName = `darwin-${requestedArch}`;
const outDir = path.join(repoRoot, 'app', 'macos-status-bar', 'bin', outDirName);
const outPath = path.join(outDir, binaryName);

const sdkPath = '/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk';
const xcodeSdkPath = '/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk';

const resolvedSdk = existsSync(xcodeSdkPath) ? xcodeSdkPath : sdkPath;

const xcodeSwift = '/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc';
const swiftc = existsSync(xcodeSwift) ? xcodeSwift : 'swiftc';

const sourceFiles = path.join(sourceDir, '*.swift');

console.log(`[status-bar-app] building ${outDirName} with ${swiftc === 'swiftc' ? 'system swiftc' : 'Xcode swiftc'}`);

try {
  mkdirSync(outDir, { recursive: true });

  const cmd = [
    swiftc,
    '-O',
    '-target', archTarget,
    '-sdk', resolvedSdk,
    '-o', outPath,
    '-framework', 'AppKit',
    '-framework', 'SwiftUI',
    '-framework', 'Charts',
    '-framework', 'Combine',
  ];

  // swiftc doesn't support glob, list files manually
  const { readdirSync } = await import('node:fs');
  const swiftFiles = readdirSync(sourceDir)
    .filter(f => f.endsWith('.swift'))
    .map(f => path.join(sourceDir, f));

  const fullCmd = [...cmd.slice(1), ...swiftFiles];

  execFileSync(cmd[0], fullCmd, {
    stdio: 'pipe',
    timeout: 180_000,
    env: {
      ...process.env,
      ...(existsSync('/Applications/Xcode.app/Contents/Developer')
        ? { DEVELOPER_DIR: '/Applications/Xcode.app/Contents/Developer' }
        : {}),
    },
  });

  console.log(`[status-bar-app] built: ${outPath}`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  const stderr = err.stderr?.toString?.()?.slice(0, 500) ?? '';
  console.warn(`[status-bar-app] build failed (non-fatal): ${message}`);
  if (stderr) console.warn(`[status-bar-app] stderr: ${stderr}`);
  process.exit(0);
}
