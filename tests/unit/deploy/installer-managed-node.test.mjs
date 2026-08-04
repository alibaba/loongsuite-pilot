// Unit tests for the managed Node.js runtime logic embedded in the installers.
//
// Coverage follows the design doc "测试计划-单测":
//   - installer 平台/arch 映射 (managed_node_platform)
//   - musl 检测 (managed_node_is_musl)
//   - sha256 不匹配即中止 (ensure_managed_node / ensure_node_modules abort before touching disk)
//   - 下载失败回退 (both functions return non-zero so the installer falls back)
//   - 幂等复用 (existing runtime / matching marker skips download)
//
// The bash functions under test are extracted from the sh installer (see
// INSTALLER_SH below) between the `# >>> managed-node-runtime >>>` /
// `# <<< managed-node-runtime <<<` markers and executed in a bash subprocess
// with uname/curl/ls/ldd stubbed via shell functions (bash functions shadow
// PATH binaries). Fixtures are real
// tar.gz archives with real sha256 checksums served by the curl stub.
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { resolve } from 'node:path';

// The managed-node-runtime block is byte-identical across the sh installer
// variants; installer-opensource.sh is the fallback source in the open-source
// repo where installer.sh does not exist.
const INSTALLER_SH = ['installer.sh', 'installer-opensource.sh']
  .map(f => resolve('deploy', f))
  .find(existsSync);
const sh = readFileSync(INSTALLER_SH, 'utf-8');
const START = '# >>> managed-node-runtime >>>';
const END = '# <<< managed-node-runtime <<<';
const block = sh.slice(sh.indexOf(START), sh.indexOf(END) + END.length);
if (!block.includes('ensure_managed_node()') || !block.includes('ensure_node_modules()')) {
  throw new Error(`managed-node-runtime block not found in ${INSTALLER_SH}`);
}

