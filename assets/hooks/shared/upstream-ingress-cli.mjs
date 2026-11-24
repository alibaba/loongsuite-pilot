import { bindUpstreamTurn } from './upstream-ingress.mjs';

let input = '';
let completed = false;
const timer = setTimeout(() => finish({ recorded: false, reason: 'timeout' }), 2000);
function finish(result) {
  if (completed) return;
  completed = true;
  clearTimeout(timer);
  process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(0));
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  if (Buffer.byteLength(input) > 8192) finish({ recorded: false, reason: 'invalid' });
});
process.stdin.on('error', () => finish({ recorded: false, reason: 'io' }));
process.stdin.on('end', () => {
  try { finish(bindUpstreamTurn(JSON.parse(input))); }
  catch { finish({ recorded: false, reason: 'invalid' }); }
});
