import { InvocationAttributeStore, InvocationAttributeStoreError } from '../../assets/hooks/shared/invocation-attribute-store.mjs';

// Standalone helper: does not start or import the Collector.
const [command, flag, root] = process.argv.slice(2);
let store: InvocationAttributeStore | undefined;
try {
  if (command === 'capabilities' && flag === undefined) {
    console.log(JSON.stringify({ version: 1, selectors: ['turn','message'], operations: ['register','put','bind'], parentContext: false }));
  } else {
    if (!['register', 'put', 'bind'].includes(command) || (flag !== undefined && (flag !== '--root' || !root)) || process.argv.length>5) {
      throw new InvocationAttributeStoreError('invalid_arguments');
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const value of process.stdin) {
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > 20 * 1024) throw new InvocationAttributeStoreError('input_too_large');
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    store = new InvocationAttributeStore({ root });
    const status = command === 'register' ? store.register(input) : command === 'put' ? store.put(input) : store.bind(input);
    console.log(JSON.stringify({ status }));
    if (status === 'sealed') process.exitCode = 1;
  }
} catch (error) {
  console.error('loongsuite-pilot invocation-attributes: '+(error instanceof InvocationAttributeStoreError ? error.code : 'invalid_or_unavailable'));
  process.exitCode = 1;
} finally { store?.close(); }
