// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

export function normalizeCodexToolArguments(toolName, input) {
  return mergeCodexToolArguments(toolName, input, toolName, input);
}

export function mergeCodexToolArguments(toolName, hookInput, transcriptToolName, transcriptInput) {
  const hookArgs = isPlainObject(hookInput) ? hookInput : {};
  const transcriptArgs = isPlainObject(transcriptInput) ? transcriptInput : {};
  const normalizedName = String(toolName || transcriptToolName || '').toLowerCase();
  const normalizedTranscriptName = String(transcriptToolName || '').toLowerCase();

  if (normalizedName === 'bash' || normalizedTranscriptName === 'exec_command') {
    const command = hookArgs.command ?? transcriptArgs.command ?? transcriptArgs.cmd;
    const workdir = hookArgs.workdir ?? transcriptArgs.workdir;
    const out = {};
    if (command !== undefined) out.command = command;
    if (workdir !== undefined) out.workdir = workdir;
    return Object.keys(out).length > 0 ? out : hookInput;
  }

  if (normalizedName === 'apply_patch') {
    if (hookArgs.command !== undefined) return hookArgs;
    if (transcriptArgs.command !== undefined) return transcriptArgs;
    if (typeof hookInput === 'string') return { command: hookInput };
    if (typeof transcriptInput === 'string') return { command: transcriptInput };
    if (isPlainObject(hookInput)) return hookInput;
    if (isPlainObject(transcriptInput)) return transcriptInput;
    const command = hookInput ?? transcriptInput;
    return command != null ? { command } : hookInput;
  }

  if (isPlainObject(transcriptInput)) return transcriptInput;
  return hookInput ?? transcriptInput;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
