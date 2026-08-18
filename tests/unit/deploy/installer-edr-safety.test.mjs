import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const installer = readFileSync(resolve('deploy', 'installer-opensource.sh'), 'utf8');

function functionBody(name, nextMarker) {
  const start = installer.indexOf(`${name}() {`);
  const end = installer.indexOf(nextMarker, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return installer.slice(start, end);
}

describe('public installer keeps agent identity out of Node argv', () => {
  it('streams probe JSON through stdin for counting and selection', () => {
    const probe = functionBody('probe_agents', '# Agent selection:');
    const select = functionBody('select_agents', '# Interactive: prompt for userId');

    expect(probe).toContain(`printf '%s' "$PROBE_RESULT" | "$NODE_BIN" -e`);
    expect(select).toContain(`printf '%s' "$PROBE_RESULT" | "$NODE_BIN" -e`);
    expect(select).toContain("require('fs').readFileSync(0, 'utf8')");
    expect(select).toContain("const input = (process.argv[1] || '')");
    expect(select).toContain('" "$select_input" 2>/dev/null');
    expect(select).not.toContain('JSON.parse(process.argv[1])');
  });

  it('streams probe JSON and keeps only selected-agent values out of argv', () => {
    const writeConfig = functionBody('write_config', '# Common: install/update the loongsuite-pilot service management script');

    expect(writeConfig).toContain(`printf '%s' "$PROBE_RESULT" |`);
    expect(writeConfig).toContain('LP_SELECTED_AGENTS="$SELECTED_AGENTS"');
    expect(writeConfig).toContain("const selectedAgents = process.env.LP_SELECTED_AGENTS || '';");
    expect(writeConfig).toContain("JSON.parse(fs.readFileSync(0, 'utf8') || '[]')");
    expect(writeConfig).not.toContain("const selectedAgents = '${SELECTED_AGENTS}';");
    expect(writeConfig).not.toContain('" -- "$PROBE_RESULT"');
  });
});
