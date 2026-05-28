import { execFile } from 'node:child_process';
import type { AgentDetectionConfig } from '../types/index.js';
import { directoryExists, fileExists, resolveHome } from '../utils/fs-utils.js';

export async function detectAgent(detection: AgentDetectionConfig): Promise<boolean> {
  for (const p of detection.paths) {
    const resolved = resolveHome(p);
    if (await directoryExists(resolved) || await fileExists(resolved)) {
      return true;
    }
  }

  for (const cmd of detection.commands) {
    if (await commandExists(cmd)) {
      return true;
    }
  }

  return false;
}

function commandExists(command: string): Promise<boolean> {
  return new Promise(resolve => {
    execFile('which', [command], err => {
      resolve(!err);
    });
  });
}
