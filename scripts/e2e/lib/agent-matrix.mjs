import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * @returns {string}
 */
export function defaultAgentMatrixPath() {
  return path.join(__dirname, '..', 'agent-matrix.json');
}

/**
 * @param {NodeJS.ProcessEnv} env
 */
export function loadAgentMatrix(env = process.env) {
  const p = env.E2E_AGENT_MATRIX_PATH?.trim() || defaultAgentMatrixPath();
  const raw = readFileSync(p, 'utf8');
  const j = JSON.parse(raw);
  if (!Array.isArray(j.agents)) throw new Error(`agent-matrix.json missing agents[] (${p})`);
  return { path: p, agents: j.agents };
}

/**
 * Cursor: headless-friendly `--extract`. Override with E2E_CURSOR_ENSURE_INSTALL_SH.
 *
 * Important: `curl … | bash -s` leaves install.sh with no real SCRIPT_DIR, so watzon's
 * install.sh always downloads cursor.sh from raw.githubusercontent.com (often blocked / slow).
 * We stage install.sh + lib.sh + cursor.sh into ~/.cache and run ./install.sh from that dir
 * so local cursor.sh is used. Mirrors: E2E_CURSOR_JSDELIVR_BASE, E2E_CURSOR_RAW_BASE.
 *
 * @param {object} agent
 * @param {NodeJS.ProcessEnv} env
 */
export function resolveEnsureInstallSh(agent, env = process.env) {
  const bin = String(agent.binary ?? '').trim();
  if (bin === 'cursor') {
    if (env.E2E_CURSOR_ENSURE_INSTALL_SH?.trim()) {
      return env.E2E_CURSOR_ENSURE_INSTALL_SH.trim();
    }
    const stripInstallPath = u => String(u).trim().replace(/\/install\.sh\/?$/i, '');
    const jsdelivrBase = env.E2E_CURSOR_JSDELIVR_BASE?.trim()
      ? env.E2E_CURSOR_JSDELIVR_BASE.trim()
      : env.E2E_CURSOR_INSTALL_SCRIPT_URL?.trim()
        ? stripInstallPath(env.E2E_CURSOR_INSTALL_SCRIPT_URL)
        : 'https://cdn.jsdelivr.net/gh/watzon/cursor-linux-installer@main';
    const rawBase = env.E2E_CURSOR_RAW_BASE?.trim()
      ? env.E2E_CURSOR_RAW_BASE.trim()
      : env.E2E_CURSOR_INSTALL_SCRIPT_URL_FALLBACK?.trim()
        ? stripInstallPath(env.E2E_CURSOR_INSTALL_SCRIPT_URL_FALLBACK)
        : 'https://raw.githubusercontent.com/watzon/cursor-linux-installer/main';
    const failMsg =
      "echo '[e2e-ensure] Cursor installer failed — set E2E_CURSOR_ENSURE_INSTALL_SH or use apt (cursor.com/docs)'";
    // One subshell: failures don't exit the whole ensure script (set +euo pipefail on parent).
    return (
      `( _d="$HOME/.cache/loongsuite-e2e-cursor-install"; mkdir -p "$_d" && cd "$_d" || exit 1; ` +
      `_b="${jsdelivrBase}"; _f="${rawBase}"; ` +
      `_dl() { o="$1"; a="$2"; b="$3"; curl -fsSL --connect-timeout 25 --max-time 120 --retry 2 --retry-delay 2 "$a" -o "$o" || curl -fsSL --connect-timeout 25 --max-time 120 --retry 2 --retry-delay 2 "$b" -o "$o"; }; ` +
      `_dl install.sh "$_b/install.sh" "$_f/install.sh" && _dl lib.sh "$_b/lib.sh" "$_f/lib.sh" && _dl cursor.sh "$_b/cursor.sh" "$_f/cursor.sh" && ` +
      `chmod +x install.sh cursor.sh && bash ./install.sh stable --extract ) || ${failMsg}`
    );
  }
  return String(agent.ensureInstallSh ?? '').trim();
}

/**
 * Remote bash: npm-based best-effort installs when binary missing.
 * @param {{ agents: object[] }} matrix
 * @param {NodeJS.ProcessEnv} env
 */
