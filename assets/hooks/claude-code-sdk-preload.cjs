'use strict';

// A shared Node/Bun preload may require this file in every process in a
// container. Only a Bun-compiled Claude CLI needs the request enrichment;
// Claude Agent SDK starts that CLI directly, bypassing the shell wrapper.
// This module is deliberately synchronous and best-effort: it must never
// prevent the Agent from starting when Pilot's files or configuration fail.
(function loadClaudeEnrichment() {
  try {
    if (!process.versions || !process.versions.bun) return;

    const path = require('node:path');
    const executable = path.basename(process.execPath || '').toLowerCase();
    const argv0 = path.basename(process.argv0 || '').toLowerCase();
    if (!['claude', 'claude.exe'].includes(executable)
        && !['claude', 'claude.exe'].includes(argv0)) return;

    const env = process.env;
    // A caller which already configures the standard preload must keep using
    // its own path. This conservative check avoids installing it twice.
    if (String(env.BUN_OPTIONS || '').includes('claude-code-fetch-intercept.mjs')) return;
    if (env.LOONGSUITE_PILOT_ENABLED === 'false' || env.LOONGSUITE_PILOT_ENABLED === '0') return;

    const requested = String(env.LOONGSUITE_PILOT_AGENTS || '').trim();
    if (requested && requested !== 'null'
        && !requested.split(',').map((id) => id.trim()).includes('claude-code')) return;

    const fs = require('node:fs');
    const home = env.HOME || require('node:os').homedir();
    const expandHome = (p) => p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
    const configPath = expandHome(String(env.AGENT_DATA_COLLECTION_CONFIG || '').trim()
      || path.join(home, '.loongsuite-pilot', 'config.json'));
    const readOptional = (file) => {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      } catch (err) {
        if (err && err.code === 'ENOENT') return {};
        throw err; // Inaccessible or invalid config: skip enrichment safely.
      }
    };
    const config = readOptional(configPath);
    if ((!env.LOONGSUITE_PILOT_ENABLED || !env.LOONGSUITE_PILOT_ENABLED.trim())
        && config.enabled === false) return;
    if (config.agents && config.agents['claude-code']?.enabled === false) return;

    const dataDir = expandHome(env.LOONGSUITE_PILOT_DATA_DIR || config.dataDir
      || path.join(home, '.loongsuite-pilot'));
    const control = readOptional(path.join(dataDir, 'agent-control.json'));
    if (control.tools && control.tools['claude-code'] === 'off') return;

    require(path.join(__dirname, 'claude-code-fetch-intercept.mjs'));
  } catch (_) {
    // Enrichment is optional; the business process must still start normally.
  }
})();
