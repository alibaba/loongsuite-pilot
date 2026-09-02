import * as path from 'node:path';
import { PROPRIETARY_BUILD } from './core/build-constants.js';
import { AgentDefLoader } from './deployment/agent-def-loader.js';
import { probeAgentDefinitions } from './deployment/cli-probe-detector.js';
import { resolveHome } from './utils/fs-utils.js';

// This file is always bundled as CJS (build.mjs), so __dirname is guaranteed.
const __probe_dirname = __dirname;

async function main(): Promise<void> {
  // The installed service wrappers use this private probe to expose commands
  // that only make sense for the open-source distribution. Keep the edition
  // decision tied to the existing compile-time build flag instead of mutable
  // user configuration such as autoUpdate.packageUrl.
  if (process.argv.includes('--build-edition')) {
    process.stdout.write(PROPRIETARY_BUILD ? 'proprietary' : 'opensource');
    return;
  }

  const builtinDir = path.resolve(__probe_dirname, '..', 'agents.d');
  const pilotDir = path.resolve(__probe_dirname, '..');
  const dataDir = resolveHome('~/.loongsuite-pilot');

  const loader = new AgentDefLoader({
    builtinDir,
    localDir: path.join(dataDir, 'agents.d.local'),
    pilotDir,
    dataDir,
  });

  // --list: enumerate the same set of agents as a normal probe, but skip the
  // on-disk machine detection. Used by the installer when the user explicitly
  // picks agents (--agents), where the detection result is irrelevant — we only
  // need each id to write the enable/disable gate. Agents with no detection
  // rules (e.g. internal *-local-runtime runtimes) stay excluded here, exactly
  // as a normal probe excludes them — they are not user-selectable.
  const listOnly = process.argv.includes('--list');

  const defs = await loader.load();
  const results = await probeAgentDefinitions(defs, { listOnly });

  process.stdout.write(JSON.stringify(results));
}

main().catch(() => {
  process.stdout.write('[]');
  process.exit(0);
});
