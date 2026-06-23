import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { DetectionOnlyStrategy } from '../../../src/deployment/detection-only-strategy.js';
import type { AgentDefinition } from '../../../src/types/index.js';

describe('DetectionOnlyStrategy', () => {
  let tmpDir: string;
  let strategy: DetectionOnlyStrategy;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'detect-only-'));
    strategy = new DetectionOnlyStrategy();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function defWithPaths(paths: string[]): AgentDefinition {
    return {
      id: 'test-agent',
      displayName: 'Test',
      deployMode: 'detection-only',
      detection: { paths, commands: [] },
    };
  }

  it('detects when one of the paths exists', async () => {
    const target = path.join(tmpDir, 'plugins', 'qoder-jetbrains');
    await fs.mkdir(target, { recursive: true });

    const result = await strategy.detect(defWithPaths([target]));
    expect(result).toBe(true);
  });

  it('returns false when none of the paths exist', async () => {
    const result = await strategy.detect(defWithPaths([path.join(tmpDir, 'missing')]));
    expect(result).toBe(false);
  });

  it('reports needsDeploy as false (no-op deploy)', async () => {
    const result = await strategy.needsDeploy(defWithPaths([tmpDir]));
    expect(result).toBe(false);
  });

  it('deploy is a successful skipped no-op', async () => {
    const result = await strategy.deploy(defWithPaths([tmpDir]));
    expect(result).toMatchObject({
      success: true,
      agentId: 'test-agent',
      deployMode: 'detection-only',
      skipped: true,
    });
  });

  it('undeploy is a no-op success', async () => {
    const result = await strategy.undeploy(defWithPaths([tmpDir]));
    expect(result).toBe(true);
  });
});
