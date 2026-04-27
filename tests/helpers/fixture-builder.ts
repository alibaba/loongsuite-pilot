import { v4 as uuidv4 } from 'uuid';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClientType, ActionType } from '../../src/types/index.js';
import type { AgentActivityEntry, CodeGenerationEvent } from '../../src/types/index.js';

export function buildTestEntry(overrides: Partial<AgentActivityEntry> = {}): AgentActivityEntry {
  return {
    sessionId: overrides.sessionId ?? 'test-session-1',
    timestamp: overrides.timestamp ?? Date.now(),
    uuid: overrides.uuid ?? uuidv4(),
    userId: overrides.userId ?? 'test-user',
    agentType: overrides.agentType ?? ClientType.Qoder,
    actionType: overrides.actionType ?? ActionType.Edit,
    filePath: overrides.filePath ?? '/tmp/test/file.ts',
    content: overrides.content,
    inlineDiffMessage: overrides.inlineDiffMessage,
    git: overrides.git,
    extra: overrides.extra,
  };
}

export function buildTestCodeGenEvent(
  overrides: Partial<CodeGenerationEvent> = {},
): CodeGenerationEvent {
  return {
    agentType: overrides.agentType ?? ClientType.Qoder,
    filePath: overrides.filePath ?? '/tmp/test/file.ts',
    actionType: overrides.actionType ?? ActionType.Edit,
    content: overrides.content,
    diff: overrides.diff,
    sourceTimestamp: overrides.sourceTimestamp ?? Date.now(),
    rawData: overrides.rawData ?? {},
  };
}

export function buildHookRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_type: 'PostToolUse',
    tool_name: 'write_to_file',
    tool_input: { file_path: '/tmp/test.ts', content: 'hello' },
    session_id: 'sess-1',
    user_id: 'user-1',
    timestamp: Date.now(),
    ...overrides,
  };
}

export function buildSessionRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'tool_call',
    tool_name: 'write_file',
    file_path: '/tmp/test.ts',
    content: 'hello world',
    session_id: 'sess-1',
    timestamp: Date.now(),
    ...overrides,
  };
}

/**
 * Write JSONL lines to a file, creating parent dirs as needed.
 */
export async function writeJsonlFile(
  filePath: string,
  records: Record<string, unknown>[],
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const content = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  await fs.writeFile(filePath, content, 'utf-8');
}

/**
 * Append JSONL lines to an existing file.
 */
export async function appendJsonlLines(
  filePath: string,
  records: Record<string, unknown>[],
): Promise<void> {
  const content = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  await fs.appendFile(filePath, content, 'utf-8');
}

/**
 * Create a unique temporary directory for test isolation.
 */
export async function createTempDir(prefix = 'aac-test-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Remove a temporary directory and all contents.
 */
export async function cleanupTempDir(dirPath: string): Promise<void> {
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}
