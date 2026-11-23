/**
 * Build remote bash for agent probes. Uses optional `---` line separators: first segment runs as a
 * normal preamble (PATH, cd); each following segment runs in its own `bash -s` fed by base64 so
 * tools like Codex cannot consume the rest of the SSH-delivered script from inherited stdin.
 *
 * If there is no `---`, the entire command is executed via one base64-wrapped inner bash (still
 * avoids sharing the outer SSH stdin pipe with grandchildren in most setups).
 *
 * @param {string} probeCmd
 * @returns {string} full remote bash source (include set +e yourself inside probeCmd or rely on outer)
 */
export function buildAgentProbeRemoteBody(probeCmd) {
  const raw = probeCmd.trim();
  if (!raw) return '';

  const parts = raw.split(/\r?\n---\r?\n/).map(p => p.trim()).filter(Boolean);
  if (parts.length === 1) {
    return [
      'set +euo pipefail',
      'echo "[e2e-probe] stdin-isolated inner bash (use lines containing only --- between agents for per-agent isolation)"',
      wrapInBase64Bash(parts[0]),
    ].join('\n');
  }

  const lines = [
    'set +euo pipefail',
    'echo "[e2e-probe] multi-block probe (' +
      String(parts.length - 1) +
      ' isolated segment(s) after preamble; divider = line --- only)"',
    wrapInBase64Bash(parts[0]),
  ];
  for (let i = 1; i < parts.length; i++) {
    lines.push(`echo "[e2e-probe] --- block ${i} ---"`);
    lines.push(wrapInBase64Bash(parts[i]));
  }
  return lines.join('\n');
}

/**
 * @param {string} bashSnippet
 * @returns {string} one remote statement
 */
export function wrapInBase64Bash(bashSnippet) {
  const b64 = Buffer.from(`${bashSnippet}\n`, 'utf8').toString('base64');
  return `printf '%s' '${b64}' | base64 -d | bash --norc --noprofile -s`;
}
