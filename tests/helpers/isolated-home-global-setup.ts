import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { agentHomeEnvironment } from './isolated-agent-home.js';

/** Set native HOME before worker threads and subprocesses are created. */
export default function setup(): () => void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-test-suite-home-'));
  const env = agentHomeEnvironment(home);
  const previous = Object.keys(env).map(key => [key, process.env[key]] as const);
  Object.assign(process.env, env);
  return () => {
    try { fs.rmSync(home, { recursive: true, force: true }); }
    finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
}
