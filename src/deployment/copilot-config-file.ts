// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs/promises';
import { writeTextFileAtomic } from '../utils/fs-utils.js';

/** Follow existing symlinks, retain permissions and reject concurrent edits. */
export async function readCopilotFile(file: string) {
  let target = file;
  try {
    await fs.lstat(file);
    target = await fs.realpath(file); // Dangling links are errors, never replaced.
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // Distinguish an absent path from an existing dangling symlink.
    try { await fs.lstat(file); } catch (missing) {
      if ((missing as NodeJS.ErrnoException).code === 'ENOENT') {
        return { target, content: '', exists: false as const, mode: 0o600 };
      }
      throw missing;
    }
    throw err;
  }
  const stat = await fs.stat(target);
  return { target, content: await fs.readFile(target, 'utf8'), exists: true as const, mode: stat.mode & 0o777 };
}

export async function writeCopilotFile(snapshot: Awaited<ReturnType<typeof readCopilotFile>>, content: string): Promise<void> {
  if (snapshot.exists && snapshot.content === content) return;
  await writeTextFileAtomic(snapshot.target, content, {
    mode: snapshot.mode,
    preserveMode: snapshot.exists,
    expected: snapshot.exists ? { exists: true, content: snapshot.content } : { exists: false },
  });
}
