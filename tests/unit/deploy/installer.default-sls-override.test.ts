/**
 * Static analysis of installer scripts: verifies the `--default-sls-override`
 * flag wiring exists in both installer scripts per
 * openspec/changes/add-sls-dual-write/specs/sls-installer-flags/spec.md.
 *
 * We do not exec the scripts (they require a network/Node setup); we assert
 * that the parser/validation/write_config snippets are present.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const installers = [
  'deploy/loongsuite-pilot-installer.sh',
  'deploy/loongsuite-pilot-installer-inner.sh',
];

describe('installer --default-sls-override flag wiring', () => {
  it.each(installers)('%s declares the DEFAULT_SLS_OVERRIDE_RAW variable', async (installer) => {
    const content = await readFile(path.join(rootDir, installer), 'utf8');
    expect(content).toContain('DEFAULT_SLS_OVERRIDE_RAW=""');
  });

  it.each(installers)('%s parses --default-sls-override (space and =)', async (installer) => {
    const content = await readFile(path.join(rootDir, installer), 'utf8');
    expect(content).toContain('--default-sls-override)');
    expect(content).toContain('--default-sls-override=*)');
  });

  it.each(installers)('%s validates the flag against true|false only', async (installer) => {
    const content = await readFile(path.join(rootDir, installer), 'utf8');
    expect(content).toContain('validate_default_sls_override');
    // Validator should accept empty / true / false and reject everything else.
    expect(content).toMatch(/""\|true\|false\)/);
    expect(content).toMatch(/--default-sls-override must be 'true' or 'false'/);
  });

  it.each(installers)('%s warns when flag is supplied without --sls-* args', async (installer) => {
    const content = await readFile(path.join(rootDir, installer), 'utf8');
    expect(content).toMatch(/no effect without --sls-endpoint/);
    expect(content).toContain('DEFAULT_SLS_OVERRIDE_RAW=""');
  });

  it.each(installers)('%s emits destinationOverride based on flag value', async (installer) => {
    const content = await readFile(path.join(rootDir, installer), 'utf8');
    // The write_config Node snippet must inspect the raw flag.
    expect(content).toContain("defaultSlsOverrideRaw === 'false'");
    expect(content).toContain('config.sls.destinationOverride = false;');
    expect(content).toContain('config.sls.destinationOverride = true;');
  });

  it.each(installers)('%s only writes destinationOverride when --sls-* args present', async (installer) => {
    const content = await readFile(path.join(rootDir, installer), 'utf8');
    // The if-guard around the SLS block uses the user flags; without them,
    // the resolver falls back to INTERNAL and no destinationOverride is written.
    expect(content).toContain('if (slsEndpoint || slsProject || slsLogstore)');
  });

  it.each(installers)('%s help comment documents the dual-write flag', async (installer) => {
    const content = await readFile(path.join(rootDir, installer), 'utf8');
    expect(content).toContain('--default-sls-override=false');
  });
});
