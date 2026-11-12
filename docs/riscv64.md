# Linux RISC-V64

English | [简体中文](zh-CN/riscv64.md)

This branch adds Linux `riscv64` installation, service management and installed-artifact acceptance. It follows the current main branch's `node:sqlite` implementation (#444). The changes are unreleased: use the package and installer from the same checkout until a release includes them. Local validation, upstream CI and publication are separate results.

## Runtime and dependency requirements

Pilot requires a RISC-V Node.js runtime that can load `node:sqlite` without extra flags, plus npm. Node 22.13+ in the 22 series, Node 23.4+ in the 23 series, or a newer suitable release can satisfy this; the actual capability probe determines acceptance. Node 18/20, earlier 22/23 releases, and builds without SQLite are rejected before installation or upgrade activation. Check the intended runtime directly:

```bash
uname -m
node -p 'process.platform + "/" + process.arch + " " + process.version'
node -e "require('node:sqlite')"
npm --version
```

Both architecture probes must identify `riscv64`. The installer rejects a selected Node of the wrong architecture before replacing the runtime pin. This change does not download a managed RISC-V runtime. Supply a suitable system Node/npm on PATH.

SQLite is provided by Node, so Pilot no longer compiles or loads the `sqlite3` native addon. The `sqlite3` dependency points to `compat/sqlite3`, an empty JavaScript shim that preserves older updaters' `require('sqlite3')` check. It does not implement a SQLite API. Keep it in the public artifact. `zstd-napi` has been removed from current main and is not installed. No addon compiler or N-API target selection is required for this installation path.

Missing builtin SQLite is a startup failure on every architecture. There is no SQLite-disabled collector mode: startup records the fatal diagnostic, and failed upgrade validation leaves the previous version active. Repair by choosing a Node binary with builtin SQLite, then rerun the installer with `--prefer-system-node`. An older Node being able to run the previous PR's Hook collection does not establish compatibility with this implementation. The project's stated Node 18+ scope needs to be reconciled with this upstream requirement before claiming Node 18 support.

## Acceptance environment and limits

| Component | Locked acceptance environment |
| --- | --- |
| System | Full-system QEMU 8.2.2, Ubuntu 24.04.4 image build 20260826, glibc 2.39, Linux riscv64 |
| Resources | 4 vCPU, 8 GiB RAM, 24 GiB writable disk, systemd-user with linger |
| Pilot runtime | Node 22.22.2 from Node.js unofficial-builds; experimental architecture binary |
| Negative runtime | Node 18.20.8 and Node 22 with SQLite disabled; rejection only |
| Agent | Actual bundled Qwen Code CLI 0.23.2 with a local deterministic OpenAI-compatible model server |
| Collection | Installed Hook → input → normalization → JSONL, strict validation of newly collected events |
| SQLite | Actual builtin read-only queries and the production reader compiled from the same source, including 1,501 paged rows and event-loop yielding |

Agent requirements are independent of Pilot's. Qwen 0.23.2 uses Node 22; its optional PTY/audio/image addons are omitted for noninteractive acceptance. The experimental RISC-V Node builds do not imply official architecture support. musl, openEuler, physical boards, other Agent binaries, external live models and SLS/HTTP/OTLP delivery need separate validation. systemd-system templates have regression tests; full guest service acceptance uses systemd-user. No RISC-V prebuilt node_modules archive is introduced.

## Install a branch artifact

On a development machine with suitable Node/npm:

```bash
npm ci --ignore-scripts
bash deploy/package-opensource.sh --output /tmp/loongsuite-pilot-riscv64.tar.gz
sha256sum /tmp/loongsuite-pilot-riscv64.tar.gz
```

Transfer the archive and this checkout's `deploy/installer-opensource.sh` to the target, then verify the archive against the recorded SHA256. With suitable RISC-V Node/npm on PATH and an Agent already installed:

```bash
bash ./installer-opensource.sh install \
  --package-url file:///tmp/loongsuite-pilot-riscv64.tar.gz \
  --prefer-system-node --agents qwen-code-cli
loongsuite-pilot status
loongsuite-pilot info
loongsuite-pilot restart
```

