import { v4 as uuidv4 } from 'uuid';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClientType, ActionType } from '../../src/types/index.js';
import type { AgentActivityEntry, CodeGenerationEvent } from '../../src/types/index.js';

type TestEntryOverrides = Partial<AgentActivityEntry> & {
  sessionId?: string;
  timestamp?: number;
  uuid?: string;
  userId?: string;
  agentType?: ClientType;
  actionType?: ActionType;
  filePath?: string;
  content?: string;
  inlineDiffMessage?: string;
  extra?: Record<string, unknown>;
};

export function buildTestEntry(overrides: TestEntryOverrides = {}): AgentActivityEntry {
  const eventId = overrides['event.id'] ?? overrides.uuid ?? uuidv4();
  const timestamp = overrides.timestamp ?? Date.now();
  return {
    time_unix_nano: overrides.time_unix_nano ?? `${timestamp}000000`,
    observed_time_unix_nano: overrides.observed_time_unix_nano ?? `${timestamp}000000`,
    'event.id': eventId,
    'event.name': overrides['event.name'] ?? 'other',
    'user.id': overrides['user.id'] ?? overrides.userId ?? 'test-user',
    'gen_ai.session.id': overrides['gen_ai.session.id'] ?? overrides.sessionId ?? 'test-session-1',
    'gen_ai.agent.type': overrides['gen_ai.agent.type'] ?? overrides.agentType ?? ClientType.Qoder,
    'gen_ai.provider.name': overrides['gen_ai.provider.name'] ?? 'unknown',
    'agent.file_path': overrides.filePath ?? '/tmp/test/file.ts',
    'agent.action_type': overrides.actionType ?? ActionType.Edit,
      ...(overrides.content !== undefined ? { content: overrides.content } : {}),
      ...(overrides.inlineDiffMessage !== undefined ? { inlineDiffMessage: overrides.inlineDiffMessage } : {}),
      ...(overrides.extra ?? {}),
      ...(overrides.attributes ?? {}),
    ...overrides,
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
export async function createTempDir(prefix = 'loongsuite-pilot-test-'): Promise<string> {
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
