#!/usr/bin/env node
import * as path from 'path';
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
  const { lock, holderPid } = acquireSingleInstanceLock(lockPath, COLLECTOR_PROCESS_PATTERNS);
  if (!lock) {
    logger.warn('another collector instance already holds the lock; exiting', {
      pid: process.pid,
      holderPid,
      lockPath,
    });
    // See the disabled-config branch above: the pino-roll rotation timer keeps the
    // event loop alive, so a bare `return` here leaves an orphan under the race where
    // a peer already holds the lock. Exit explicitly.
    flushLogsSync();
    process.exit(0);
  }
  logger.info('single-instance lock acquired', { pid: process.pid, lockPath });

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

  logger.info('AI Agent Input is running', {
    dataDir: config.dataDir,
    flushers: Object.entries(config.flushers)
      .filter(([, v]) => v?.enabled)
      .map(([k]) => k),
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
