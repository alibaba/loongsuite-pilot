export function normalizeAgentType(raw: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'unknown';
}
