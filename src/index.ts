import { Orchestrator } from './core/orchestrator.js';
import { loadConfig } from './core/config-loader.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('Main');

async function main(): Promise<void> {
  const config = await loadConfig();

  if (!config.enabled) {
    logger.info('analytics disabled via config or AAC_ENABLED=false');
    return;
  }

  const orchestrator = new Orchestrator(config);

  const shutdown = async () => {
    logger.info('shutdown signal received');
    await orchestrator.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await orchestrator.start();

  logger.info('AI Agent Input is running', {
    dataDir: config.dataDir,
    port: config.port,
    flushers: Object.entries(config.flushers)
      .filter(([, v]) => v?.enabled)
      .map(([k]) => k),
  });
}

main().catch((err) => {
  logger.error('fatal startup error', { error: String(err) });
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
export { BaseFlusher } from './flushers/base-flusher.js';
export { SlsFlusher } from './flushers/sls-flusher.js';
export { JsonlFlusher } from './flushers/jsonl-flusher.js';
export { HttpFlusher } from './flushers/http-flusher.js';
export { MultiFlusher } from './flushers/multi-flusher.js';
export { HookManager } from './hooks/hook-manager.js';
export * from './types/index.js';
