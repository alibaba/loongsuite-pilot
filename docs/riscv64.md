# Linux RISC-V64

English | [简体中文](zh-CN/riscv64.md)

This branch adds Linux `riscv64` installation and native dependency handling. The changes have not been published to the public installer endpoint. Use the installer and package from the same checkout until a release includes them. The fresh-run entry described below archives command results and guest evidence, including failures; local validation, upstream CI and release status are separate.

## Verified scope

| Component | Environment exercised |
| --- | --- |
| System | Full-system QEMU 8.2.2, Ubuntu 24.04.4 image build 20260826, glibc 2.39, Linux riscv64 |
| Guest resources | 4 vCPU, 8 GiB RAM, 24 GiB writable disk, systemd-user with linger |
| Pilot runtime | Node 22.22.2 and Node 18.20.8 from Node.js unofficial-builds; experimental binaries, not official architecture support guarantees |
| Toolchain | GCC 13.3.0, Python 3.12.3; npm 10.9.7 uses its bundled node-gyp 11.5.0 with optional packages omitted |
| Native dependencies | sqlite3 5.1.7 built with N-API 6; zstd-napi 0.0.12 built with N-API 8 |
| Agent | Actual bundled Qwen Code CLI 0.23.2, using its own Node 22 runtime and a deterministic local OpenAI-compatible model server |
| Collection | Actual installed Hook → input → normalization → JSONL; strict validator restricted to new Qwen records |

Node 18 is a historical compatibility probe, not a deployment recommendation. The locked production dependency `@loongsuite/otel-util-genai@0.1.0-beta.13` declares `Node >=20`; this constraint predates the RISC-V change. Core collection passing on Node18.20.8 does not establish dependency support: npm's default policy warns, while `engine-strict=true` rejects installation. This branch preserves the user's engine policy and does not alter the dependency declaration. Use the tested Node22 runtime for new deployments. Formal Node18 support still requires confirmation or a compatible release from the dependency maintainer.

The Agent's Node requirement is independent of Pilot's: Qwen 0.23.2 requires Node 22 even when Pilot runs on Node 18. The bundled CLI is unpacked without optional PTY/audio/image addons for these noninteractive tests.

No runtime support claim is made for musl, openEuler, physical RISC-V boards, other Agent binaries, external live models, SLS/HTTP/OTLP delivery, or every init system. systemd-system unit templates have unit tests; actual service acceptance and parser checks use systemd-user. No RISC-V managed Node or prebuilt node_modules archive is published by this change.

## Install the branch artifact

Build on a development machine with this checkout, Node and npm:

```bash
npm ci --ignore-scripts
npm rebuild sqlite3 zstd-napi
bash deploy/package-opensource.sh --output /tmp/loongsuite-pilot-riscv64.tar.gz
sha256sum /tmp/loongsuite-pilot-riscv64.tar.gz
```

Transfer the archive and this checkout's `deploy/installer-opensource.sh` to the RISC-V machine. The archive contains JavaScript and assets; native dependencies are built on the target. Verify the archive against the hash recorded on the build machine before installation.

On the target, provide a RISC-V Node runtime and npm on PATH, then install the build tools (Ubuntu example):

```bash
uname -m
node -p 'process.platform + "/" + process.arch + " " + process.version'
npm --version
sudo apt-get update
sudo apt-get install -y build-essential python3 pkg-config curl ca-certificates
bash ./installer-opensource.sh install \
  --package-url file:///tmp/loongsuite-pilot-riscv64.tar.gz \
  --prefer-system-node --agents qwen-code-cli
```

Both architecture probes must identify `riscv64`. The installer rejects a selected Node with a different architecture before replacing the data directory's runtime pin. A working Agent must already be installed for discovery and collection.

For a custom data directory, add `--data-dir /absolute/path/to/pilot-data`. Set `LOONGSUITE_PILOT_DATA_DIR` to that path when invoking the CLI. The systemd unit carries the config, data and cache paths; it can recover the runtime pin written beside the custom configuration. Public manual upgrades still require the default cache directory `~/.loongsuite-pilot`; a custom data directory is supported separately.

## Native builds and degraded operation

The shared `scripts/install-riscv64-deps.mjs` first installs production JavaScript dependencies with lifecycle scripts disabled. It then builds sqlite3 and zstd separately from source, runs isolated functional probes, and leaves the normal postinstall asset deployment to the installer/updater. It uses the installer's selected npm; standalone calls also allow npm on PATH when it is not adjacent to Node.

On the measured guest, the initial module builds took 604 seconds (SQLite) and 170 seconds (zstd); a complete repeated installation took about 15 minutes 35 seconds. These are measurements, not guarantees. The helper allows 30 minutes total, up to 5 minutes for JavaScript dependencies and up to 20 minutes for each native build within the remaining total. Timeout/interruption terminates the associated build process group. JavaScript installation failure fails the operation; native failure produces an explicit degraded result.

