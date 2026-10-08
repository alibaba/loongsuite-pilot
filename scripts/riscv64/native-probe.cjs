// Probe the npm addons, not Node's built-in sqlite implementation.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');

async function main() {
  const [source, artifacts] = process.argv.slice(2);
  if (!source || !artifacts) throw new Error('Usage: native-probe.cjs SOURCE ARTIFACTS');
  assert.equal(process.arch, 'riscv64');
  const load = createRequire(path.join(path.resolve(source), 'package.json'));
  const results = {};
  for (const name of ['sqlite3', 'zstd-napi']) {
    const started = Date.now();
    try {
      const mod = load(name);
      let detail;
      if (name === 'sqlite3') {
        detail = await new Promise((resolve, reject) => {
          const db = new mod.Database(':memory:', err => {
            if (err) return reject(err);
            db.get('SELECT 42 AS answer, sqlite_version() AS sqlite_version', (queryError, row) => {
              db.close(closeError => queryError || closeError ? reject(queryError || closeError) : resolve(row));
            });
          });
        });
        assert.equal(detail.answer, 42);
      } else {
        const input = Buffer.from('pilot-riscv64-zstd-原生往返\n'.repeat(100));
        const compressed = mod.compress(input);
        const output = mod.decompress(compressed);
        assert.deepEqual(output, input);
        detail = { input_bytes: input.length, compressed_bytes: compressed.length, roundtrip: true };
      }
      const addonPaths = Object.keys(require.cache).filter(p => p.endsWith('.node') && p.includes(`/node_modules/${name}/`));
      assert.ok(addonPaths.length, `${name}: expected a loaded .node addon`);
      const elfs = addonPaths.map(addon => ({ path: addon,
        description: execFileSync('file', [addon], { encoding: 'utf8', timeout: 15000 }).trim() }));
      for (const elf of elfs) assert.match(elf.description, /RISC-V/);
      results[name] = { status: 'passed', version: load(`${name}/package.json`).version,
        detail, elfs, elapsed_ms: Date.now() - started };
    } catch (err) {
      results[name] = { status: 'failed', code: err.code, message: err.message, stack: err.stack,
        elapsed_ms: Date.now() - started };
    }
  }
  const timings = fs.readFileSync(path.join(artifacts, 'build-times.tsv'), 'utf8').trim().split('\n').filter(Boolean)
    .map(line => { const [module, exit, seconds] = line.split('\t');
      return { module, exit_code: Number(exit), seconds: Number(seconds), exceeds_updater_120s: Number(seconds) > 120 }; });
  const evidence = { recorded_at: new Date().toISOString(), arch: process.arch, node: process.version,
    napi: process.versions.napi, abi: process.versions.modules, builds: timings, modules: results };
  fs.writeFileSync(path.join(artifacts, 'native-probe.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
  process.exitCode = Object.values(results).every(r => r.status === 'passed') && timings.every(t => t.exit_code === 0) ? 0 : 1;
}
main().catch(err => { console.error(err); process.exitCode = 1; });
