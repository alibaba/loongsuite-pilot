// Run with the deployed Node runtime when comparing memory use. Optionally pass
// an unmodified qoder-hook-processor.mjs as argv[2] to compare the same fixtures.
// --large-only checks rejection of 128 MiB / 512 MiB / 1 GiB sparse files. It
// deliberately does not run the unbounded baseline against those large inputs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const current = fileURLToPath(new URL('../../assets/hooks/qoder-hook-processor.mjs', import.meta.url));
const largeOnly = process.argv.includes('--large-only');
const modules = [...(!largeOnly && process.argv[2] ? [['baseline', path.resolve(process.argv[2])]] : []), ['fixed', current]];
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-memory-perf-'));
try {
  for (const sizeMiB of (largeOnly ? [128, 512, 1024] : [8, 32, 64])) {
    const transcript = path.join(temporary, `${sizeMiB}.jsonl`);
    const row = JSON.stringify({ type: 'assistant', message: {
      role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(4000) }],
    } }) + '\n';
    // Stay just UNDER the specified budget, so 32 MiB exercises the parser
    // instead of accidentally exercising rejection due to one extra row.
    const rowCount = Math.floor(sizeMiB * 1024 * 1024 / Buffer.byteLength(row));
    const fd = fs.openSync(transcript, 'w');
    try {
      if (largeOnly) fs.ftruncateSync(fd, sizeMiB * 1024 * 1024);
      else for (let i = 0; i < rowCount; i++) fs.writeSync(fd, row);
    }
    finally { fs.closeSync(fd); }
    for (const [variant, modulePath] of modules) {
      const script = `import {readTranscriptSnapshot} from ${JSON.stringify(pathToFileURL(modulePath).href)};
        global.gc();
        const before = process.memoryUsage().rss;
        const start = performance.now();
        const snapshot = readTranscriptSnapshot(process.argv[1], {includeContentHash: true});
        console.log(JSON.stringify({node:process.version,reason:snapshot.reason,rows:snapshot.lineCount,
          rssBeforeMiB:before/1048576,rssAfterMiB:process.memoryUsage().rss/1048576,
          elapsedMs:performance.now()-start}));`;
      const result = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=512',
        '--input-type=module', '-e', script, transcript], { encoding: 'utf8', timeout: 15_000 });
      if (result.status !== 0) throw new Error(`${variant}: ${result.error || result.stderr}`);
      console.log(JSON.stringify({ variant, fixture: largeOnly ? 'sparse-size-check' : 'jsonl',
        fileMiB: fs.statSync(transcript).size / 1048576,
        ...JSON.parse(result.stdout) }));
    }
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
