import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildBashUpdatedInput,
  consumeToolContext,
  isToolPropagationConsumed,
  markToolPropagationConsumed,
  reserveToolContext,
} from '../../../../assets/hooks/claude-code/tool-context.mjs';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const UPSTREAM_SPAN_ID = '00f067aa0ba902b7';
const TRACEPARENT = `00-${TRACE_ID}-${UPSTREAM_SPAN_ID}-00`;

describe('claude-code per-tool context', () => {
  let dataDir;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-tool-context-'));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('reserves idempotently and preserves trace flags', () => {
    const first = reserveToolContext({
      dataDir,
      sessionId: 'sid-1',
      toolUseId: 'tool-1',
      traceparent: TRACEPARENT,
      tracestate: 'vendor=value',
    });
    const second = reserveToolContext({
      dataDir,
      sessionId: 'sid-1',
      toolUseId: 'tool-1',
      traceparent: TRACEPARENT,
      tracestate: 'vendor=value',
    });

    expect(first.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(first.traceparent).toBe(`00-${TRACE_ID}-${first.spanId}-00`);
    expect(first.tracestate).toBe('vendor=value');
    expect(second.spanId).toBe(first.spanId);
  });

  it('returns a full Bash input replacement without changing other fields', () => {
    const context = reserveToolContext({
      dataDir,
      sessionId: 'sid-2',
      toolUseId: 'tool-2',
      traceparent: TRACEPARENT,
      tracestate: "vendor=value'quoted",
    });
    const updated = buildBashUpdatedInput({
      command: 'printf hello | sed s/h/H/',
      description: 'pipeline',
      timeout: 1234,
      run_in_background: true,
    }, context);

    expect(updated.description).toBe('pipeline');
    expect(updated.timeout).toBe(1234);
    expect(updated.run_in_background).toBe(true);
    expect(updated.command).toContain(`export TRACEPARENT='${context.traceparent}'`);
    expect(updated.command).toContain("export TRACESTATE='vendor=value'\\''quoted'");
    expect(updated.command.endsWith('printf hello | sed s/h/H/')).toBe(true);
  });

  it('consumes the context once and rejects later turns after Stop', () => {
    const context = reserveToolContext({
      dataDir,
      sessionId: 'sid-3',
      toolUseId: 'tool-3',
      traceparent: TRACEPARENT,
    });
    expect(consumeToolContext(dataDir, 'sid-3', 'tool-3').spanId).toBe(context.spanId);
    expect(consumeToolContext(dataDir, 'sid-3', 'tool-3')).toBeNull();

    markToolPropagationConsumed(dataDir, 'sid-3');
    expect(isToolPropagationConsumed(dataDir, 'sid-3')).toBe(true);
    expect(reserveToolContext({
      dataDir,
      sessionId: 'sid-3',
      toolUseId: 'tool-next-turn',
      traceparent: TRACEPARENT,
    })).toBeNull();
  });

  it('fails open for invalid traceparent and malformed input', () => {
    expect(reserveToolContext({
      dataDir,
      sessionId: 'sid-4',
      toolUseId: 'tool-4',
      traceparent: 'invalid',
    })).toBeNull();
    expect(buildBashUpdatedInput({ command: '' }, { traceparent: TRACEPARENT })).toBeNull();
  });
});
