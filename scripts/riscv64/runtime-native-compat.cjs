const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const [source, artifacts, ...nodes] = process.argv.slice(2);
if (!source || !artifacts || !nodes.length) throw new Error('Usage: runtime-native-compat.cjs SOURCE ARTIFACTS NODE...');
fs.mkdirSync(artifacts, { recursive: true });
const program = `
const assert=require('node:assert/strict');
const fs=require('node:fs');const crypto=require('node:crypto');
const sqlite=require('sqlite3'); const zstd=require('zstd-napi');
const data=Buffer.from('riscv64 N-API compatibility probe');
assert.deepEqual(zstd.decompress(zstd.compress(data)),data);
const db=new sqlite.Database(':memory:');
db.get('SELECT 42 AS answer',(error,row)=>{
  if(error)throw error;assert.equal(row.answer,42);
  db.close(error=>{
    if(error)throw error;
    console.log(JSON.stringify({node:process.version,arch:process.arch,napi:process.versions.napi,sqlite:row,zstd:'roundtrip passed',
      binaries:Object.keys(require.cache).filter(p=>p.endsWith('.node')).map(p=>({path:p,sha256:crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}))}));
  });
});`;
const results = nodes.map(node => {
  const result = spawnSync(node, ['-e', program], { cwd: source, encoding: 'utf8', timeout: 60000 });
  return { node, exit_code: result.status, signal: result.signal, error: result.error?.message,
    stdout: result.stdout, stderr: result.stderr, passed: result.status === 0 && result.stdout.includes('roundtrip passed') };
});
const evidence = { recorded_at: new Date().toISOString(), results, status: results.every(r=>r.passed)?'passed':'failed' };
fs.writeFileSync(path.join(artifacts,'result.json'),JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence,null,2));
process.exitCode = evidence.status === 'passed' ? 0 : 1;
