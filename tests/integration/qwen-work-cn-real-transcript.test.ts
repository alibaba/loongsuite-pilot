import { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';

const projectsRoot = path.join(os.homedir(), '.qwenworkcn', 'projects');
const transcript = existsSync(projectsRoot) ? findTranscript(projectsRoot) : undefined;
const outputRoot = transcript ? mkdtempSync(path.join(os.tmpdir(), 'qwen-work-cn-real-')) : undefined;

describe.skipIf(!transcript)('QwenWorkCN real transcript pipeline', () => {
  afterAll(() => {
    if (outputRoot) rmSync(outputRoot, { recursive: true, force: true });
  });

  it('maps a local QwenWorkCN transcript through the dedicated hook entrypoint', () => {
    const hooksDir = path.join(outputRoot!, 'hooks');
    deployQwenHooks(hooksDir);
    const hookEntrypoint = path.join(hooksDir, 'qwenworkcn-loongsuite-pilot-hook.sh');
    const sessionId = path.basename(transcript!, '.jsonl');
    const result = spawnSync('bash', [hookEntrypoint], {
      input: JSON.stringify({
        hook_event_name: 'Stop',
        transcript_path: transcript,
        session_id: sessionId,
        cwd: process.cwd(),
      }),
      encoding: 'utf-8',
      env: { ...process.env, NODE_ENV: 'production', LOONGSUITE_PILOT_DATA_DIR: outputRoot! },
    });
    expect(result.status).toBe(0);
    expect(result.stdout, result.stderr).toContain('{}');

    const historyDir = path.join(outputRoot!, 'logs', 'qwen-work-cn', 'history');
    const historyFile = readdirSync(historyDir).find(name => name.endsWith('.jsonl'));
    expect(historyFile).toBeDefined();
    const events = readFileSync(path.join(historyDir, historyFile!), 'utf-8')
      .trim().split('\n').map(line => JSON.parse(line));
    expect(events.length).toBeGreaterThan(0);
    expect(events.some(event => event['event.name'] === 'llm.request')).toBe(true);
    expect(events.every(event => event['gen_ai.agent.type'] === 'qwen-work-cn')).toBe(true);
    expect(events.every(event => typeof event['event.id'] === 'string')).toBe(true);
    expect(events.every(event => typeof event['gen_ai.session.id'] === 'string')).toBe(true);
  });
});

function findTranscript(root: string): string | undefined {
  const candidates: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) candidates.push(full);
    }
  };
  visit(root);
  return candidates
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
    .find(file => readFileSync(file, 'utf-8').includes('"type":"user"'));
}

function deployQwenHooks(hooksDir: string): void {
  const sourceDir = path.resolve('assets', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  for (const file of [
    'qwenworkcn-loongsuite-pilot-hook.sh',
    'qwen-work-cn-hook-processor.mjs',
    'agent-event-normalizer.mjs',
  ]) {
    copyFileSync(path.join(sourceDir, file), path.join(hooksDir, file));
  }
  cpSync(path.join(sourceDir, 'shared'), path.join(hooksDir, 'shared'), { recursive: true });
}
