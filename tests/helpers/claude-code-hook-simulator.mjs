// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * A small Claude Code hook protocol simulator.
 *
 * It invokes the real Pilot hook wrapper with a Claude-shaped JSON payload,
 * applies hookSpecificOutput.updatedInput like Claude Code would, and executes
 * the resulting Bash command in a fresh process.
 */

import { spawnSync } from 'node:child_process';

function parseHookResponse(stdout) {
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) {
    throw new Error(`expected one hook response line, received ${lines.length}: ${stdout}`);
  }
  return JSON.parse(lines[0]);
}

export function invokeClaudeHook({
  hookPath,
  subcommand,
  payload,
  env = {},
  timeout = 15_000,
}) {
  const result = spawnSync('bash', [hookPath, subcommand], {
    input: JSON.stringify(payload),
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    timeout,
  });

  return {
    ...result,
    response: parseHookResponse(result.stdout),
  };
}

export function simulateClaudeBashTool({
  hookPath,
  payload,
  hookEnv = {},
  executionEnv = {},
  timeout = 15_000,
  isolateInheritedTraceContext = true,
}) {
  const hook = invokeClaudeHook({
    hookPath,
    subcommand: 'pre-tool-use',
    payload,
    env: hookEnv,
    timeout,
  });
  const updatedInput = hook.response?.hookSpecificOutput?.updatedInput;
  const effectiveInput = updatedInput ?? payload.tool_input;

  if (!effectiveInput || typeof effectiveInput.command !== 'string') {
    throw new Error('PreToolUse simulation did not produce an executable Bash command');
  }

  const childEnv = { ...process.env, ...executionEnv };
  if (isolateInheritedTraceContext) {
    delete childEnv.TRACEPARENT;
    delete childEnv.TRACESTATE;
    delete childEnv.OTEL_RESOURCE_ATTRIBUTES;
  }

  const tool = spawnSync('bash', ['-c', effectiveInput.command], {
    cwd: payload.cwd,
    env: childEnv,
    encoding: 'utf-8',
    timeout,
  });

  return {
    hook,
    tool,
    originalInput: payload.tool_input,
    effectiveInput,
    wasUpdated: Boolean(updatedInput),
  };
}
