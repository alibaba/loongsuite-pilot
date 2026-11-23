import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellSingleQuoteBash } from './propagate-sls-install.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function defaultAgentMatrixPath() {
  return path.join(__dirname, '..', 'agent-matrix.json');
}

export function loadAgentMatrix(env = process.env) {
  const p = env.E2E_AGENT_MATRIX_PATH?.trim() || defaultAgentMatrixPath();
  const raw = readFileSync(p, 'utf8');
  const j = JSON.parse(raw);
  if (!Array.isArray(j.agents)) throw new Error(`agent-matrix.json missing agents[] (${p})`);
  return { path: p, agents: j.agents };
}

/** 旧 glibc 主机（RHEL/CentOS/AliOS 7）profile 检测，影响默认 Cursor 安装策略。 */
export function isE2eOldGlibcCursorHostProfile(env = process.env) {
  const p = (env.E2E_PROFILE ?? 'linux-8u').trim().toLowerCase();
  return p === 'linux-7u' || p === '7u' || p === 'alios7' || p === 'linux-alios7';
}

/** E2E_CURSOR_INSTALL_STRATEGY 显式优先；否则旧 glibc profile → watzon，其余 → official。 */
export function resolveE2eCursorInstallStrategy(env = process.env) {
  const raw = env.E2E_CURSOR_INSTALL_STRATEGY?.trim();
  if (raw) return raw.toLowerCase() === 'watzon' ? 'watzon' : 'official';
  return isE2eOldGlibcCursorHostProfile(env) ? 'watzon' : 'official';
}

/**
 * cursor: official=cursor.com/install Agent CLI; watzon=AppImage 提取。E2E_CURSOR_ENSURE_INSTALL_SH 最优先。
 */
export function resolveEnsureInstallSh(agent, env = process.env) {
  const bin = String(agent.binary ?? '').trim();
  if (bin === 'cursor') {
    if (env.E2E_CURSOR_ENSURE_INSTALL_SH?.trim()) {
      return env.E2E_CURSOR_ENSURE_INSTALL_SH.trim();
    }
    const strategy = resolveE2eCursorInstallStrategy(env);
    if (strategy === 'watzon') {
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
        "echo '[e2e-ensure] Cursor (watzon) failed — try E2E_CURSOR_INSTALL_STRATEGY=official or E2E_CURSOR_ENSURE_INSTALL_SH'";
      return (
        `( _d="$HOME/.cache/loongsuite-e2e-cursor-install"; mkdir -p "$_d" && cd "$_d" || exit 1; ` +
        `_b="${jsdelivrBase}"; _f="${rawBase}"; ` +
        `_dl() { o="$1"; a="$2"; b="$3"; curl -fsSL --connect-timeout 25 --max-time 120 --retry 2 --retry-delay 2 "$a" -o "$o" || curl -fsSL --connect-timeout 25 --max-time 120 --retry 2 --retry-delay 2 "$b" -o "$o"; }; ` +
        `_dl install.sh "$_b/install.sh" "$_f/install.sh" && _dl lib.sh "$_b/lib.sh" "$_f/lib.sh" && _dl cursor.sh "$_b/cursor.sh" "$_f/cursor.sh" && ` +
        `chmod +x install.sh cursor.sh && bash ./install.sh stable --extract ) || ${failMsg}`
      );
    }
    const failOfficial =
      "echo '[e2e-ensure] Cursor official installer failed — set E2E_CURSOR_ENSURE_INSTALL_SH or E2E_CURSOR_INSTALL_STRATEGY=watzon'";
    return (
      `( set +e; export NO_COLOR=1; mkdir -p "$HOME/.local/bin"; ` +
      `curl -fsSL --connect-timeout 25 --max-time 300 --retry 2 --retry-delay 2 https://cursor.com/install | bash ) ` +
      `|| ${failOfficial}`
    );
  }
  return String(agent.ensureInstallSh ?? '').trim();
}

function buildCodexEnsureInstallSh(bin, env) {
  if (bin !== 'codex') return null;
  const spec = env.E2E_CODEX_NPM_SPEC?.trim() || '@openai/codex';
  return `npm install -g ${shellSingleQuoteBash(spec)} || echo '[e2e-ensure] npm install codex failed'`;
}

