import * as path from 'node:path';
import { AgentDefLoader } from './deployment/agent-def-loader.js';
import { detectAgent, commandExists } from './deployment/detect-utils.js';
import { resolveHome, directoryExists, fileExists } from './utils/fs-utils.js';

// This file is always bundled as CJS (build.mjs), so __dirname is guaranteed.
const __probe_dirname = __dirname;

interface ProbeResult {
  id: string;
  displayName: string;
  detected: boolean;
  reason: string;
}

async function findDetectionReason(detection: { paths: string[]; commands: string[] }): Promise<string> {
  for (const p of detection.paths) {
    const resolved = resolveHome(p);
    if (await directoryExists(resolved) || await fileExists(resolved)) {
      return p;
    }
  }
  for (const cmd of detection.commands) {
    try {
      if (await commandExists(cmd)) return `command: ${cmd}`;
    } catch { /* ignore */ }
  }
  return '';
}

async function main(): Promise<void> {
  const builtinDir = path.resolve(__probe_dirname, '..', 'agents.d');
  const pilotDir = path.resolve(__probe_dirname, '..');
  const dataDir = resolveHome('~/.loongsuite-pilot');

  const loader = new AgentDefLoader({
    builtinDir,
    localDir: path.join(dataDir, 'agents.d.local'),
    pilotDir,
    dataDir,
  });

  const defs = await loader.load();
  const results: ProbeResult[] = [];

  for (const def of defs) {
    if (def.detection.paths.length === 0 && def.detection.commands.length === 0) {
      continue;
    }
    const detected = await detectAgent(def.detection);
    const reason = detected ? await findDetectionReason(def.detection) : '';
    results.push({
      id: def.id,
      displayName: def.displayName,
      detected,
      reason,
    });
  }

  process.stdout.write(JSON.stringify(results));
}

main().catch(() => {
  process.stdout.write('[]');
  process.exit(0);
});
