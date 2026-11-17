import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { PipelineConfig } from '../../types.js';
import { MulticaPipeline } from './multica-pipeline.js';
import { errorKind } from './http.js';
import { writeJsonFile } from '../../../utils/fs-utils.js';
import type { MulticaActivationResult } from './activation.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const configPath = option('--config');
  if (!configPath) throw new Error('Usage: multica-collector --config pipeline.json [--state-dir /state] [--activation-state-file /logs/activation.json] [--once]');
  const raw = await readFile(configPath, 'utf8');
  if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('Config too large');
  const config = JSON.parse(raw) as PipelineConfig;
  const stateDir = path.resolve(option('--state-dir') ?? './multica-state');
  const activationFile = option('--activation-state-file');
  let activation: Pick<MulticaActivationResult, 'enabled' | 'mode' | 'stopped'> = {enabled: false, mode: 'off', stopped: false};
  let closing = false;
  let pendingWrite = Promise.resolve();
  const publishActivation = (): Promise<void> => {
    if (!activationFile) return Promise.resolve();
    // Serialize lease updates and read the latest state when writing, so a
    // delayed heartbeat cannot overwrite a newer stop notification.
    pendingWrite = pendingWrite.then(() => writeJsonFile(activationFile, {
      ...activation, enabled: !closing && activation.enabled,
      expiresAt: !closing && activation.enabled ? Date.now() + 30_000 : 0,
    })).catch(() => { process.stderr.write('Multica activation state unavailable; log bridge will stay disabled\n'); });
    return pendingWrite;
  };
  await publishActivation();
  const pipeline = new MulticaPipeline({config, stateDir, failedLogDir: path.join(stateDir, 'failed'), dataDir: stateDir}, undefined,
    async state => { activation = state; await publishActivation(); });
  if (args.includes('--once')) {
    const summary = await pipeline.collectOnce();
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    if (summary.failedSources) process.exitCode = 1;
    closing = true;
    await publishActivation();
    return;
  }
  // A disabled/stopped collector must remain idle in a restartPolicy=Always
  // sidecar. Exiting would reset detection failures and restart collection.
  const keepAlive = setInterval(() => { if (activation.enabled && !closing) void publishActivation(); }, 10_000);
  let finish!: () => void;
  const shutdown = new Promise<void>(resolve => { finish = resolve; });
  const stop = () => {
    closing = true;
    void publishActivation();
    void pipeline.stop().then(finish, error => {
      process.stderr.write(`Multica collector shutdown failed: ${errorKind(error)}\n`);
      process.exitCode = 1;
      finish();
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    await pipeline.start();
    await shutdown;
  } finally {
    closing = true;
    clearInterval(keepAlive);
    await publishActivation();
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}

void main().catch(error => {
  // Never print request bodies, credentials, or configured source URLs on errors.
  process.stderr.write(`Multica collector failed: ${errorKind(error)}\n`);
  process.exitCode = 1;
});
