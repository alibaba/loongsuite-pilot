import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SCRIPT_PATH = path.resolve('scripts/loongsuite-pilot.sh');
const POWERSHELL_SCRIPT_PATH = path.resolve('scripts/loongsuite-pilot.ps1');
let tempDir;
let sourcePath;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-service-reregistration-'));
  sourcePath = path.join(tempDir, 'loongsuite-pilot-functions.sh');
  const script = fs.readFileSync(SCRIPT_PATH, 'utf8');
  const dispatchOffset = script.indexOf('# ---- Dispatch ----');
  expect(dispatchOffset).toBeGreaterThan(0);
  fs.writeFileSync(sourcePath, script.slice(0, dispatchOffset), 'utf8');
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

function runShell(body) {
  const homeDir = path.join(tempDir, `home-${Math.random().toString(16).slice(2)}`);
  const dataDir = path.join(homeDir, 'data');
  const cacheDir = path.join(homeDir, 'cache');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  return spawnSync('bash', ['-c', `source "$1"\n${body}`, 'pilot-service-test', sourcePath], {
    cwd: tempDir,
    env: {
      ...process.env,
      HOME: homeDir,
      LOONGSUITE_PILOT_DATA_DIR: dataDir,
      LOONGSUITE_PILOT_CACHE_DIR: cacheDir,
    },
    encoding: 'utf8',
    timeout: 10_000,
  });
}

const commonMocks = String.raw`
uname() { echo Linux; }
whoami() { echo pilot_test_user; }
pkill() { return 0; }
sleep() { return 0; }
stop_pid_file() { return 0; }
sync_bootstrap_scripts() { return 0; }
setsid() { return 0; }
ensure_dirs() { mkdir -p "$LOG_DIR" "$BOOTSTRAP_DIR"; }
`;

