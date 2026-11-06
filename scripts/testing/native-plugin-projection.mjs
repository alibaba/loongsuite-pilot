// Optional host-test boundary: the deployed plugin is JS, Collector output is Rust.
import {spawnSync} from 'node:child_process';
import {isAbsolute} from 'node:path';
export async function convertEventLogToReadableSpans(records) {
  const binary=process.env.PILOT_NATIVE_PROJECTION_BRIDGE;
  if (!binary || !isAbsolute(binary)) {
    throw new Error('Build cargo build --example host_plugin_projection_bridge, then set PILOT_NATIVE_PROJECTION_BRIDGE to its absolute executable path.');
  }
  const result=spawnSync(binary,[],{input:JSON.stringify(records),encoding:'utf8',timeout:15000,maxBuffer:8*1024*1024,windowsHide:true});
  if (result.error || result.status!==0) throw new Error(`Native plugin projection failed: ${result.error?.message ?? result.status}; ${result.stderr}`);
  return JSON.parse(result.stdout);
}
