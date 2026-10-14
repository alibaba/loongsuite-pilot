#!/usr/bin/env node
// Exercise the builtin and the current production reader in the target guest.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const [source, artifacts, readerFile]=process.argv.slice(2);
assert.ok(source && artifacts && readerFile,'Use PACKAGE_DIR ARTIFACTS COMPILED_READER');
fs.mkdirSync(artifacts,{recursive:true});
const load=createRequire(path.join(path.resolve(source),'package.json'));
assert.deepEqual(Object.keys(load('sqlite3')),[],'The old-updater shim must not expose native SQLite');
const manifest=JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8'));
assert.equal(manifest.dependencies?.['zstd-napi'],undefined);
assert.equal(fs.existsSync(path.join(source,'node_modules/zstd-napi')),false);
const file=path.join(artifacts,'source.db');
const db=new DatabaseSync(file);
db.exec('CREATE TABLE samples(seq INTEGER, id TEXT); BEGIN');
const insert=db.prepare('INSERT INTO samples VALUES (?, ?)');
for(let i=0;i<1501;i++)insert.run(i,`row-${String(i).padStart(4,'0')}`);
db.exec('COMMIT');db.close();
const hash=()=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const before=hash();
const readonly=new DatabaseSync(file,{readOnly:true});
assert.equal(readonly.prepare('SELECT COUNT(*) AS count FROM samples').get().count,1501);
assert.throws(()=>readonly.prepare('INSERT INTO samples VALUES (?, ?)').run(9999,'forbidden'),/readonly/i);
readonly.close();
const reader=await import(pathToFileURL(path.resolve(readerFile)).href);
const rows=await reader.queryReadonly(file,'SELECT seq, id FROM samples WHERE seq = ?',[42]);
assert.equal(rows[0].id,'row-0042');
let yielded=false;setImmediate(()=>{yielded=true;});
const pages=await reader.queryReadonlyPaged(file,
  'SELECT seq, id FROM samples WHERE (? = 0 OR seq > ? OR (seq = ? AND id > ?)) ORDER BY seq, id',
  cursor=>[cursor.continued,cursor.sort,cursor.sort,cursor.id],row=>({sort:row.seq,id:row.id}));
assert.equal(pages.length,1501);assert.equal(new Set(pages.map(row=>row.id)).size,1501);
assert.equal(yielded,true,'Paged SQLite reading did not yield to the event loop');
assert.equal(hash(),before,'Read-only collection modified the source database');
const result={status:'passed',node:process.version,arch:process.arch,builtin:'node:sqlite',
  read_only_write_rejected:true,production_reader_rows:rows.length,paged_rows:pages.length,
  event_loop_yielded:yielded,source_sha256:before,source_unchanged:true,
  reader_sha256:crypto.createHash('sha256').update(fs.readFileSync(readerFile)).digest('hex'),
  legacy_updater_shim:true,zstd_napi_absent:true};
fs.writeFileSync(path.join(artifacts,'result.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
