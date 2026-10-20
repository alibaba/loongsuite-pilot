import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../../..');
const AGENT_DEF = path.join(ROOT, 'agents.d', 'claude-code.json');
const SH_ENTRY = path.join(ROOT, 'assets', 'hooks', 'claude-code-loongsuite-pilot-hook.sh');
const PS1_ENTRY = path.join(ROOT, 'assets', 'hooks', 'claude-code-loongsuite-pilot-hook.ps1');

// agents.d declares events in PascalCase; the entry scripts route kebab-case
// subcommands (eventSubcommand: "kebab-case"). Both entry allowlists must cover
// every declared event, or a hook (e.g. StopFailure) is silently dropped on one
// platform and its spans never reach JSONL.
function toKebab(event) {
  return event.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

describe('claude-code hook entry allowlists cover agents.d events', () => {
  const def = JSON.parse(fs.readFileSync(AGENT_DEF, 'utf-8'));
  const subcommands = def.hook.events.map(toKebab);

  test('agents.d maps StopFailure to stop-failure subcommand', () => {
    expect(def.hook.eventSubcommand).toBe('kebab-case');
    expect(subcommands).toContain('stop-failure');
  });

  test('.sh allowlist covers every declared event', () => {
    const sh = fs.readFileSync(SH_ENTRY, 'utf-8');
    for (const sub of subcommands) {
      expect(sh, `sh entry missing subcommand ${sub}`).toContain(sub);
    }
  });

  test('.ps1 allowlist covers every declared event', () => {
    const ps1 = fs.readFileSync(PS1_ENTRY, 'utf-8');
    const match = ps1.match(/-notin @\(([^)]*)\)/);
    expect(match, 'ps1 -notin allowlist not found').toBeTruthy();
    const allowed = match[1]
      .split(',')
      .map((s) => s.trim().replace(/^"|"$/g, ''));
    for (const sub of subcommands) {
      expect(allowed, `ps1 entry missing subcommand ${sub}`).toContain(sub);
    }
  });
});
