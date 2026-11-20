import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.resolve(__dirname, '../../../assets/hooks/qodercli-token-intercept.mjs');
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe.skipIf(NODE_MAJOR < 20)('qodercli token intercept preload', () => {
  it('loads through Node --import and records the newest distinct usage', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-qoder-preload-'));
    tempDirs.push(home);
    const script = `
      const first = {
        id: 'chatcmpl-node-1',
        model: 'ultimate',
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 10,
          total_tokens: 110,
          prompt_tokens_details: { cached_tokens: 80 },
          completion_tokens_details: { reasoning_tokens: 3 }
        }
      };
      JSON.parse(JSON.stringify(first));
      JSON.parse(JSON.stringify(first));
      first.usage.prompt_tokens = 120;
      first.usage.total_tokens = 130;
      JSON.parse(JSON.stringify(first));
      JSON.stringify({ messages: [{ role: 'system', content: 'x'.repeat(120) }] });
    `;

    const result = spawnSync(process.execPath, ['--import', PRELOAD, '--input-type=module', '-e', script], {
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(result.status, result.stderr).toBe(0);

    const file = path.join(home, '.loongsuite-pilot', 'logs', 'qodercli-intercept.jsonl');
    const records = (await fs.readFile(file, 'utf-8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    const tokens = records.filter(record => record.type === 'token');
    expect(tokens).toHaveLength(2);
    expect(tokens[1]).toMatchObject({
      id: 'chatcmpl-node-1',
      prompt_tokens: 120,
      completion_tokens: 10,
      cached_tokens: 80,
      reasoning_tokens: 3,
      total_tokens: 130,
    });
    expect(records.filter(record => record.type === 'system_prompt')).toHaveLength(1);
  });
});
