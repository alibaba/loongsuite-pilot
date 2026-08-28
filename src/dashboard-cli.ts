import { runDashboardCommand } from './cli/dashboard.js';

// Separate entry point: opening a browser must not load sqlite, start collection,
// deploy hooks, acquire the collector lock, or require installed node_modules.
void runDashboardCommand(process.argv.slice(2)).then(code => {
  process.exitCode = code;
}).catch(() => {
  process.stderr.write('Cannot open Pilot Dashboard. Check the Pilot installation.\n');
  process.exitCode = 1;
});
