import * as path from 'node:path';
import { runHookCommand } from './deployment/hook-command.js';

// Standalone entry for container payloads. It must not import the daemon
// graph: that graph loads the SQLite builtin before any command runs. Alarm
// delivery is selected in build.mjs so this file never imports sender.ts
// (that module uses top-level await and pulls the daemon sender).

let argv = process.argv.slice(2);
if (argv[0] === 'hook') argv = argv.slice(1);
const hasPilotDir = argv.some(arg => arg === '--pilot-dir' || arg.startsWith('--pilot-dir='));
if (!hasPilotDir) {
  argv = [...argv, `--pilot-dir=${path.resolve(__dirname, '..')}`];
}

runHookCommand(argv)
  .then(code => {
    process.exit(code);
  })
  .catch(err => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`loongsuite-pilot hook: ${message}\n`);
    process.exit(1);
  });