Do not omit the N-API targets when manually rebuilding. The measured Node 22/npm toolchain otherwise generated N-API 10 addons that caused Node 18 to exit with SIGSEGV. Use the shared helper:

```bash
PILOT_DATA="${LOONGSUITE_PILOT_DATA_DIR:-$HOME/.loongsuite-pilot}"
PILOT_VERSION="$(cat "$HOME/.loongsuite-pilot/current")"
PILOT_PACKAGE="$HOME/.loongsuite-pilot/versions/$PILOT_VERSION"
loongsuite-pilot stop
node "$PILOT_PACKAGE/scripts/install-riscv64-deps.mjs" \
  --package-dir "$PILOT_PACKAGE" --log-dir "$PILOT_DATA/logs/native-install"
loongsuite-pilot start
```

Run repairs with the same Node selected for Pilot. Rebuilding reuses the package's JavaScript dependency manifest and requires registry/toolchain access. Preserve the helper's complete logs under `logs/native-install/<timestamp>-<pid>/` when diagnosing a failure. Forwarded output is capped at 64 KiB per command to protect the updater's output buffer; file logs remain complete. An unopenable log prevents the build from spawning, and a write failure terminates its process group.

At startup, Linux riscv64 probes SQLite in a child process before importing it into the collector. A missing/broken/incompatible addon disables SQLite-only inputs and SQLite token enrichment. Hook and session-file collection can continue; failed SQLite reads do not advance their checkpoint. A repaired addon becomes available after restarting Pilot. zstd is installed and functionally tested, but no current collector source imports it; it is not required to start the core.

## Service and recovery checks

```bash
loongsuite-pilot status
loongsuite-pilot info
loongsuite-pilot restart
```

`status/info` show the last startup's `native-capabilities.json`, including SQLite availability, failure reason and recovery advice. This is a stored startup observation. For service failures, inspect `logs/last-restart-failure-collector.json`, `logs/last-startup-crash.json` and `journalctl --user -u loongsuite-pilot.service`. The `restart-collector` and `restart-updater` commands clear their previous restart marker on entry and write a new one on failure. Stable PID checks are bounded; registering a service alone does not establish startup success.

Published releases use `loongsuite-pilot upgrade --version <version>` and `loongsuite-pilot rollback`. Before publication, the test harness intercepts only the public installer download with a local pinned file, then invokes the actual CLI and installer with local A/B/failing packages. It does not publish those artificial versions. Public packages omit the background updater daemon; rollback accepts that package layout. The background updater's RISC-V branch is covered separately by unit/integration tests.

## Reproduce the full guest run

On an Ubuntu development host with Node/npm, Python 3.11+, QEMU RISC-V system emulation, qemu-img, xorriso, SSH, curl and zip:

```bash
sudo apt-get install -y qemu-system-misc qemu-utils xorriso openssh-client python3 zip
npm ci --ignore-scripts
npm rebuild sqlite3 zstd-napi
python3 scripts/riscv64/fresh-run.py \
  --work-dir e2e-artifacts/riscv64-fresh-01 \
  --cache-dir e2e-artifacts/riscv64-cache
```

The work directory must be new. Downloads are pinned in `scripts/riscv64/environment.lock.json` and checked on reuse. The runner uses a complete guest with RISC-V shell/compiler/child Node, creates its own SSH key and writable disk, builds a public artifact, installs it in the guest and runs installed acceptance. It returns nonzero on failure and archives evidence before stopping its guest. `--keep-guest` retains the VM for inspection; the collector is stopped before log archival.

To inspect a retained fresh guest, use its effective manifest, which records the chosen SSH port:

```bash
bash scripts/riscv64/run-qemu.sh ssh \
  --work-dir e2e-artifacts/riscv64-fresh-01 \
  --manifest e2e-artifacts/riscv64-fresh-01/environment.lock.json -- uname -m
```

`smoke.sh --case all` requires installer, package, B/startup-failure/dependency-failure packages, real Agent and Node18 paths. It runs installation, lifecycle, installation boundaries (including preserving the old payload after a same-version reinstall failure), upgrade/rollback with checkpoint continuity, fixture, real Agent, native failure/recovery, a clean Node18 dependency installation, Node18 runtime and restored-runtime checks. The Node18 installation case separately records the strict engine-policy result, native source builds with npm's default policy, and a real GenAI conversion call. A known engine rejection is recorded separately from runtime compatibility. Individual cases accept `--artifacts <new-directory>` and `--data-dir <installed-data-directory>`. These cases stop services and inject faults: run them only in the disposable acceptance guest.

`.github/workflows/riscv64.yml` invokes the same fresh-run entry on relevant PRs, main/master updates and manual runs, covering shared source, assets, installation and test scripts. It archives logs, manifests and the public package on failure as well as success. The release workflow reuses this check and waits for it before publishing. Local evidence and a workflow definition do not by themselves prove an upstream GitHub Actions run has passed.
