import { readFileSync } from 'node:fs';
import { createLogger } from '../utils/logger.js';
import { readInstalledVersion } from '../utils/fs-utils.js';
import { DaemonClient } from './cli/daemon-client.js';
import { runHook } from './cli/hook.js';
import { defaultPilotDataDir, interceptorRuntimePath } from './paths.js';

const logger = createLogger('InterceptorCli');

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === '--version' || command === 'version') {
    process.stdout.write(`${readInstalledVersion(defaultPilotDataDir())}\n`);
    return;
  }
  if (command === 'status') {
    await runStatus();
    return;
  }
  if (command === 'hook') {
    const code = await runHook(rest, {
      readStdin: readStdin,
      writeStdout: (text) => process.stdout.write(text),
      log: (message, extra) => logger.warn(message, extra),
    });
    process.exitCode = code;
    return;
  }
  process.stderr.write(
    'usage: interceptor-cli hook [--event <name>] --agent <name>\n'
    + '       interceptor-cli status\n'
    + '       interceptor-cli version\n',
  );
}

async function runStatus(): Promise<void> {
  const runtimePath = interceptorRuntimePath();
  try {
    const raw = readFileSync(runtimePath, 'utf8');
    const runtime = JSON.parse(raw.replace(/^\uFEFF/, '')) as { daemon_port?: number };
    if (!runtime.daemon_port) {
      process.stdout.write('interceptor: runtime present but port missing\n');
      return;
    }
    const health = await new DaemonClient(runtime.daemon_port).health();
    process.stdout.write(`interceptor: ok pid=${health.pid} port=${health.daemon_port} version=${health.version}\n`);
  } catch (err) {
    process.stdout.write(`interceptor: not running (${err instanceof Error ? err.message : String(err)})\n`);
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

void main().catch((err) => {
  logger.warn('interceptor cli failed, fail-open', { error: String(err) });
  process.exitCode = 0;
});
