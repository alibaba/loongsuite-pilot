import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as util from 'node:util';
import type { AgentDefinition } from '../types/index.js';
import { resolveHome, type AtomicTextWriteOptions } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';
import { agentConfigOwner } from './agent-config-owner.js';

const logger = createLogger('QoderTokenUsage');
const tokenUsageKeys = ['QODER_EXPOSE_TOKEN_USAGE', 'QODERCN_EXPOSE_TOKEN_USAGE'];
// Pilot runs on Node 22+, but the project still uses Node 18 type definitions.
const { parseEnv } = util as typeof util & { parseEnv(text: string): Record<string, string> };

interface QoderEnvUpdate {
  file: string;
  text: string;
  options: AtomicTextWriteOptions;
}

/** Qoder reads its user .env on startup. Keep explicit user values. */
export async function planQoderTokenUsageDefaults(def: AgentDefinition): Promise<QoderEnvUpdate | undefined> {
  if (!def.hook || (def.id !== 'qoder' && def.id !== 'qoder-cn')) return undefined;

  const envFile = path.join(path.dirname(resolveHome(def.hook.settingsPath)), '.env');
  try {
    let stat = await fs.lstat(envFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    let target = envFile;
    if (stat?.isSymbolicLink()) {
      target = await fs.realpath(envFile);
      stat = await fs.stat(target);
    }
    if (stat && !stat.isFile()) throw new Error('expected a regular .env file');

    const content = stat ? await fs.readFile(target, 'utf8') : '';
    const values = parseEnv(content.replace(/^\uFEFF/, ''));
    const missing = tokenUsageKeys.filter(key => !Object.hasOwn(values, key));
    if (missing.length === 0) return undefined;

    const newline = content.includes('\r\n') ? '\r\n' : '\n';
    const separator = content && !content.endsWith('\n') ? newline : '';
    const defaults = missing.map(key => `${key}=1`).join(newline);
    // A privileged deployment must leave the file readable by the client user.
    const owner = process.getuid?.() === 0 ? stat ?? await agentConfigOwner(target) : undefined;
    return {
      file: target,
      text: `${content}${separator}${defaults}${newline}`,
      options: {
        mode: stat ? stat.mode & 0o777 : 0o600,
        preserveMode: stat !== undefined,
        expected: stat ? { exists: true, content } : { exists: false },
        ...(owner ? { owner: { uid: owner.uid, gid: owner.gid } } : {}),
      },
    };
  } catch (error) {
    logger.warn('unable to inspect Qoder token usage defaults', { agentId: def.id, envFile, error: String(error) });
    return undefined;
  }
}
