import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

describe('OpenClaw acceptance build context defense', () => {
  it('protects both classic/root and Dockerfile-specific contexts', () => {
    for (const file of ['.dockerignore', 'scripts/e2e/openclaw-compat.Dockerfile.dockerignore']) {
      const patterns = readFileSync(file, 'utf8').split('\n');
      for (const pattern of ['**/.env', '**/.env.*', '**/provider.json', '**/cms.json', '**/.npmrc', '**/*.key']) {
        expect(patterns, file).toContain(pattern);
      }
    }
    const dockerfile = readFileSync('scripts/e2e/openclaw-compat.Dockerfile', 'utf8');
    expect(dockerfile).not.toMatch(/^COPY\s+\.\s+\./m);
  });
});