// Runs `body` in a bash harness with the managed-node block sourced and
// platform/download helpers stubbed. The bash process exits with the status of
// the last command in `body`, so a failing function call fails the run.
function runBash(body, { env = {}, fixture = null } = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'managed-node-test-'));
  const ossDir = path.join(tmp, 'oss');
  mkdirSync(ossDir, { recursive: true });
  if (fixture) fixture(ossDir);
  const posix = (p) => p.replace(/\\/g, '/');
  try {
    writeFileSync(path.join(tmp, 'block.sh'), block);
    const harness = `
set -uo pipefail
source "${posix(path.join(tmp, 'block.sh'))}"

FAKE_OSS="$1"
DOWNLOAD_LOG="$FAKE_OSS/.downloads"
NODE_VERSION="9.9.9"
NODE_DEPS_BASE="file://oss/deps/node"
NODE_MODULES_BASE="file://oss/deps/node-modules"
DATA_DIR="${posix(tmp)}/data"
PERMANENT_DIR="${posix(tmp)}/perm"
mkdir -p "$DATA_DIR" "$PERMANENT_DIR"

curl() {
  local url="" dest=""
  while [ $# -gt 0 ]; do
    case "$1" in
      -o|-O) dest="$2"; shift 2 ;;
      -*) shift ;;
      *) url="$1"; shift ;;
    esac
  done
  echo "$url" >> "$DOWNLOAD_LOG"
  local f="\${url##*/}"
  if [ -f "$FAKE_OSS/$f" ]; then cp "$FAKE_OSS/$f" "$dest"; return 0; fi
  return 22
}
wget() { return 127; }

uname() {
  case "$1" in
    -s) echo "$FAKE_OS" ;;
    -m) echo "$FAKE_ARCH" ;;
  esac
}

ls() {
  local a
  for a in "$@"; do
    case "$a" in
      /lib/ld-musl-*) [ -n "\${FAKE_MUSL_LD:-}" ] && { echo "$a"; return 0; } ;;
    esac
  done
  return 1
}
ldd() {
  if [ -n "\${FAKE_MUSL_LDD:-}" ]; then echo "musl libc (x86_64)"; else echo "ldd (GNU libc) 2.39"; fi
}

${body}
`;
    const scriptPath = path.join(tmp, 'harness.sh');
    writeFileSync(scriptPath, harness);
    const r = spawnSync('bash', [scriptPath, ossDir], {
      encoding: 'utf-8',
      env: { ...process.env, FAKE_OS: 'Darwin', FAKE_ARCH: 'arm64', ...env },
    });
    if (r.status !== 0) {
      const e = new Error(`harness exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      e.stderr = r.stderr;
      e.status = r.status;
      throw e;
    }
    return { out: r.stdout, err: r.stderr, ossDir };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function runBashFail(body, opts = {}) {
  try {
    runBash(body, opts);
    return { failed: false, err: '' };
  } catch (e) {
    return { failed: true, err: String(e.stderr || '') };
  }
}

// Build a fake node dist tarball whose bin/node reports $version.
function makeNodeTarball(ossDir, version, osName, arch) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'node-fixture-'));
  try {
    const binDir = path.join(tmp, `node-v${version}-${osName}-${arch}`, 'bin');
    mkdirSync(binDir, { recursive: true });
    const bin = path.join(binDir, 'node');
    writeFileSync(bin, `#!/bin/sh\necho "v${version}"\n`);
    chmodSync(bin, 0o755);
    const archive = `node-v${version}-${osName}-${arch}.tar.gz`;
    execFileSync('tar', ['-czf', path.join(ossDir, archive), '-C', tmp, `node-v${version}-${osName}-${arch}`]);
    const sum = execFileSync('shasum', ['-a', '256', path.join(ossDir, archive)], { encoding: 'utf-8' }).split(/\s+/)[0];
    writeFileSync(path.join(ossDir, 'SHASUMS256.txt'), `${sum}  ${archive}\n`);
    return archive;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function makeModulesTarball(ossDir, osName, arch) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'modules-fixture-'));
  try {
    const modDir = path.join(tmp, 'node_modules', 'fake-dep');
    mkdirSync(modDir, { recursive: true });
    writeFileSync(path.join(modDir, 'index.js'), 'module.exports = 1;\n');
    const archive = `node-modules-${osName}-${arch}.tar.gz`;
    execFileSync('tar', ['-czf', path.join(ossDir, archive), '-C', tmp, 'node_modules']);
    const sum = execFileSync('shasum', ['-a', '256', path.join(ossDir, archive)], { encoding: 'utf-8' }).split(/\s+/)[0];
    writeFileSync(path.join(ossDir, 'SHASUMS256.txt'), `${sum}  ${archive}\n`);
    return archive;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe('managed_node_platform mapping', () => {
  const cases = [
    ['Darwin', 'arm64', 'darwin arm64'],
    ['Darwin', 'x86_64', 'darwin x64'],
    ['Linux', 'x86_64', 'linux x64'],
    ['Linux', 'aarch64', 'linux arm64'],
    ['MINGW64_NT-10.0', 'x86_64', 'win x64'],
  ];
  for (const [os, arch, expected] of cases) {
    it(`maps ${os}/${arch} -> ${expected}`, () => {
      const { out } = runBash('managed_node_platform', { env: { FAKE_OS: os, FAKE_ARCH: arch } });
      expect(out.trim()).toBe(expected);
    });
  }

  it('rejects win-arm64 (no managed artifact)', () => {
    const res = runBashFail('managed_node_platform', { env: { FAKE_OS: 'MINGW64_NT-10.0', FAKE_ARCH: 'aarch64' } });
    expect(res.failed).toBe(true);
    expect(res.err).toMatch(/win-arm64/);
  });

  it('rejects unsupported architecture', () => {
    const res = runBashFail('managed_node_platform', { env: { FAKE_OS: 'Linux', FAKE_ARCH: 'riscv64' } });
    expect(res.failed).toBe(true);
  });

  it('rejects unknown OS', () => {
    const res = runBashFail('managed_node_platform', { env: { FAKE_OS: 'SunOS', FAKE_ARCH: 'x86_64' } });
    expect(res.failed).toBe(true);
  });
});

describe('musl detection', () => {
  it('detects musl via /lib/ld-musl-*', () => {
    const { out } = runBash('managed_node_is_musl && echo musl || echo glibc', {
      env: { FAKE_OS: 'Linux', FAKE_ARCH: 'x86_64', FAKE_MUSL_LD: '1' },
    });
    expect(out.trim()).toBe('musl');
  });

  it('detects musl via ldd output', () => {
    const { out } = runBash('managed_node_is_musl && echo musl || echo glibc', {
      env: { FAKE_OS: 'Linux', FAKE_ARCH: 'x86_64', FAKE_MUSL_LDD: '1' },
    });
    expect(out.trim()).toBe('musl');
  });

  it('reports glibc when neither marker is present', () => {
    const { out } = runBash('managed_node_is_musl && echo musl || echo glibc', {
      env: { FAKE_OS: 'Linux', FAKE_ARCH: 'x86_64' },
    });
    expect(out.trim()).toBe('glibc');
  });

  it('ensure_managed_node falls back on musl (returns non-zero with explicit notice)', () => {
    const res = runBashFail('ensure_managed_node', {
      env: { FAKE_OS: 'Linux', FAKE_ARCH: 'x86_64', FAKE_MUSL_LD: '1' },
    });
    expect(res.failed).toBe(true);
    expect(res.err).toMatch(/musl/);
  });
});

describe('ensure_managed_node', () => {
  it('downloads, verifies sha256, extracts and prints the managed node path', () => {
    const body = `
out=$(ensure_managed_node) || { echo "ENSURE_FAILED"; exit 1; }
echo "PATH=$out"
[ -x "$out" ] || { echo "NOT_EXECUTABLE"; exit 1; }
"$out" --version
`;
    const { out, err } = runBash(body, {
      fixture: (oss) => makeNodeTarball(oss, '9.9.9', 'darwin', 'arm64'),
    });
    expect(out).toContain(path.posix.join('runtime', 'node-v9.9.9-darwin-arm64', 'bin', 'node'));
    expect(out).toContain('v9.9.9');
    expect(err).toContain('Downloading managed Node.js v9.9.9 (darwin-arm64)');
    expect(err).not.toContain('No such file or directory');
  });

  it('aborts on sha256 mismatch without extracting', () => {
    const body = `
if ensure_managed_node >/dev/null 2>&1; then echo "SHOULD_HAVE_FAILED"; exit 1; fi
[ -d "$DATA_DIR/runtime/node-v9.9.9-darwin-arm64" ] && { echo "EXTRACTED_ANYWAY"; exit 1; }
echo OK
`;
    const { out } = runBash(body, {
      fixture: (oss) => {
        makeNodeTarball(oss, '9.9.9', 'darwin', 'arm64');
        writeFileSync(path.join(oss, 'SHASUMS256.txt'),
          'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef  node-v9.9.9-darwin-arm64.tar.gz\n');
      },
    });
    expect(out.trim()).toBe('OK');
  });

  it('fails when the download is unavailable (fallback trigger)', () => {
    const res = runBashFail('ensure_managed_node >/dev/null 2>&1');
    expect(res.failed).toBe(true);
  });

  it('is idempotent: reuses an existing matching runtime without downloading', () => {
    const body = `
mkdir -p "$DATA_DIR/runtime/node-v9.9.9-darwin-arm64/bin"
cat > "$DATA_DIR/runtime/node-v9.9.9-darwin-arm64/bin/node" <<'NODE_EOF'
#!/bin/sh
echo "v9.9.9"
NODE_EOF
chmod +x "$DATA_DIR/runtime/node-v9.9.9-darwin-arm64/bin/node"
out=$(ensure_managed_node) || exit 1
echo "PATH=$out"
downloads=$(wc -l < "$DOWNLOAD_LOG" 2>/dev/null | tr -d ' ')
echo "DOWNLOADS=\${downloads:-0}"
`;
    const { out } = runBash(body);
    expect(out).toContain(path.posix.join('runtime', 'node-v9.9.9-darwin-arm64', 'bin', 'node'));
    expect(out).toContain('DOWNLOADS=0');
  });
});

describe('ensure_node_modules', () => {
  it('downloads, verifies and installs prebuilt node_modules with a version marker', () => {
    const body = `
ensure_node_modules "1.2.3" || { echo "ENSURE_FAILED"; exit 1; }
[ -f "$PERMANENT_DIR/node_modules/fake-dep/index.js" ] || { echo "MISSING_MODULE"; exit 1; }
cat "$PERMANENT_DIR/node_modules/.pilot-modules-version"
`;
    const { out, err } = runBash(body, {
      fixture: (oss) => makeModulesTarball(oss, 'darwin', 'arm64'),
    });
    expect(out.trim()).toBe('1.2.3 darwin arm64');
    expect(err).toContain('Downloading prebuilt node_modules (darwin-arm64, app v1.2.3)');
    expect(err).not.toContain('No such file or directory');
  });

  it('is idempotent when the marker matches', () => {
    const body = `
mkdir -p "$PERMANENT_DIR/node_modules"
echo "1.2.3 darwin arm64" > "$PERMANENT_DIR/node_modules/.pilot-modules-version"
ensure_node_modules "1.2.3" || exit 1
downloads=$(wc -l < "$DOWNLOAD_LOG" 2>/dev/null | tr -d ' ')
echo "DOWNLOADS=\${downloads:-0}"
`;
    const { out } = runBash(body);
    expect(out).toContain('DOWNLOADS=0');
  });

  it('fails when the download is unavailable (npm install fallback trigger)', () => {
    const res = runBashFail('ensure_node_modules "1.2.3" >/dev/null 2>&1');
    expect(res.failed).toBe(true);
  });

  it('fails on sha256 mismatch without touching the target dir', () => {
    const body = `
if ensure_node_modules "1.2.3" >/dev/null 2>&1; then echo "SHOULD_HAVE_FAILED"; exit 1; fi
[ -d "$PERMANENT_DIR/node_modules" ] && { echo "INSTALLED_ANYWAY"; exit 1; }
echo OK
`;
    const { out } = runBash(body, {
      fixture: (oss) => {
        makeModulesTarball(oss, 'darwin', 'arm64');
        writeFileSync(path.join(oss, 'SHASUMS256.txt'),
          'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef  node-modules-darwin-arm64.tar.gz\n');
      },
    });
    expect(out.trim()).toBe('OK');
  });
});
