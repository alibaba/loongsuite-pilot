#!/usr/bin/env node
import * as path from 'path';
import * as fs from 'fs';
import { Orchestrator } from './core/orchestrator.js';
import { loadConfig } from './core/config-loader.js';
import { createLogger, initFileLogging, flushLogsSync } from './utils/logger.js';
import { resolveHome, readInstalledVersion } from './utils/fs-utils.js';
import { writeStartupCrash, clearStartupCrash, resolveBreadcrumbDataDir } from './utils/crash-breadcrumb.js';
import { handleWorkerCli } from './local-workers/worker-cli.js';
import { handlePiSdkAgentCli } from './pi-sdk/pi-sdk-agent-cli.js';
import { acquireSingleInstanceLock } from './utils/single-instance-lock.js';
import { COLLECTOR_PROCESS_PATTERNS, writePidFileSync, removeOwnPidFileSync } from './utils/pid-utils.js';

const logger = createLogger('Main');

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (await handlePiSdkAgentCli(argv)) {
    return;
  }
  if (await handleWorkerCli(argv)) {
    return;
  }

  const [command, ...args] = argv;
  if (command === 'token-usage' || command === 'tokens') {
    const { runTokenUsageCommand } = await import('./cli/token-usage.js');
    process.exitCode = await runTokenUsageCommand(args);
    return;
  }

  // One-shot deployment. The collector deploys hooks/plugins itself on startup,
  // but only as a daemon side effect; image builds need it as a foreground step
  // with an exit code (see runDeployCommand).
  if (command === 'deploy') {
    const { runDeployCommand } = await import('./deployment/deploy-command.js');
    try {
      process.exitCode = await runDeployCommand(args);
    } catch (err) {
      console.error(`loongsuite-pilot deploy: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
    flushLogsSync();
    return;
  }

  const config = await loadConfig();

  const dataDir = resolveHome(config.dataDir);
  const logDir = path.join(dataDir, 'logs');
  await initFileLogging(path.join(logDir, 'loongsuite-pilot-service.log'));

  if (!config.enabled) {
    // A deliberate, non-crash exit: drop any stale breadcrumb so it is not later
    // misread as this run's failure cause.
    clearStartupCrash(resolveBreadcrumbDataDir());
    logger.info('analytics disabled via config or LOONGSUITE_PILOT_ENABLED=false');
    // initFileLogging arms a non-unref'd pino-roll rotation timer that keeps the
    // event loop alive, so a bare `return` would linger as an orphan — exit explicitly.
    flushLogsSync();
    process.exit(0);
  }

  // Cross-process single-instance guard. Multiple collector daemons on one machine
  // tail the same source and append to the same output, duplicating every record
  // (see logs/output duplicate-collection incident). The scheduled-task
  // `MultipleInstances=IgnoreNew` policy is bypassed whenever the task is
  // re-registered while an instance is still running, so this pid lock — acquired
  // before any pipeline is wired up — is the daemon's own last line of defense.
  // Lock file is runtime state, not a log — keep it in the dataDir root alongside
  // the pid file, not under logs/.
  const lockPath = path.join(dataDir, 'collector.lock');
  const {
    lock,
    holderPid,
    holderProcessStartState,
    holderCommandState,
    recoveredStaleLock,
  } = acquireSingleInstanceLock(lockPath, COLLECTOR_PROCESS_PATTERNS);
  if (!lock) {
    logger.warn('another collector instance already holds the lock; exiting', {
      pid: process.pid,
      holderPid,
      holderProcessStartState,
      holderCommandState,
      lockPath,
    });
    // See the disabled-config branch above: the pino-roll rotation timer keeps the
    // event loop alive, so a bare `return` here leaves an orphan under the race where
    // a peer already holds the lock. Exit explicitly.
    flushLogsSync();
    process.exit(0);
  }
  if (recoveredStaleLock) {
    logger.warn('stale single-instance lock recovered', {
      pid: process.pid,
      previousHolderPid: recoveredStaleLock.previousPid,
      recoveryReason: recoveredStaleLock.reason,
      lockPath,
    });
  }
  logger.info('single-instance lock acquired', { pid: process.pid, lockPath });

  // PID-write authority lives HERE, not in the spawners (k8s-preload.cjs /
  // start.sh). Two spawners that each recorded the pid they spawned could leave
  // the lock pointing at a daemon that lost THIS collector.lock race and exited —
  // so prestop.sh would signal a dead pid while the real daemon died in the
  // SIGKILL with buffers unflushed. The daemon that actually holds collector.lock
  // is the only one prestop.sh should ever signal, so it is the only one allowed
  // to publish a pid. See the daemon.spawn.lock contract in prestop.sh.
  //
  // Only written on the K8s path (or when a spawner already created the file),
  // so a bare local `npm start` does not grow a stray lock file in the data dir.
  const spawnLockPath = path.join(dataDir, 'daemon.spawn.lock');
  if (process.env.KUBERNETES_SERVICE_HOST || fs.existsSync(spawnLockPath)) {
    try {
      fs.writeFileSync(spawnLockPath, String(process.pid), 'utf8');
    } catch (err) {
      // Non-fatal: worst case prestop.sh finds a stale/empty lock and lets the
      // grace period run its course — the same as before this write existed.
      logger.warn('cannot record daemon pid in spawn lock', { spawnLockPath, error: String(err) });
    }
  }

  // On Windows the launcher cannot record the daemon's real pid: there is no exec(2),
  // so wscript/PowerShell run node as a *child* and would only ever capture the wrapper
  // pid (or, on the Task Scheduler path, nothing at all). Unix keeps writing the pid file
  // from the script via `echo $$ + exec`, so this is win32-only. dataDir is env-first here
  // and the Windows launchers inject LOONGSUITE_PILOT_DATA_DIR, so this path matches the
  // `$DATA_DIR\loongsuite-pilot.pid` the .ps1 reads for stop/status.
  const pidFile = process.platform === 'win32'
    ? path.join(dataDir, 'loongsuite-pilot.pid')
    : null;
  if (pidFile) writePidFileSync(pidFile);

  // Fires for normal completion, signal-driven shutdown (via process.exit below),
  // and the fatal-error path in main().catch — covering every exit route.
  // flushLogsSync() goes first and is the single guaranteed flush: the pino-roll
  // SonicBoom has no on-exit flush of its own, and this handler is the one path that
  // always runs — even if shutdown()'s own flush is skipped because orchestrator.stop()
  // rejected. Sync + idempotent + already try/catch, so it is zero-risk here.
  process.on('exit', () => {
    flushLogsSync();
    lock.release();
    if (pidFile) removeOwnPidFileSync(pidFile);
    // Release the spawn lock the same way the pid file is released: only when it
    // still carries THIS daemon's pid, so a successor that already took over (or a
    // pid-reused process) is never disturbed. Leaving a dead pid behind is exactly
    // the hazard the prestop contract guards against — prestop.sh would SIGTERM a
    // recycled pid. See the daemon.spawn.lock contract in prestop.sh.
    try {
      if (fs.readFileSync(spawnLockPath, 'utf8').trim() === String(process.pid)) {
        fs.unlinkSync(spawnLockPath);
      }
    } catch { /* lock never written, or already gone — nothing to clean */ }
  });

  const orchestrator = new Orchestrator(config);

  const shutdown = async () => {
    logger.info('shutdown signal received');
    try {
      await orchestrator.stop();
    } catch (err) {
      // A rejected stop() (e.g. flusher.shutdown()/stateStore.save() throwing) must not
      // skip the flush+exit below and silently fall through to the process.on('exit')
      // fallback with stop() half-done and this shutdown log lost.
      logger.error('error during orchestrator shutdown', { error: String(err) });
    } finally {
      lock.release();
      flushLogsSync();
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await orchestrator.start();

  // Reached a healthy running state: clear any stale crash breadcrumb so a lingering
  // one always reflects the most recent *failed* startup attempt. The breadcrumb dir
  // must match the daemon writer and the updater reader (env-or-default), not config.dataDir.
  clearStartupCrash(resolveBreadcrumbDataDir());

  const enabledFlushers = Object.entries(config.flushers)
    .filter(([, v]) => v?.enabled)
    .map(([k]) => k);

  // LOONGSUITE_SLS_* alone does not switch SLS on: buildSlsConfig only consults
  // those vars when the config file carries an `sls` section. Under K8s nothing
  // writes that section except k8s-preload.cjs, so a failed unlock write leaves a
  // destination fully configured in the env and no exporter to use it. The sole
  // symptom used to be `sls` missing from the list logged below — readable only
  // by someone who already knew it belonged there, which cost hours to diagnose
  // once. Where the intent is this unambiguous, say so rather than stay quiet.
  if (
    !enabledFlushers.includes('sls')
    && process.env.LOONGSUITE_SLS_PROJECT
    && process.env.LOONGSUITE_SLS_LOGSTORE
  ) {
    logger.warn(
      'an SLS destination is set in the environment but the SLS flusher is NOT enabled — '
      + 'events will be collected locally and never uploaded. Those env vars are only read '
      + 'when the config file carries an "sls" section; check that the file exists and is readable.',
      {
        project: process.env.LOONGSUITE_SLS_PROJECT,
        logstore: process.env.LOONGSUITE_SLS_LOGSTORE,
        expectedConfigPath: process.env.AGENT_DATA_COLLECTION_CONFIG ?? '~/.loongsuite-pilot/config.json',
        enabledFlushers,
      },
    );
  }

  logger.info('AI Agent Input is running', {
    dataDir: config.dataDir,
    flushers: enabledFlushers,
  });
}

main().catch((err) => {
  logger.error('fatal startup error', { error: String(err) });
  const breadcrumbDir = resolveBreadcrumbDataDir();
  writeStartupCrash({
    dataDir: breadcrumbDir,
    phase: 'startup',
    version: readInstalledVersion(breadcrumbDir),
    error: err,
  });
  flushLogsSync();
  process.exit(1);
});

// Re-export for programmatic use
export { Orchestrator } from './core/orchestrator.js';
export { InputManager } from './core/input-manager.js';
export { AgentControlManager } from './core/agent-control-manager.js';
export { AgentDiscoveryService } from './core/agent-discovery-service.js';
// HTTP Push server temporarily disabled
// export { HttpPushServer } from './server/http-server.js';
export { loadConfig } from './core/config-loader.js';
export { BaseInput } from './inputs/base/base-input.js';
export { BaseIdeInput } from './inputs/base/base-ide-input.js';
export { BaseSqliteInput } from './inputs/base/base-sqlite-input.js';
export { BaseHookInput } from './inputs/base/base-hook-input.js';
export { BaseCliForwarder } from './inputs/base/base-cli-forwarder.js';
export { BaseSessionInput } from './inputs/base/base-session-input.js';
export { QoderSqliteInput } from './inputs/qoder-sqlite/qoder-sqlite-input.js';
export { QoderCnSqliteInput } from './inputs/qoder-cn-sqlite/qoder-cn-sqlite-input.js';
export { QoderCnInput } from './inputs/qoder-cn/qoder-cn-input.js';
export { QoderCnTraceInput } from './inputs/qoder-cn-trace/qoder-cn-trace-input.js';
export { QoderCliSessionInput } from './inputs/qoder-cli-session/qoder-cli-session-input.js';
export { CodexTranscriptInput } from './inputs/codex-transcript/codex-transcript-input.js';
export { CodexAbortedTurnInput } from './inputs/codex-aborted-turn/codex-aborted-turn-input.js';
export { PiCodingAgentLogInput } from './inputs/pi-coding-agent-log/pi-coding-agent-log-input.js';
export { WorkBuddyInput } from './inputs/workbuddy/workbuddy-input.js';
export { BaseFlusher } from './flushers/base-flusher.js';
export { SlsFlusher } from './flushers/sls-flusher.js';
export { JsonlFlusher } from './flushers/jsonl-flusher.js';
export { HttpFlusher } from './flushers/http-flusher.js';
export { MultiFlusher } from './flushers/multi-flusher.js';
export { HookManager } from './hooks/hook-manager.js';
export { PipelineManager } from './pipeline/pipeline-manager.js';
export * from './types/index.js';
