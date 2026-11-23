/**
 * Match config-loader / console habit: allow `cn-hangzhou.log.aliyuncs.com` without scheme.
 * @param {string} raw
 */
export function normalizeSlsEndpoint(raw) {
  const t = String(raw).trim();
  if (!t) return t;
  if (/^https?:\/\//i.test(t)) return t;
  return `https://${t}`;
}

/** When project+logstore are propagated but `E2E_SLS_ENDPOINT` is unset — aligns with typical cn-hangzhou operator Logstores. */
export const DEFAULT_E2E_INSTALL_SLS_ENDPOINT = 'https://cn-hangzhou.log.aliyuncs.com';

/**
 * Bash single-quoted string: safe for embedding after `bash -s -- install ...`.
 * @param {string} s
 */
export function shellSingleQuoteBash(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * When true, remote `install` receives `--sls-*` derived from `E2E_SLS_*` env vars (install propagation only).
 * Set `E2E_PROPAGATE_SLS_INSTALL=0` to force plain install (packaged internal fallback only).
 * @param {NodeJS.ProcessEnv} env
 */
export function shouldPropagateSlsToRemoteInstall(env) {
  if (env.E2E_PROPAGATE_SLS_INSTALL === '0') return false;
  const project = env.E2E_SLS_PROJECT?.trim();
  const logstore = env.E2E_SLS_LOGSTORE?.trim();
  return !!(project && logstore);
}

/**
 * Extra CLI tokens for `bash -s -- install ...` (already shell-quoted values).
 * Empty string when propagation is off or project/logstore missing.
 * @param {NodeJS.ProcessEnv} env
 */
export function buildRemoteInstallSlsCliQuotedArgs(env) {
  if (!shouldPropagateSlsToRemoteInstall(env)) return '';

  const project = env.E2E_SLS_PROJECT.trim();
  const logstore = env.E2E_SLS_LOGSTORE.trim();
  const endpointRaw = env.E2E_SLS_ENDPOINT?.trim() || DEFAULT_E2E_INSTALL_SLS_ENDPOINT;
  const endpoint = normalizeSlsEndpoint(endpointRaw);

  const parts = [
    '--sls-endpoint',
    shellSingleQuoteBash(endpoint),
    '--sls-project',
    shellSingleQuoteBash(project),
    '--sls-logstore',
    shellSingleQuoteBash(logstore),
  ];

  const ak = env.E2E_SLS_ACCESS_KEY_ID?.trim();
  const sk = env.E2E_SLS_ACCESS_KEY_SECRET?.trim();
  if (ak && sk) {
    parts.push('--sls-ak-id', shellSingleQuoteBash(ak));
    parts.push('--sls-ak-secret', shellSingleQuoteBash(sk));
  }

  return parts.join(' ');
}