describe.runIf(process.platform !== 'win32')('service-specific restart self-healing', () => {
  it('uses non-interactive sudo only inside restart self-healing', () => {
    const result = runShell(String.raw`
${commonMocks}
id() { echo 1000; }
sudo() { printf '%s\n' "$*" >> "$DATA_DIR/sudo-calls"; }
updater_running=false
updater_process_exists() { [ "$updater_running" = true ]; }
detect_init_system() { echo systemd-system; }
autostart_install_updater_only() {
  maybe_sudo nested-installer-command
  updater_running=true
}

echo initd > "$INIT_TYPE_FILE"
cmd_restart_updater
maybe_sudo ordinary-command
[ "$(cat "$DATA_DIR/sudo-calls")" = $'-n nested-installer-command\nordinary-command' ]
`);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('updater self-healed: registered as systemd-system');

    const script = fs.readFileSync(SCRIPT_PATH, 'utf8');
    expect(script).toContain('_PILOT_SUDO_NONINTERACTIVE=true autostart_install_collector_only');
    expect(script).toContain('_PILOT_SUDO_NONINTERACTIVE=true autostart_install_updater_only');
  });

  it('propagates critical service-specific installer failures inside an if condition', () => {
    const result = runShell(String.raw`
${commonMocks}
detect_init_system() { echo systemd-system; }
_write_systemd_system_updater_unit() { return 0; }
maybe_sudo() {
  if [ "$2" = enable ]; then
    return 1
  fi
  return 0
}

if autostart_install_updater_only false; then
  exit 1
fi
[ ! -e "$INIT_TYPE_FILE" ]
`);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it('propagates real init.d writer install failures after cleaning temporary files', () => {
    const result = runShell(String.raw`
${commonMocks}
detect_init_system() { echo initd; }
resolve_user_home() { echo "$DATA_DIR/daemon-home"; }
maybe_sudo() {
  if [ "$1" = install ]; then
    printf '%s\n' "$4" >> "$DATA_DIR/initd-temp-paths"
    return 23
  fi
  return 0
}

if autostart_install_collector_only false; then
  exit 1
fi
[ ! -e "$INIT_TYPE_FILE" ]
if autostart_install_updater_only false; then
  exit 1
fi
[ ! -e "$INIT_TYPE_FILE" ]
[ "$(wc -l < "$DATA_DIR/initd-temp-paths" | tr -d '[:space:]')" = 2 ]
while IFS= read -r tmp_path; do
  [ ! -e "$tmp_path" ]
done < "$DATA_DIR/initd-temp-paths"
`);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it('normalizes legacy systemd state before updater self-healing', () => {
    const result = runShell(String.raw`
${commonMocks}
id() {
  if [ "\${1:-}" = -u ]; then
    echo 1000
  else
    command id "$@"
  fi
}
systemctl() { return 0; }
maybe_sudo() { "$@"; }
maybe_sudo_n() { "$@"; }
updater_running=false
updater_process_exists() { [ "$updater_running" = true ]; }
autostart_install_updater_only() {
  detect_init_system false > "$DATA_DIR/selected-init"
  updater_running=true
}

echo systemd > "$INIT_TYPE_FILE"
[ "$(detect_init_system false)" = systemd-system ]
cmd_restart_updater
[ "$(cat "$DATA_DIR/selected-init")" = systemd-system ]
`);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('updater self-healed: registered as systemd-system');
  });

  it('repairs updater registration after collector changes unknown init-type to initd', () => {
    const result = runShell(String.raw`
${commonMocks}
collector_running=false
updater_running=false
is_running() { [ "$collector_running" = true ]; }
updater_process_exists() { [ "$updater_running" = true ]; }
detect_init_system() { echo initd; }
autostart_install_collector_only() {
  echo collector >> "$DATA_DIR/registrations"
  collector_running=true
  echo initd > "$INIT_TYPE_FILE"
}
autostart_install_updater_only() {
  echo updater >> "$DATA_DIR/registrations"
  updater_running=true
  echo initd > "$INIT_TYPE_FILE"
}

echo unknown > "$INIT_TYPE_FILE"
cmd_restart_collector
[ "$(cat "$INIT_TYPE_FILE")" = initd ]
cmd_restart_updater
[ "$(cat "$DATA_DIR/registrations")" = $'collector\nupdater' ]
`);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('collector self-healed: registered as initd');
    expect(result.stdout).toContain('updater self-healed: registered as initd');
  });

  it('re-registers updater when a concrete service starts but fails liveness', () => {
    const result = runShell(String.raw`
${commonMocks}
updater_running=false
updater_process_exists() { [ "$updater_running" = true ]; }
systemctl() { return 0; }
detect_init_system() { echo systemd-user; }
autostart_install_updater_only() {
  echo called > "$DATA_DIR/updater-reregistered"
  updater_running=true
}

echo systemd-user > "$INIT_TYPE_FILE"
cmd_restart_updater
[ -f "$DATA_DIR/updater-reregistered" ]
`);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('service manager reported success but updater process not found');
    expect(result.stdout).toContain('updater self-healed: registered as systemd-user');
  });

  it('re-registers updater when the service-manager start command fails', () => {
    const result = runShell(String.raw`
${commonMocks}
updater_running=false
updater_process_exists() { [ "$updater_running" = true ]; }
systemctl() {
  case " $* " in
    *" start "*) return 1 ;;
    *) return 0 ;;
  esac
}
detect_init_system() { echo systemd-user; }
autostart_install_updater_only() {
  echo called > "$DATA_DIR/updater-reregistered"
  updater_running=true
}

echo systemd-user > "$INIT_TYPE_FILE"
cmd_restart_updater
[ -f "$DATA_DIR/updater-reregistered" ]
`);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('updater self-healed: registered as systemd-user');
  });

  it('does not fall back to unmanaged processes for a concrete service manager', () => {
    const result = runShell(String.raw`
${commonMocks}
collector_running=false
updater_running=false
is_running() { [ "$collector_running" = true ]; }
updater_process_exists() { [ "$updater_running" = true ]; }
detect_init_system() { echo none; }
autostart_install_collector_only() { return 1; }
autostart_install_updater_only() { return 1; }
nohup() { echo called >> "$DATA_DIR/nohup-called"; }

echo initd > "$INIT_TYPE_FILE"
if (cmd_restart_collector); then exit 1; fi
if cmd_restart_updater; then exit 1; fi
[ ! -e "$DATA_DIR/nohup-called" ]
`);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toContain('Service manager failed to restart collector (init_type=initd)');
    expect(result.stderr).toContain('Service manager failed to restart updater (init_type=initd)');
  });

  it('preserves the legacy updater fallback when no service manager can be detected', () => {
    const result = runShell(String.raw`
${commonMocks}
updater_process_exists() { return 0; }
detect_init_system() { echo none; }
autostart_install_updater_only() { return 1; }
resolve_node() { echo /bin/true; }

echo unknown > "$INIT_TYPE_FILE"
mkdir -p "$BOOTSTRAP_DIR"
touch "$BOOTSTRAP_DIR/updater-daemon.js"
cmd_restart_updater
`);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('updater restarted (nohup fallback, self-heal failed)');
  });
});

describe('Windows Task Scheduler restart self-healing', () => {
  const script = fs.readFileSync(POWERSHELL_SCRIPT_PATH, 'utf8');

  function commandBody(name, nextSection) {
    const start = script.indexOf(`function ${name} {`);
    const end = script.indexOf(`# CMD: ${nextSection}`, start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return script.slice(start, end);
  }

  it.each([
    ['Cmd-RestartCollector', 'restart-updater', 'Install-CollectorTask'],
    ['Cmd-RestartUpdater', 'status', 'Install-UpdaterTask'],
  ])('%s re-registers a missing concrete task before considering legacy fallback', (name, nextSection, installCommand) => {
    const body = commandBody(name, nextSection);
    const selfHeal = body.indexOf('init-type is shared by collector/updater');
    const registration = body.indexOf(installCommand, selfHeal);
    const fallbackGuard = body.indexOf('$initType -in @("background", "unknown", "")', selfHeal);

    expect(selfHeal).toBeGreaterThanOrEqual(0);
    expect(registration).toBeGreaterThan(selfHeal);
    expect(fallbackGuard).toBeGreaterThan(registration);
    expect(body.match(/\$initType -in/g)).toHaveLength(1);
    expect(body.slice(registration, fallbackGuard)).toContain('Get-TaskRunning');
    expect(body.slice(fallbackGuard)).toContain('Start-Process');
    expect(body.slice(fallbackGuard)).toContain('Service manager failed to restart');
  });
});
