import type { StartupCrashBreadcrumb } from '../utils/crash-breadcrumb.js';

export type StartupCrashReason =
  | 'native_module_missing'
  | 'module_not_found'
  | 'config_error'
  | 'permission_or_disk'
  | 'unknown';

export interface StartupCrashClassification {
  reason: StartupCrashReason;
  detailHead: string;
}

const DETAIL_MAX_CHARS = 300;

/**
 * Maps a raw crash breadcrumb to a stable `reason` label (for aggregation/alarming)
 * plus a human-readable detail head. Rules are evaluated in order; the first match
 * wins, and `unknown` always carries the raw message so nothing is lost.
 */
export function classifyStartupCrash(breadcrumb: StartupCrashBreadcrumb): StartupCrashClassification {
  const haystack = `${breadcrumb.error_message}\n${breadcrumb.error_stack_head}`.toLowerCase();
  return {
    reason: detectReason(haystack, breadcrumb.phase),
    detailHead: firstLine(breadcrumb.error_message).slice(0, DETAIL_MAX_CHARS),
  };
}

function detectReason(text: string, phase: string): StartupCrashReason {
  if (
    text.includes('sqlite3')
    || text.includes('err_dlopen_failed')
    || text.includes('did not self-register')
    || /cannot find module\s+['"][^'"]*\.node['"]/.test(text)
    || text.includes('install scripts')
    || text.includes('node_module_version')
    || text.includes('compiled against a different node')
  ) {
    return 'native_module_missing';
  }
  if (text.includes('cannot find module')) {
    return 'module_not_found';
  }
  if (
    phase === 'startup'
    && (text.includes('json') || text.includes('unexpected token') || text.includes('config'))
  ) {
    return 'config_error';
  }
  if (text.includes('eacces') || text.includes('erofs') || text.includes('enospc')) {
    return 'permission_or_disk';
  }
  return 'unknown';
}

function firstLine(text: string): string {
  return (text || '').split(/\r?\n/)[0] ?? '';
}
