// Shared by the pre-injection resolver and the in-host plugin. No host imports.
export const MIN_OPENCLAW_VERSION = "2026.3.8";

function atLeast(value, floor) {
  if (typeof value !== "string") return false;
  const m = value.trim().match(/^v?(\d{4})\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!m) return false;
  const core = m.slice(1, 4).map(Number);
  const target = floor.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (core[i] !== target[i]) return core[i] > target[i];
  }
  // Numeric suffixes are OpenClaw release corrections, named ones prereleases.
  return !m[4] || /^\d+(?:\.\d+)*$/.test(m[4]);
}

export function openClawCapabilities(version) {
  if (!atLeast(version, MIN_OPENCLAW_VERSION)) return null;
  return {
    version: version.trim(),
    adapter: atLeast(version, "2026.5.12") ? "modern" : "legacy",
    conversationAccess: atLeast(version, "2026.4.24"),
  };
}
