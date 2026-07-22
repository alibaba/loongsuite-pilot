import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { InputState } from '../../types/index.js';
import { getTodayDateString } from '../../utils/fs-utils.js';

export interface HookHistoryStartupCheckpoint {
  state: InputState;
  skippedExistingBytes: number;
}

/**
 * Establish a deterministic consumer boundary before the first collection.
 *
 * A missing checkpoint plus an existing history file is ambiguous: the file
 * may contain records dispatched before state loss as well as records written
 * while the collector was down. Guessing a logical turn is not a safe recovery
 * rule, so the no-replay policy baselines the existing bytes and reports the
 * skipped size to the caller for diagnostics. If the file does not exist yet,
 * persisting offset 0 ensures every batch created after startup is consumed.
 */
export async function createHookHistoryStartupCheckpoint(
  current: InputState,
  logDir: string,
  logPrefix: string,
): Promise<HookHistoryStartupCheckpoint | null> {
  if (hasUsableCheckpoint(current)) return null;

  const logFileName = `${logPrefix}-${getTodayDateString()}.jsonl`;
  const logFile = path.join(logDir, logFileName);
  let existingBytes = 0;
  try {
    existingBytes = (await fs.stat(logFile)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // The hook creates the daily file lazily. Offset 0 is the important part:
    // it marks initialization now, before multiple sessions can append batches.
  }

  return {
    state: {
      ...current,
      lastFile: logFileName,
      lastOffset: existingBytes,
      extra: {
        ...(current.extra ?? {}),
        hookHistoryInitialized: true,
      },
    },
    skippedExistingBytes: existingBytes,
  };
}

function hasUsableCheckpoint(state: InputState): boolean {
  return typeof state.lastFile === 'string'
    && state.lastFile.length > 0
    && Number.isFinite(state.lastOffset)
    && (state.lastOffset ?? -1) >= 0;
}
