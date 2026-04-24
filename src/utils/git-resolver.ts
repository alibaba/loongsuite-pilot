import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import { GitContext } from '../types/index.js';

const execFileAsync = promisify(execFile);

async function readGitString(
  gitRoot: string,
  file: string,
  args: string[]
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(file, args, {
      cwd: gitRoot,
      maxBuffer: 4 * 1024 * 1024,
    });
    return String(stdout).trim();
  } catch {
    return '';
  }
}

/**
 * Walks upward from a file or directory path until a `.git` entry is found.
 */
export async function findGitRoot(filePath: string): Promise<string | null> {
  let current = path.resolve(filePath);
  try {
    const st = await fsp.stat(current);
    if (st.isFile()) {
      current = path.dirname(current);
    }
  } catch {
    current = path.dirname(current);
  }

  const { root: fsRoot } = path.parse(current);

  while (true) {
    const gitEntry = path.join(current, '.git');
    try {
      const st = await fsp.stat(gitEntry);
      if (st.isFile() || st.isDirectory()) {
        return current;
      }
    } catch {
      // keep walking
    }
    if (current === fsRoot) {
      return null;
    }
    current = path.dirname(current);
  }
}

/**
 * Collects origin URL, current branch, and HEAD from a git work tree.
 * On per-command failure, the corresponding field is an empty string.
 */
export async function collectRepoInfo(gitRoot: string): Promise<GitContext> {
  const [repoId, branchName, commitHash] = await Promise.all([
    readGitString(gitRoot, 'git', ['remote', 'get-url', 'origin']),
    readGitString(gitRoot, 'git', ['rev-parse', '--abbrev-ref', 'HEAD']),
    readGitString(gitRoot, 'git', ['rev-parse', 'HEAD']),
  ]);

  return {
    repoId,
    branchName,
    commitHash,
    repoRoot: gitRoot,
  };
}
