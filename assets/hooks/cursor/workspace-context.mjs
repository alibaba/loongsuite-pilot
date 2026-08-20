/** Resolve the best working directory captured by Cursor hook events. */
export function resolveWorkspacePath(events) {
  for (const event of events || []) {
    const cwd = normalizeString(event?.cwd);
    if (cwd) return cwd;
  }

  for (const event of events || []) {
    const roots = normalizeRoots(event?.workspace_roots);
    if (roots.length > 0) return roots[0];
  }

  return undefined;
}

/** Build the stable Agent-specific cwd attribute consumed by Pilot. */
export function cursorWorkspaceFields(variant, workspacePath) {
  const cwd = normalizeString(workspacePath);
  return cwd ? { [`agent.${variant || 'cursor'}.cwd`]: cwd } : {};
}

function normalizeString(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeRoots(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeString).filter(Boolean);
  }
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(normalizeString).filter(Boolean);
  } catch {
    // A single plain path is also accepted.
  }
  const root = normalizeString(value);
  return root ? [root] : [];
}
