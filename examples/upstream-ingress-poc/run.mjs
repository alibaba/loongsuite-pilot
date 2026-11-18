import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';

const directory = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = path.join(directory, '.build');
await mkdir(outputDirectory, { recursive: true });
const outputFile = path.join(outputDirectory, 'pocs.mjs');
await build({ entryPoints: [path.join(directory, 'pocs.ts')], outfile: outputFile, bundle: true,
  platform: 'node', format: 'esm', packages: 'external',
  define: { __INTERNAL_BUILD__: 'false', __PROPRIETARY_BUILD__: 'false' } });
const child = spawn(process.execPath, [outputFile], { stdio: 'inherit', env: { ...process.env, POC_SOURCE_DIR: directory } });
const result = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve({ code, signal }));
});
await rm(outputDirectory, { recursive: true, force: true });
if (result.code !== 0) process.exitCode = result.code || 1;