For a custom data directory, add `--data-dir /absolute/path/to/pilot-data`, and set `LOONGSUITE_PILOT_DATA_DIR` to that path for later CLI calls. systemd units carry the config, data and cache paths, including access to the runtime pin next to the configuration. Public manual upgrades still require the default cache directory `~/.loongsuite-pilot`; a custom data directory is a separate setting.

systemd working directories preserve spaces, interior quotes/backslashes and literal `%`. Paths containing CR/LF, ending in a backslash, or ending in whitespace are rejected before writing any unit. `WorkingDirectory` uses a literal path parser, so surrounding its value with quotes would change the path. Choose a supported absolute cache path if this validation fails.

## Recovery and troubleshooting

- If `node -e "require('node:sqlite')"` fails, replace the selected Node runtime with a suitable RISC-V build. Rebuilding the old sqlite3 addon does not repair a missing builtin.
- For dependency installation failure, preserve the installer's output and check registry access. JavaScript dependency failure fails installation; it is not reported as a degraded success.
- For service failures, inspect `logs/last-restart-failure-collector.json`, `logs/last-startup-crash.json`, `daemon.fatal` and `journalctl --user -u loongsuite-pilot.service`. Restart commands clear old restart markers on entry, record failed stages and wait for a stable process.
- If deployment fails before a candidate is activated, `current` already names the preserved version. Recovery restarts that version. If its restart fails, inspect `loongsuite-pilot logs` and run `loongsuite-pilot start`; an extra rollback could switch to an older payload.

Published releases use `loongsuite-pilot upgrade --version <version>` and `loongsuite-pilot rollback`. Before publication, acceptance redirects only the public installer download to a pinned local file and exercises the real CLI with local A/B/failing packages. These artificial versions are never published. Public packages omit the background updater daemon; rollback accepts that layout. Background updater behavior has separate unit/integration coverage.

## Reproduce the guest run and CI

On an Ubuntu host with Node/npm and Python 3.11+:

```bash
sudo apt-get install -y qemu-system-misc qemu-utils xorriso openssh-client python3 zip
npm ci --ignore-scripts
python3 scripts/riscv64/fresh-run.py \
  --work-dir e2e-artifacts/riscv64-fresh-01 \
  --cache-dir e2e-artifacts/riscv64-cache
```

Use a new work directory. `scripts/riscv64/environment.lock.json` pins guest images, runtime downloads and the real Agent; cached inputs are checked again before execution. The runner builds the public artifact and production SQLite reader, records their hashes and the source commit/patch hash, creates a fresh writable guest disk, and archives results on success or failure. An uncommitted checkout is recorded as dirty. Apt package versions are captured, not pinned.

The nine mandatory `--case all` checks cover installation; systemd lifecycle and injected startup failure; download/archive/architecture/dependency/same-version reinstall boundaries; upgrade/rollback with checkpoint continuity; synthetic collection; real Qwen collection; builtin SQLite and read-only paged production queries; unsupported-runtime rejection with preserved runtime pin/version/live PID; and real Agent collection after recovery. Node 18 is a negative probe only. The compiled production reader is a supplemental test artifact, not a new public API. The subprocess timeout check tests acceptance process-group cleanup, not a production native compiler.

Individual cases use `--artifacts <new-directory>` and `--data-dir <installed-data-directory>`; `all` also requires the installer, A/B/failing packages, Agent entry/runtime, Node18 and compiled SQLite reader. These cases stop services and inject faults: use a disposable guest. The runner stops its VM after evidence collection; `--keep-guest` retains it for diagnosis. Inspect a retained guest with its effective manifest:

```bash
bash scripts/riscv64/run-qemu.sh ssh \
  --work-dir e2e-artifacts/riscv64-fresh-01 \
  --manifest e2e-artifacts/riscv64-fresh-01/environment.lock.json -- uname -m
```

`.github/workflows/riscv64.yml` invokes the same fresh-run entry for relevant PRs, main/master updates and manual runs, including compatibility-shim changes. It uploads logs, manifests and the public package even on failure. The release workflow waits for this check before publication. Main CI uses Node 22/23/24; the RISC-V guest uses the pinned Node22 binary. Workflow definitions and local evidence alone do not establish a passed upstream Actions run.
