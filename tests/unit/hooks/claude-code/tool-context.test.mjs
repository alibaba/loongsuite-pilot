import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  buildBashUpdatedInput,
  consumeToolContext,
  isToolPropagationConsumed,
  markToolPropagationConsumed,
  readTurnContext,
  reserveToolContext,
} from '../../../../assets/hooks/claude-code/tool-context.mjs';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const UPSTREAM_SPAN_ID = '00f067aa0ba902b7';
const TRACEPARENT = `00-${TRACE_ID}-${UPSTREAM_SPAN_ID}-00`;
const TOOL_CONTEXT_MODULE = pathToFileURL(path.resolve(
  'assets/hooks/claude-code/tool-context.mjs',
)).href;

function reserveInChild(dataDir, promptId, toolUseId) {
  const script = `
    const { reserveToolContext } = await import(process.env.TOOL_CONTEXT_MODULE);
    const context = reserveToolContext({
      dataDir: process.env.TEST_DATA_DIR,
      sessionId: 'sid-parallel',
      promptId: process.env.TEST_PROMPT_ID,
      toolUseId: process.env.TEST_TOOL_USE_ID,
      generateTraceWhenMissing: true,
    });
    process.stdout.write(JSON.stringify(context));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      env: {
        ...process.env,
        TOOL_CONTEXT_MODULE,
        TEST_DATA_DIR: dataDir,
        TEST_PROMPT_ID: promptId,
        TEST_TOOL_USE_ID: toolUseId,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`context reservation child exited ${code}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout));
    });
  });
}

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
    expect(updated.command).not.toContain('OTEL_RESOURCE_ATTRIBUTES');
    expect(updated.command.endsWith('printf hello | sed s/h/H/')).toBe(true);
  });

  it('generates one local trace per prompt and distinct TOOL parent ids', () => {
    const first = reserveToolContext({
      dataDir,
      sessionId: 'sid-local',
      promptId: 'prompt-1',
      toolUseId: 'tool-1',
      generateTraceWhenMissing: true,
    });
    const second = reserveToolContext({
      dataDir,
      sessionId: 'sid-local',
      promptId: 'prompt-1',
      toolUseId: 'tool-2',
      generateTraceWhenMissing: true,
    });

    expect(first.source).toBe('local');
    expect(first.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(second.traceId).toBe(first.traceId);
    expect(second.spanId).not.toBe(first.spanId);
    expect(first.traceparent).toBe(`00-${first.traceId}-${first.spanId}-01`);
    expect(readTurnContext(dataDir, 'sid-local', 'prompt-1')).toMatchObject({
      source: 'local',
      traceId: first.traceId,
      flags: '01',
    });
  });

  it('keeps parallel reservations trace-consistent, distinct, and idempotent', async () => {
    const contexts = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        reserveInChild(dataDir, 'prompt-parallel', `tool-${index}`)),
    );

    expect(new Set(contexts.map((context) => context.traceId)).size).toBe(1);
    expect(new Set(contexts.map((context) => context.spanId)).size).toBe(contexts.length);

    const duplicateContexts = await Promise.all(
      Array.from({ length: 6 }, () =>
        reserveInChild(dataDir, 'prompt-duplicate', 'tool-duplicate')),
    );
    expect(new Set(duplicateContexts.map((context) => context.traceId)).size).toBe(1);
    expect(new Set(duplicateContexts.map((context) => context.spanId)).size).toBe(1);
  });

  it('retries a partial record from an older writer without exposing a split trace', async () => {
    const legacyTraceId = 'cccccccccccccccccccccccccccccccc';
    const legacyWriter = `
      const fs = await import('node:fs');
      const path = await import('node:path');
      const dir = path.join(process.env.TEST_DATA_DIR, 'acp-correlate');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'sid-legacy.prompt-legacy.turn-context.json');
      const fd = fs.openSync(file, 'wx', 0o600);
      process.stdout.write('ready\\n');
      setTimeout(() => {
        fs.writeFileSync(fd, JSON.stringify({
          type: 'turn',
          source: 'local',
          sessionId: 'sid-legacy',
          promptId: 'prompt-legacy',
          traceId: '${legacyTraceId}',
          flags: '01',
        }));
        fs.closeSync(fd);
      }, 30);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', legacyWriter], {
      env: { ...process.env, TEST_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`legacy writer exited ${code}`));
      });
    });
    await new Promise((resolve) => child.stdout.once('data', resolve));

    const context = reserveToolContext({
      dataDir,
      sessionId: 'sid-legacy',
      promptId: 'prompt-legacy',
      toolUseId: 'tool-legacy',
      generateTraceWhenMissing: true,
    });
    await exited;

    expect(context?.traceId).toBe(legacyTraceId);
    expect(readTurnContext(dataDir, 'sid-legacy', 'prompt-legacy')?.traceId).toBe(legacyTraceId);
  });

  it('does not generate a competing tool context for an ACP-managed session', () => {
    const dir = path.join(dataDir, 'acp-correlate');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'sid-acp.jsonl'),
      `${JSON.stringify({
        type: 'turn',
        sessionId: 'sid-acp',
        traceparent: TRACEPARENT,
      })}\n`,
    );

    expect(reserveToolContext({
      dataDir,
      sessionId: 'sid-acp',
      promptId: 'prompt-acp',
      toolUseId: 'tool-acp',
      generateTraceWhenMissing: true,
    })).toBeNull();
  });

  it('uses a local trace on later prompts after the environment upstream is consumed', () => {
    const upstream = reserveToolContext({
      dataDir,
      sessionId: 'sid-mixed',
      promptId: 'prompt-1',
      toolUseId: 'tool-upstream',
      traceparent: TRACEPARENT,
      generateTraceWhenMissing: true,
    });
    expect(upstream.traceId).toBe(TRACE_ID);

    markToolPropagationConsumed(dataDir, 'sid-mixed');
    const local = reserveToolContext({
      dataDir,
      sessionId: 'sid-mixed',
      promptId: 'prompt-2',
      toolUseId: 'tool-local',
      traceparent: TRACEPARENT,
      tracestate: 'vendor=must-not-leak',
      generateTraceWhenMissing: true,
    });

    expect(local.source).toBe('local');
    expect(local.traceId).not.toBe(TRACE_ID);
    expect(local.tracestate).toBeUndefined();
  });

  it('injects resource attributes independently with shell-safe quoting', () => {
    const resourceAttributes = " team=O'Reilly,deployment.environment.name=prod ";
    const updated = buildBashUpdatedInput(
      { command: 'my-cli --work', timeout: 1000 },
      { resourceAttributes },
    );

    expect(updated.timeout).toBe(1000);
    expect(updated.command).toContain(
      "export OTEL_RESOURCE_ATTRIBUTES=' team=O'\\''Reilly,deployment.environment.name=prod '",
    );
    expect(updated.command).not.toContain('TRACEPARENT');
    expect(updated.command.endsWith('my-cli --work')).toBe(true);
  });

  it('accepts terminal line endings in resource attributes but rejects embedded newlines', () => {
    const lf = buildBashUpdatedInput(
      { command: 'my-cli' },
      { resourceAttributes: 'team=infra\n' },
    );
    const crlf = buildBashUpdatedInput(
      { command: 'my-cli' },
      { resourceAttributes: 'team=infra\r\n' },
    );

    expect(lf?.command).toContain("export OTEL_RESOURCE_ATTRIBUTES='team=infra'");
    expect(crlf?.command).toContain("export OTEL_RESOURCE_ATTRIBUTES='team=infra'");
    expect(buildBashUpdatedInput(
      { command: 'my-cli' },
      { resourceAttributes: 'team=infra\nowner=pilot' },
    )).toBeNull();
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

  it('refreshes the consumed marker mtime on later turns so active sessions survive TTL cleanup', () => {
    markToolPropagationConsumed(dataDir, 'sid-ttl');
    const markerPath = path.join(dataDir, 'acp-correlate', 'sid-ttl.tool-propagation.done');
    expect(fs.existsSync(markerPath)).toBe(true);

    // Age the marker past the mtime-based retention TTL window.
    const stale = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(markerPath, stale, stale);
    const staleMtime = fs.statSync(markerPath).mtimeMs;

    // A later Stop must bump the mtime forward (wx write -> EEXIST -> utimes),
    // so an active long session is not reaped and first-turn-only is preserved.
    markToolPropagationConsumed(dataDir, 'sid-ttl');
    expect(fs.statSync(markerPath).mtimeMs).toBeGreaterThan(staleMtime);
    expect(isToolPropagationConsumed(dataDir, 'sid-ttl')).toBe(true);
  });

  it('fails open for invalid traceparent and malformed input', () => {
    expect(reserveToolContext({
      dataDir,
      sessionId: 'sid-4',
      toolUseId: 'tool-4',
      traceparent: 'invalid',
    })).toBeNull();
    expect(buildBashUpdatedInput({ command: '' }, { traceparent: TRACEPARENT })).toBeNull();
    expect(buildBashUpdatedInput(
      { command: 'my-cli' },
      { resourceAttributes: 'team=bad\nvalue' },
    )).toBeNull();
  });
});
