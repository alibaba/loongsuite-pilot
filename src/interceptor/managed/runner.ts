export type ScriptVerdict =
  | { matched: false }
  | { matched: true; reason: string };

export type ScriptRunResult =
  | { ok: true; stdout: string }
  | { ok: false; error: string };

export interface ScriptRunner {
  /** `payload` is the one-line JSON request body. Never rejects. */
  run(file: string, payload: string, timeoutMs: number): Promise<ScriptRunResult>;
  /** Starts long-lived workers ahead of the first hook, if the runner has any. */
  warm?(): void;
  stop(): void;
}

export const MAX_SCRIPT_STDOUT_BYTES = 64 * 1024;

/**
 * Accepts exactly one non-empty stdout line: `{"matched":false}` or
 * `{"matched":true,"reason":"..."}`. Anything else is a failed rule.
 */
export function parseScriptVerdict(stdout: string): ScriptVerdict | null {
  const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
  if (lines.length !== 1) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(lines[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const verdict = parsed as { matched?: unknown; reason?: unknown };
  if (verdict.matched === false) return { matched: false };
  if (verdict.matched === true && typeof verdict.reason === 'string') {
    return { matched: true, reason: verdict.reason };
  }
  return null;
}

const SCRIPT_ENV_KEYS = [
  'PATH', 'Path', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR',
  'TEMP', 'TMP', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT',
  'USERPROFILE', 'USERNAME', 'APPDATA', 'LOCALAPPDATA', 'PSModulePath',
];

/** Script rules get no collector credentials from the environment. */
export function scriptEnv(source: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Windows Worker copies are case-sensitive JS objects, unlike the main
  // thread's process.env. Keep one canonical spelling of each allowed key.
  const windowsSource = platform === 'win32'
    ? new Map(Object.entries(source).map(([key, value]) => [key.toLowerCase(), value]))
    : null;
  const copied = new Set<string>();
  for (const key of SCRIPT_ENV_KEYS) {
    const lookup = key.toLowerCase();
    if (windowsSource && copied.has(lookup)) continue;
    const value = windowsSource ? windowsSource.get(lookup) : source[key];
    if (value !== undefined) {
      env[key] = value;
      copied.add(lookup);
    }
  }
  return env;
}
