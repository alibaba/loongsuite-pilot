export type HookInstallScope = 'user' | 'system';

/** Omission preserves recorded targets; it must not become an explicit user migration. */
export function resolveHookInstallScope(
  explicit?: HookInstallScope,
  envValue = process.env.LOONGSUITE_PILOT_HOOK_SCOPE,
): HookInstallScope | undefined {
  if (explicit !== undefined) return explicit;
  const value = envValue?.trim();
  if (!value) return undefined;
  if (value === 'user' || value === 'system') return value;
  throw new Error('LOONGSUITE_PILOT_HOOK_SCOPE must be user or system');
}
