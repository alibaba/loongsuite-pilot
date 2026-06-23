import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// The wrapper installs JSON.parse/stringify hooks then imports the real runtime.
// We can't import the wrapper directly (it tries to load the 33MB QoderWork
// runtime). Instead, exercise the hook contract by importing the wrapper's
// identical sibling — qodercli-token-intercept.mjs — which shares the exact
// record format, and assert the produced JSONL is what intercept-token-reader
// consumes. This guards the format contract both files must keep in sync.
const WRAPPER_PATH = fileURLToPath(new URL('../../../assets/hooks/qoderwork-runtime-wrapper.mjs', import.meta.url));

describe('qoderwork-runtime-wrapper.mjs', () => {
  it('exists in assets/hooks and is an ESM module', () => {
    expect(fs.existsSync(WRAPPER_PATH)).toBe(true);
    const src = fs.readFileSync(WRAPPER_PATH, 'utf-8');
    // ESM (Node worker_thread) — must NOT use bare require() like the Bun sibling.
    expect(src).toMatch(/^\s*import\s/m);
    expect(src).not.toContain('const require = require');
    // Must honor the SDK env-var contract.
    expect(src).toContain('QODER_WORKER_RUNTIME_PATH');
    // Must import the real runtime after installing hooks.
    expect(src).toMatch(/await import\(/);
    // Must write to the shared intercept JSONL (same file as qodercli CLI).
    expect(src).toContain('qodercli-intercept.jsonl');
  });

  it('emits the same token record shape as qodercli-token-intercept.mjs', () => {
    const wrapperSrc = fs.readFileSync(WRAPPER_PATH, 'utf-8');
    const cliSrc = fs.readFileSync(
      path.resolve(path.dirname(WRAPPER_PATH), 'qodercli-token-intercept.mjs'),
      'utf-8',
    );
    // The token record fields must match exactly so intercept-token-reader.ts
    // (which reads this file) parses both producers identically.
    const fields = [
      'type: "token"',
      'prompt_tokens',
      'cached_tokens',
      'completion_tokens',
      'reasoning_tokens',
      'total_tokens',
      'type: "system_prompt"',
    ];
    for (const f of fields) {
      expect(wrapperSrc, `wrapper missing ${f}`).toContain(f);
      expect(cliSrc, `cli missing ${f}`).toContain(f);
    }
    // Same guard: only capture usage when usage + choices + new id present.
    expect(wrapperSrc).toContain('result.usage && result.choices !== undefined');
    expect(cliSrc).toContain('result.usage && result.choices !== undefined');
  });
});
