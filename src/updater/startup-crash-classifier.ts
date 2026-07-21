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
  const message = (breadcrumb.error_message || '').toLowerCase();
  const full = `${breadcrumb.error_message}\n${breadcrumb.error_stack_head}`.toLowerCase();
  return {
    reason: detectReason(message, full, breadcrumb.phase),
    detailHead: sanitizeDetail(firstLine(breadcrumb.error_message)),
  };
}

function detectReason(message: string, full: string, phase: string): StartupCrashReason {
  if (
    full.includes('sqlite3')
    || full.includes('err_dlopen_failed')
    || full.includes('did not self-register')
    || /cannot find module\s+['"][^'"]*\.node['"]/.test(full)
    || full.includes('install scripts')
    || full.includes('node_module_version')
    || full.includes('compiled against a different node')
  ) {
    return 'native_module_missing';
  }
  if (full.includes('cannot find module')) {
    return 'module_not_found';
  }
  // Check permission/disk before config so a startup-phase EACCES whose message merely
  // mentions "config" is not mislabeled as a configuration error.
  if (full.includes('eacces') || full.includes('erofs') || full.includes('enospc')) {
    return 'permission_or_disk';
  }
  // config_error is intentionally narrow: only a JSON-parse signature in the error
  // *message* (not the stack, which routinely contains config-loader.ts paths) during
  // the startup phase. Bare "config"/"json" substrings are too broad.
  if (
    phase === 'startup'
    && (
      message.includes('unexpected token')
      || message.includes('unexpected end of json')
      || message.includes(' in json')
      || message.includes('not valid json')
      || message.includes('json.parse')
    )
  ) {
    return 'config_error';
  }
  return 'unknown';
}

function firstLine(text: string): string {
  return (text || '').split(/\r?\n/)[0] ?? '';
}

// Keep the detail safe to embed in `detail="..."` inside the alarm message: no quotes
// or control chars that could break downstream parsing/readability.
function sanitizeDetail(text: string): string {
  return text.replace(/["\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, DETAIL_MAX_CHARS);
}
