// Usage: node tests/performance/hook-history-replay.perf.mjs --baseline /path/to/pr590-checkout
// Synthetic source only. No Agent, network output, or installed Pilot data is used.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const baselineIndex = process.argv.indexOf('--baseline');
const sources = baselineIndex >= 0
  ? [['baseline', path.resolve(process.argv[baselineIndex + 1])], ['limited', root]]
  : [['limited', root]];
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-replay-perf-'));
const results = [];
try {
  for (const [label, source] of sources) {
    for (const [prefix, adapter, exported] of [
      ['pi-coding-agent', 'pi-coding-agent-log/pi-coding-agent-log-input.ts', 'PiCodingAgentLogInput'],
      ['opencode', 'opencode-log/opencode-log-input.ts', 'OpenCodeLogInput'],
    ]) {
      const file = path.join(temp, `${label}-${prefix}.cjs`);
      const contents = `
        import { ${exported} as Input } from ${JSON.stringify(path.join(source, 'src/inputs', adapter))};
        import { StateStore } from ${JSON.stringify(path.join(source, 'src/checkpoints/state-store.ts'))};
        import { getTodayDateString } from ${JSON.stringify(path.join(source, 'src/utils/fs-utils.ts'))};
        import * as fs from 'node:fs/promises';
        import * as path from 'node:path';
        import * as os from 'node:os';
        (async () => {
          const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-replay-source-'));
          try {
            const count = 20000;
            const rows = Array.from({ length: count }, (_, id) => JSON.stringify({
              'event.id': String(id), 'event.name': 'tool.call', 'gen_ai.agent.type': ${JSON.stringify(prefix)},
              'gen_ai.session.id': 'synthetic-session', 'gen_ai.turn.id': 'synthetic-turn',
              'gen_ai.tool.call.arguments': { test: 'x'.repeat(200) },
            }) + '\\n');
            const name = ${JSON.stringify(prefix)} + '-' + getTodayDateString() + '.jsonl';
            const text = rows.join('');
            await fs.writeFile(path.join(dir, name), text);
            const store = new StateStore(path.join(dir, 'state.json'));
            const input = new Input({ stateStore: store, logDir: dir });
            store.set(input.id, { lastFile: name, lastOffset: 0 });
            let tick = performance.now(), maxStall = 0;
            const timer = setInterval(() => {
              const now = performance.now(); maxStall = Math.max(maxStall, now - tick); tick = now;
            }, 1);
            const cpu = process.cpuUsage(); const started = performance.now();
            const entries = await input.collect();
            const elapsedMs = performance.now() - started;
            const used = process.cpuUsage(cpu);
            maxStall = Math.max(maxStall, performance.now() - tick);
            clearInterval(timer);
            console.log(JSON.stringify({ label: ${JSON.stringify(label)}, agent: ${JSON.stringify(prefix)},
              sourceBytes: Buffer.byteLength(text), sourceRecords: count, emittedRecords: entries.length,
              committedBytes: store.get(input.id).lastOffset, cpuMs: (used.user + used.system) / 1000,
              elapsedMs, maxEventLoopStallMs: maxStall }));
          } finally { await fs.rm(dir, { recursive: true, force: true }); }
        })().catch(error => { console.error(error); process.exitCode = 1; });
      `;
      await build({ stdin: { contents, resolveDir: source, loader: 'ts' }, outfile: file,
        bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' });
      const output = execFileSync(process.execPath, [file], { encoding: 'utf8', timeout: 60000,
        env: { ...process.env, NODE_PATH: path.join(root, 'node_modules'), LOG_LEVEL: 'fatal',
          LOONGSUITE_PILOT_HOOK_HISTORY_BYTES_PER_MINUTE: '4194304' } });
      results.push(JSON.parse(output.trim().split('\n').at(-1)));
    }
  }
  console.log(JSON.stringify(results, null, 2));
} finally { await fs.rm(temp, { recursive: true, force: true }); }
