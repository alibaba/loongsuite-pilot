import { cleanupCodexHooks } from '../deployment/codex-hook-cleanup.js';

const [hooksPath, configPath] = process.argv.slice(2);
try {
  if (!hooksPath || !configPath) throw new Error('Expected hooks.json and config.toml paths');
  cleanupCodexHooks(hooksPath, configPath);
} catch {
  // Parser/filesystem errors can contain configuration contents. Do not log them.
  console.error('Codex hook/trust cleanup failed; installation assets preserved. Check config files and retry.');
  process.exitCode = 1;
}