function buildEnsureSummaryScript(matrix) {
  const lines = [
    'echo "[e2e-ensure] summary:"',
  ];
  const seen = new Set();
  for (const a of matrix.agents ?? []) {
    const bin = String(a.binary ?? '').trim();
    if (!bin || seen.has(bin)) continue;
    seen.add(bin);
    const label = String(a.id ?? a.name ?? bin).replace(/'/g, `'\''`);
    if (bin === 'cursor') {
      lines.push(
        `if [ "$_e2e_cursor_incompat" -eq 1 ] && [ "\${_e2e_have_cf:-0}" -ne 1 ]; then`,
        `  echo "[e2e-ensure] ${label}: cursor incompatible (glibc too old; skipped)"`,
        `elif [ "\${_e2e_have_cf:-0}" -eq 1 ]; then`,
        `  echo "[e2e-ensure] ${label}: have cursor"`,
        `elif command -v agent >/dev/null 2>&1 || command -v cursor-agent >/dev/null 2>&1; then`,
        `  echo "[e2e-ensure] ${label}: have cursor (via agent/cursor-agent CLI)"`,
        `elif command -v cursor-installer >/dev/null 2>&1; then`,
        `  echo "[e2e-ensure] ${label}: have cursor (cursor-installer on PATH; run cursor-installer --update if needed)"`,
        `else`,
        `  echo "[e2e-ensure] ${label}: missing cursor"`,
        `fi`,
      );
      continue;
    }
    if (bin === 'qoder') {
      lines.push(
        `if command -v qoder >/dev/null 2>&1 || command -v qodercli >/dev/null 2>&1; then echo "[e2e-ensure] ${label}: have qoder/qodercli"; else echo "[e2e-ensure] ${label}: missing qoder/qodercli"; fi`,
      );
      continue;
    }
    const binEsc = bin.replace(/'/g, `'\''`);
    lines.push(
      `if command -v '${binEsc}' >/dev/null 2>&1; then echo "[e2e-ensure] ${label}: have ${binEsc}"; else echo "[e2e-ensure] ${label}: missing ${binEsc}"; fi`,
    );
  }
  return lines;
}

/** 生成远端 ensure 脚本：npm 安装缺失 CLI，cursor 改用 --version 真实探测。 */
export function buildEnsureAgentClisScript(matrix, env = process.env) {
  const cursorStrat = resolveE2eCursorInstallStrategy(env);
  const cursorSkipIfIncompat = (env.E2E_CURSOR_SKIP_IF_INCOMPAT ?? '1').trim() === '0' ? '0' : '1';
  const lines = [
    'set +euo pipefail',
    'export PATH="$HOME/.local/bin:$PATH"',
    `_E2E_CURSOR_STRAT=${shellSingleQuoteBash(cursorStrat)}`,
    `export _E2E_CURSOR_SKIP_IF_INCOMPAT=${shellSingleQuoteBash(cursorSkipIfIncompat)}`,
    '_e2e_cursor_incompat=0',
    '# 探测二进制是否可运行：0=OK, 2=glibc 不兼容, 1=其他失败。',
    '_e2e_cursor_runnable() {',
    '  _b="$1"',
    '  [ -n "$_b" ] || return 1',
    '  if [ ! -x "$_b" ] && ! command -v "$_b" >/dev/null 2>&1; then return 1; fi',
    '  _out=$("$_b" --version </dev/null 2>&1); _rc=$?',
    '  if [ "$_rc" -eq 0 ]; then return 0; fi',
    '  case "$_out" in',
    '    *GLIBC_*|*"not found"*|*"No such file or directory"*|*"cannot execute"*) return 2;;',
    '  esac',
    '  return 1',
    '}',
    'echo "[e2e-ensure] checking agent matrix CLIs (scripts/e2e/agent-matrix.json)"',
  ];

  const extra = env.E2E_EXTRA_ENSURE_BASH?.trim();
  if (extra) {
    if (extra.length > 10_000) {
      console.warn('[e2e] E2E_EXTRA_ENSURE_BASH exceeds 10 000 chars — verify no accidental injection');
    }
    lines.push('# E2E_EXTRA_ENSURE_BASH');
    lines.push(extra);
  }

  lines.push('if ! command -v npm >/dev/null 2>&1; then');
  lines.push('  echo "[e2e-ensure] npm not on PATH; skipping npm-based installs"');
  lines.push('else');
  lines.push('  _npfx="$(npm config get prefix 2>/dev/null || true)"');
  lines.push('  if [ -n "$_npfx" ] && [ -d "$_npfx/bin" ]; then export PATH="$_npfx/bin:$PATH"; fi');

  const forceCodex = env.E2E_CODEX_FORCE_ENSURE?.trim() === '1';
  const skipAgents = resolveProbeSkipAgents(env);

  for (const a of matrix.agents) {
    const bin = String(a.binary ?? '').trim();
    if (!bin) continue;
    if (skipAgents.has(bin.toLowerCase())) continue;
    const label = String(a.name ?? bin);
    let install = resolveEnsureInstallSh(a, env);
    const codexSh = buildCodexEnsureInstallSh(bin, env);
    if (codexSh) install = codexSh;

    lines.push(`  echo "[e2e-ensure] binary: ${bin} (${label})"`);

    if (bin === 'cursor') {
      lines.push('  _e2e_have_cf=0');
      lines.push('  _e2e_cf_probe() {');
      lines.push('    _cand="$1"');
      lines.push('    [ -n "$_cand" ] || return 1');
      lines.push('    _e2e_cursor_runnable "$_cand"');
      lines.push('    _rrc=$?');
      lines.push('    if [ "$_rrc" -eq 0 ]; then _e2e_have_cf=1; return 0; fi');
      lines.push('    if [ "$_rrc" -eq 2 ]; then _e2e_cursor_incompat=1; fi');
      lines.push('    return 1');
      lines.push('  }');
      lines.push('  if [ "$_E2E_CURSOR_STRAT" = "watzon" ]; then');
      lines.push(
        '    for _cp in "$HOME/.local/share/cursor/cursor/usr/bin/cursor" "$HOME/.cursor/cursor/usr/bin/cursor" "$(command -v cursor 2>/dev/null)"; do',
      );
      lines.push('      [ "$_e2e_have_cf" -eq 1 ] && break');
      lines.push('      _e2e_cf_probe "$_cp" || true');
      lines.push('    done');
      lines.push('  else');
      lines.push(
        '    # official: legacy AppImage `cursor` on PATH does not count — need Cursor Agent CLI that actually runs.',
      );
      lines.push(
        '    for _cp in "$HOME/.local/bin/agent" "$HOME/.local/bin/cursor-agent" "$(command -v agent 2>/dev/null)" "$(command -v cursor-agent 2>/dev/null)"; do',
      );
      lines.push('      [ "$_e2e_have_cf" -eq 1 ] && break');
      lines.push('      _e2e_cf_probe "$_cp" || true');
      lines.push('    done');
      lines.push(
        '    if [ "$_e2e_have_cf" -eq 0 ] && [ -d "$HOME/.local/share/cursor-agent/versions" ]; then',
      );
      lines.push(
        '      for _vdir in "$HOME/.local/share/cursor-agent/versions"/*/cursor-agent; do',
      );
      lines.push('        [ "$_e2e_have_cf" -eq 1 ] && break');
      lines.push('        _e2e_cf_probe "$_vdir" || true');
      lines.push('      done');
      lines.push('    fi');
      lines.push('  fi');
      lines.push('  if [ "$_e2e_have_cf" -eq 1 ]; then');
      lines.push(
        '    echo "[e2e-ensure] ok: cursor family (strategy=$_E2E_CURSOR_STRAT; verified via --version)"',
      );
      lines.push('  elif [ "$_e2e_cursor_incompat" -eq 1 ]; then');
      lines.push(
        '    echo "[e2e-ensure] cursor present but incompatible with host glibc; leaving extract untouched (set E2E_CURSOR_SKIP_IF_INCOMPAT=0 to fail loudly in probe)"',
      );
      lines.push('  else');
      if (install) {
        lines.push(`    echo "[e2e-ensure] installing ${label}..."`);
        lines.push(`    ${install}`);
      } else {
        lines.push(
          `    echo "[e2e-ensure] no ensureInstallSh for ${label}; install ${bin} manually or append E2E_EXTRA_ENSURE_BASH"`,
        );
      }
      lines.push('  fi');
      continue;
    }

    if (bin === 'codex' && forceCodex) {
      lines.push(`  echo "[e2e-ensure] E2E_CODEX_FORCE_ENSURE=1: reinstalling ${label}"`);
      if (install) {
        lines.push(`  ${install}`);
      } else {
        lines.push(`  echo "[e2e-ensure] no codex ensure command (internal error)"`);
      }
      continue;
    }

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
    '# official: always put Agent CLI first as `~/.local/bin/cursor` (PATH may still have legacy AppImage earlier)',
    'if [ "$_E2E_CURSOR_STRAT" != "watzon" ] && command -v agent >/dev/null 2>&1; then',
    '  mkdir -p "$HOME/.local/bin"',
    '  ln -sf "$(command -v agent)" "$HOME/.local/bin/cursor" && echo "[e2e-ensure] official: ~/.local/bin/cursor -> agent (overrides legacy shim order)"',
    'elif ! command -v cursor >/dev/null 2>&1 && command -v agent >/dev/null 2>&1; then',
    '  mkdir -p "$HOME/.local/bin"',
    '  ln -sf "$(command -v agent)" "$HOME/.local/bin/cursor" && echo "[e2e-ensure] linked ~/.local/bin/cursor -> agent (Agent CLI)"',
    'fi',
    '# Always fix wrong-depth path .../cursor/cursor/cursor when extract exists (watzon / legacy)',
    '_e2e_cursor_bin=""',
    'for _p in "$HOME/.local/share/cursor/cursor/usr/bin/cursor" "$HOME/.cursor/cursor/usr/bin/cursor"; do',
    '  if [ -x "$_p" ]; then',
    '    _e2e_cursor_runnable "$_p"',
    '    _prc=$?',
    '    if [ "$_prc" -eq 0 ]; then _e2e_cursor_bin="$_p"; break; fi',
    '    if [ "$_prc" -eq 2 ]; then _e2e_cursor_incompat=1; fi',
    '  fi',
    'done',
    'if [ -n "$_e2e_cursor_bin" ]; then',
    '  for _legacy_root in "$HOME/.local/share/cursor/cursor" "$HOME/.cursor/cursor"; do',
    '    if [ -d "$_legacy_root" ]; then',
    '      ln -sf "$_e2e_cursor_bin" "$_legacy_root/cursor" && echo "[e2e-ensure] compat symlink $_legacy_root/cursor -> $_e2e_cursor_bin"',
    '    fi',
    '  done',
    'fi',
    'if ! command -v cursor >/dev/null 2>&1; then',
    '  if [ -n "$_e2e_cursor_bin" ]; then',
    '    mkdir -p "$HOME/.local/bin"',
    '    ln -sf "$_e2e_cursor_bin" "$HOME/.local/bin/cursor" && echo "[e2e-ensure] linked ~/.local/bin/cursor -> $_e2e_cursor_bin"',
    '  elif [ "$_e2e_cursor_incompat" -eq 1 ]; then',
    '    echo "[e2e-ensure] skip cursor shim creation: extracted binary incompatible with host glibc"',
    '  elif ! command -v agent >/dev/null 2>&1; then',
    '    echo "[e2e-ensure] no cursor/agent on PATH and no extracted Cursor binary under ~/.local/share/cursor or ~/.cursor"',
    '  fi',
    'fi',
  );

  lines.push(...buildEnsureSummaryScript(matrix));
  return `${lines.join('\n')}\n`;
}

/**
 * Parse E2E_PROBE_SKIP_AGENTS: comma-separated list of agent binary names to skip.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Set<string>}
 */
export function resolveProbeSkipAgents(env = process.env) {
  const raw = (env?.E2E_PROBE_SKIP_AGENTS ?? '').toString().trim();
  if (!raw) return new Set();
  return new Set(raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}

/**
 * One isolated bash -s per agent (stdin from decoded pipe, not SSH session).
 * @param {{ agents: object[] }} matrix
 * @param {NodeJS.ProcessEnv} [env]
 */
export function buildMatrixProbeScript(matrix, env = process.env) {
  const cursorSkipIfIncompat = (env.E2E_CURSOR_SKIP_IF_INCOMPAT ?? '1').trim() === '0' ? '0' : '1';
  const skipAgents = resolveProbeSkipAgents(env);
  const lines = [
    'set +e -o pipefail',
    'export PATH="$HOME/.local/bin:$PATH"',
    `export _E2E_CURSOR_SKIP_IF_INCOMPAT=${shellSingleQuoteBash(cursorSkipIfIncompat)}`,
    'cd "$HOME" || true',
    'echo "[e2e-probe] running one isolated bash per agent (order = agent-matrix.json)"',
  ];

  for (const a of matrix.agents) {
    const block = String(a.defaultProbeSh ?? '').trim();
    if (!block) continue;
    const bin = String(a.binary ?? '').trim();
    const label = String(a.name ?? bin ?? 'agent').replace(/'/g, `'\\''`);
    const binEsc = bin.replace(/'/g, `'\\''`);
    if (skipAgents.has(bin.toLowerCase())) {
      lines.push(`echo "[e2e-probe] >>> SKIP: ${label} (binary=${binEsc}) — E2E_PROBE_SKIP_AGENTS"`);
      continue;
    }
    const b64 = Buffer.from(`${block}\n`, 'utf8').toString('base64');
    lines.push(`echo "[e2e-probe] >>> start: ${label} (binary=${binEsc})"`);
    lines.push(`echo "[e2e-probe] command:"; printf '%s' '${b64}' | base64 -d | sed 's/^/  /'`);
    lines.push(`echo ""`);
    lines.push(
      `printf '%s' '${b64}' | base64 -d | bash --norc --noprofile -s; _st=$?; ` +
        `if [ "$_st" -eq 0 ]; then echo "[e2e-probe] <<< end: ${label} (exit 0)"; ` +
        `else echo "[e2e-probe] <<< end: ${label} (exit \${_st}, non-fatal)"; fi`,
    );
  }

  lines.push('echo "[e2e-probe] all matrix blocks finished"');
  return `${lines.join('\n')}\n`;
}
