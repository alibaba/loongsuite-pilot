/**
 * Normalize PAT copied from env / docs (common footguns for Qoder exchange).
 * @param {string | undefined} raw
 * @returns {string}
 */
export function normalizeE2eQoderPersonalAccessToken(raw) {
  let s = String(raw ?? '').replace(/\r/g, '').trim();
  if (!s) return '';
  if (/^bearer\s+/i.test(s)) s = s.replace(/^bearer\s+/i, '').trim();
  if (s.length >= 2) {
    const quoteChar = s[0];
    if ((quoteChar === '"' || quoteChar === "'") && s.endsWith(quoteChar)) {
      s = s.slice(1, -1);
    }
  }
  return s;
}