export function buildEnsureAgentClisScript(matrix, env = process.env) {
  const lines = [
    'set +euo pipefail',
    'export PATH="$HOME/.local/bin:$PATH"',
    'echo "[e2e-ensure] checking agent matrix CLIs (scripts/e2e/agent-matrix.json)"',
  ];

  const extra = env.E2E_EXTRA_ENSURE_BASH?.trim();
  if (extra) {
    lines.push('# E2E_EXTRA_ENSURE_BASH');
    lines.push(extra);
  }

  lines.push('if ! command -v npm >/dev/null 2>&1; then');
  lines.push('  echo "[e2e-ensure] npm not on PATH; skipping npm-based installs"');
  lines.push('else');

  for (const a of matrix.agents) {
    const bin = String(a.binary ?? '').trim();
    if (!bin) continue;
    const label = String(a.name ?? bin);
    const install = resolveEnsureInstallSh(a, env);

    lines.push(`  echo "[e2e-ensure] binary: ${bin} (${label})"`);
    lines.push(`  if command -v ${bin} >/dev/null 2>&1; then`);
    lines.push(`    echo "[e2e-ensure] ok: ${bin}"`);
    lines.push(`  else`);
    if (install) {
      lines.push(`    echo "[e2e-ensure] installing ${label}..."`);
      lines.push(`    ${install}`);
    } else {
      lines.push(
        `    echo "[e2e-ensure] no ensureInstallSh for ${label}; install ${bin} manually or append E2E_EXTRA_ENSURE_BASH"`,
      );
    }
    lines.push(`  fi`);
  }

  lines.push('fi');

  lines.push(
    'if command -v cursor-installer >/dev/null 2>&1 && ! command -v cursor >/dev/null 2>&1; then',
    '  echo "[e2e-ensure] cursor-installer present but cursor shim missing; trying cursor-installer --extract --update stable"',
    '  cursor-installer --extract --update stable || echo "[e2e-ensure] cursor-installer --extract --update failed (non-fatal if extract already done)"',
    'fi',
    '# Always fix wrong-depth path .../cursor/cursor/cursor when extract exists (Qoder/Codex hooks may look there even if `cursor` is already on PATH)',
    '_e2e_cursor_bin=""',
    'for _p in "$HOME/.local/share/cursor/cursor/usr/bin/cursor" "$HOME/.cursor/cursor/usr/bin/cursor"; do',
    '  if [ -x "$_p" ]; then _e2e_cursor_bin="$_p"; break; fi',
    'done',
    'if [ -n "$_e2e_cursor_bin" ]; then',
    '  for _legacy_root in "$HOME/.local/share/cursor/cursor" "$HOME/.cursor/cursor"; do',
    '    if [ -d "$_legacy_root" ]; then',
    '      ln -sf "$_e2e_cursor_bin" "$_legacy_root/cursor" && echo "[e2e-ensure] compat symlink $_legacy_root/cursor -> $_e2e_cursor_bin"',
    '    fi',
    '  done',
    'fi',
    '# watzon may skip ~/.local/bin/cursor when shim.sh download fails; link only when missing from PATH',
    'if ! command -v cursor >/dev/null 2>&1; then',
    '  if [ -n "$_e2e_cursor_bin" ]; then',
    '    mkdir -p "$HOME/.local/bin"',
    '    ln -sf "$_e2e_cursor_bin" "$HOME/.local/bin/cursor" && echo "[e2e-ensure] linked ~/.local/bin/cursor -> $_e2e_cursor_bin"',
    '  else',
    '    echo "[e2e-ensure] no extracted Cursor binary found under ~/.local/share/cursor or ~/.cursor"',
    '  fi',
    'fi',
  );

  lines.push(
    'echo "[e2e-ensure] summary:"',
    'for _b in codex claude cursor qoder; do',
    '  if command -v "$_b" >/dev/null 2>&1; then echo "[e2e-ensure] have $_b";',
    '  elif [ "$_b" = cursor ] && command -v cursor-installer >/dev/null 2>&1; then echo "[e2e-ensure] have cursor (cursor-installer on PATH; run cursor-installer --update if needed)";',
    '  else echo "[e2e-ensure] missing $_b"; fi',
    'done',
  );
  return `${lines.join('\n')}\n`;
}

/**
 * One isolated bash -s per agent (stdin from decoded pipe, not SSH session).
 * @param {{ agents: object[] }} matrix
 */
export function buildMatrixProbeScript(matrix) {
  const lines = [
    'set +e -o pipefail',
    'export PATH="$HOME/.local/bin:$PATH"',
    'cd "$HOME" || true',
    'echo "[e2e-probe] running one isolated bash per agent (order = agent-matrix.json)"',
  ];

  for (const a of matrix.agents) {
    const block = String(a.defaultProbeSh ?? '').trim();
    if (!block) continue;
    const label = String(a.name ?? a.binary ?? 'agent').replace(/'/g, `'\\''`);
    const bin = String(a.binary ?? '').replace(/'/g, `'\\''`);
    const b64 = Buffer.from(`${block}\n`, 'utf8').toString('base64');
    lines.push(`echo "[e2e-probe] >>> start: ${label} (binary=${bin})"`);
    // base64 uses [A-Za-z0-9+/=] — safe inside single quotes for printf
    // `\${_st}` → remote bash sees `${_st}` and expands last exit code (avoid JS `${}` interpolation)
    lines.push(
      `printf '%s' '${b64}' | base64 -d | bash --norc --noprofile -s; _st=$?; ` +
        `if [ "$_st" -eq 0 ]; then echo "[e2e-probe] <<< end: ${label} (exit 0)"; ` +
        `else echo "[e2e-probe] <<< end: ${label} (exit \${_st}, non-fatal)"; fi`,
    );
  }

  lines.push('echo "[e2e-probe] all matrix blocks finished"');
  return `${lines.join('\n')}\n`;
}
