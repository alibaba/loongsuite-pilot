import { describe, it, expect } from 'vitest';
import {
  loadAgentMatrix,
  buildEnsureAgentClisScript,
  buildMatrixProbeScript,
  resolveEnsureInstallSh,
} from '../../scripts/e2e/lib/agent-matrix.mjs';

describe('agent-matrix', () => {
  it('loads agents with ensure + probe fields', () => {
    const { agents } = loadAgentMatrix(process.env);
    const codex = agents.find(a => a.binary === 'codex');
    expect(codex?.ensureInstallSh).toContain('@openai/codex');
    expect(codex?.defaultProbeSh).toContain('codex exec');
    const qoder = agents.find(a => a.binary === 'qoder');
    expect(qoder?.ensureInstallSh).toContain('@qoder-ai/qodercli');
    expect(qoder?.defaultProbeSh).toMatch(/qoder|qodercli/);
  });

  it('buildEnsureAgentClisScript mentions npm and matrix binaries', () => {
    const { agents } = loadAgentMatrix(process.env);
    const s = buildEnsureAgentClisScript({ agents }, {});
    expect(s).toContain('npm');
    expect(s).toContain('codex');
    expect(s).toContain('@anthropic-ai/claude-code');
    expect(s).toContain('.cache/loongsuite-e2e-cursor-install');
    expect(s).toContain('cdn.jsdelivr.net/gh/watzon/cursor-linux-installer');
    expect(s).toContain('raw.githubusercontent.com/watzon/cursor-linux-installer');
    expect(s).toContain('_dl install.sh');
    expect(s).toContain('stable --extract');
    expect(s).toContain('cursor-installer --extract --update stable');
    expect(s).toContain('linked ~/.local/bin/cursor');
    expect(s).toContain('compat symlink');
    expect(s).toContain('_legacy_root/cursor');
    expect(s).toContain('@qoder-ai/qodercli');
  });

  it('resolveEnsureInstallSh stages watzon files and runs local install (avoids piped bash GitHub cursor.sh)', () => {
    const { agents } = loadAgentMatrix(process.env);
    const cursor = agents.find(a => a.binary === 'cursor');
    const sh = resolveEnsureInstallSh(cursor, {});
    expect(sh).toContain('loongsuite-e2e-cursor-install');
    expect(sh).toContain('cdn.jsdelivr.net');
    expect(sh).toContain('_dl cursor.sh');
    expect(sh).toContain('bash ./install.sh stable --extract');
  });

  it('buildMatrixProbeScript logs numeric exit status (bash expands ${_st})', () => {
    const { agents } = loadAgentMatrix(process.env);
    const s = buildMatrixProbeScript({ agents });
    expect(s).toMatch(/\$\{_st\}, non-fatal/);
    expect(s).not.toContain('exit \\$_st');
  });

  it('buildMatrixProbeScript runs isolated base64 bash per defaultProbeSh', () => {
    const { agents } = loadAgentMatrix(process.env);
    const s = buildMatrixProbeScript({ agents });
    const n = (s.match(/base64 -d/g) ?? []).length;
    expect(n).toBeGreaterThanOrEqual(4);
    expect(s).toContain('>>> start:');
    expect(s).toContain('<<< end:');
  });
});
