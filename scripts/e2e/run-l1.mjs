#!/usr/bin/env node
/**
 * L1 E2E entry — Docker quick check for current branch code.
 * Three scenarios: preflight, install-smoke, uninstall.
 * env contract: 9 user envs (see .env.e2e.example).
 * Everything else gets a hardcoded default in lib/l1-env.mjs.
 */
import process from 'node:process';
import path from 'node:path';
import os from 'node:os';
import { runLocalScript } from './lib/docker-runner.mjs';
import {
  assertL1Env,
  applyL1Defaults,
  L1_SCENARIOS,
} from './lib/l1-env.mjs';
import {
  preflightScript,
  localBuildInstallScript,
  uninstallScript,
  buildJsonlValidationSh,
  buildJsonlAgentCoverageCheck,
  buildAgentConfigSetupScript,
  buildAgentEnsureOnlyScript,
  buildAgentProbeOnlyScript,
  buildProbeEnvInjections,
  buildProbeDetectionValidationScript,
  buildFileCollectionValidationSh,
  DEFAULT_E2E_INSTALLER_URL,
} from './lib/e2e-scenarios.mjs';
import {
  buildAgentDiscoveryPhaseScript,
  buildAutoUpgradePhaseScript,
  buildAutoRollbackPhaseScript,
  buildDualSendPhaseScript,
  buildMaskingPhaseScript,
} from './lib/expand-features.mjs';
import {
  createManifestServer,
  createWebtrackingCollector,
  createBrokenPackage,
} from './lib/mock-server.mjs';

const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR?.trim() || '/opt/artifacts';

async function keepAliveIfRequested(code) {
  const keepAlive = process.env.E2E_KEEP_ALIVE === '1';
  if (code === 0 && !keepAlive) return;
  if (code !== 0 && !keepAlive) return;
  const status = code === 0 ? 'PASSED' : 'FAILED';
  console.log(`[e2e-l1] Test ${status} (exit ${code}). Container kept alive.`);
  console.log('[e2e-l1] Attach: docker exec -it loongsuite-pilot-e2e-l1 bash');
  await new Promise(() => { setInterval(() => {}, 1 << 30); });
}

async function keepAliveOnFailure(code) {
  await keepAliveIfRequested(code);
  process.exit(code);
}

async function waitForPilotReady(requiredAgents) {
  const waitScript = [
    'set -euo pipefail',
    'LOG_GLOB="$HOME/.loongsuite-pilot/logs/loongsuite-pilot-service.log*"',
    'TIMEOUT=180',
    'ELAPSED=0',
    `REQUIRED="${requiredAgents.join(' ')}"`,
    'agent_ready() {',
    '  _agent="$1"',
    '  grep -q "\\\"id\\\":\\\"deploy:${_agent}\\\".*agent detected and started" $LOG_GLOB 2>/dev/null && return 0',
    '  grep -q "\\\"agentId\\\":\\\"${_agent}\\\".*\\\"msg\\\":\\\"hooks deployed\\\"" $LOG_GLOB 2>/dev/null && return 0',
    '  grep -q "\\\"agentId\\\":\\\"${_agent}\\\".*\\\"msg\\\":\\\"plugin injected\\\"" $LOG_GLOB 2>/dev/null && return 0',
    '  return 1',
    '}',
    'while [ $ELAPSED -lt $TIMEOUT ]; do',
    '  ALL_FOUND=1',
    '  for agent in $REQUIRED; do',
    '    if ! agent_ready "$agent"; then',
    '      ALL_FOUND=0',
    '      break',
    '    fi',
    '  done',
    '  if [ "$ALL_FOUND" -eq 1 ]; then',
    '    echo "[pilot-ready] All agents deployed (${ELAPSED}s): $REQUIRED"',
    '    exit 0',
    '  fi',
    '  sleep 3',
    '  ELAPSED=$((ELAPSED + 3))',
    'done',
    'echo "[pilot-ready] WARNING: timed out (${TIMEOUT}s). Agent deployment status:"',
    'for agent in $REQUIRED; do',
    '  if agent_ready "$agent"; then',
    '    echo "  OK: $agent"',
    '  else',
    '    echo "  MISSING: $agent"',
    '  fi',
    'done',
    'echo ""',
    'echo "[pilot-ready] Last 10 deploy-related log lines:"',
    'grep -iE "deploy|Discover|detected" $LOG_GLOB 2>/dev/null | tail -10 || true',
  ].join('\n');
  return runLocalScript({
    script: waitScript,
    artifactDir: ARTIFACT_DIR,
    artifactLabel: 'pilot-ready-wait',
  });
}

async function installSmokeScenario(env) {
  console.log('[e2e-l1] install-smoke: phase 1 = installer with local package');
  const install = await runLocalScript({
    script: localBuildInstallScript(env.E2E_USER_ID, env),
    artifactDir: ARTIFACT_DIR,
    artifactLabel: 'install',
  });
  if (install.code !== 0) {
    console.error(install.stderr || install.stdout);
    await keepAliveOnFailure(install.code ?? 1);
  }

  const configScript = buildAgentConfigSetupScript(env);
  if (configScript) {
    console.log('[e2e-l1] phase 2 = agent configs (codex/claude/proxy)');
    await runLocalScript({
      script: configScript,
      artifactDir: ARTIFACT_DIR,
      artifactLabel: 'agent-config-setup',
    });
  }

  const ensureScript = buildAgentEnsureOnlyScript(env);
  if (ensureScript) {
    console.log('[e2e-l1] phase 2.5 = ensure CLI agents');
    const ensure = await runLocalScript({
      script: `${buildProbeEnvInjections(env)}${ensureScript}`,
      artifactDir: ARTIFACT_DIR,
      artifactLabel: 'agent-ensure',
    });
    if (ensure.code !== 0) {
      console.error(ensure.stderr || ensure.stdout);
      await keepAliveOnFailure(ensure.code ?? 1);
    }

    console.log('[e2e-l1] phase 2.5b = enable ensured CLI agents and restart pilot');
    const restart = await runLocalScript({
      script: `set -euo pipefail
node - <<'NODE'
const fs = require('fs');
const os = require('os');
const path = require('path');
const configPath = path.join(os.homedir(), '.loongsuite-pilot', 'config.json');
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
cfg.agents ||= {};
const required = '${env.E2E_REQUIRED_DEPLOY_AGENTS || ''}'.split(',').map(s => s.trim()).filter(Boolean);
for (const agent of required) cfg.agents[agent] = { ...(cfg.agents[agent] || {}), enabled: true };
fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
console.log('[e2e-l1] enabled agents in config:', required.join(','));
NODE
mkdir -p \
  "$HOME/.claude" \
  "$HOME/.codex/sessions" \
  "$HOME/.qoder/logs/sessions" \
  "$HOME/.cursor" \
  "$HOME/.qwen" \
  "$HOME/.config/opencode" \
  "$HOME/.loongsuite-pilot/logs/claude-code" \
  "$HOME/.loongsuite-pilot/logs/cursor/history" \
  "$HOME/.loongsuite-pilot/logs/qoder/history" \
  "$HOME/.loongsuite-pilot/logs/qwen-code-cli" \
  "$HOME/.loongsuite-pilot/logs/opencode"

# Create default opencode.jsonc so pilot can inject plugin
cat > "$HOME/.config/opencode/opencode.jsonc" <<'OPENCODE_JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": []
}
OPENCODE_JSON

# Create default qwen settings.json so pilot can inject hooks
cat > "$HOME/.qwen/settings.json" <<'QWEN_JSON'
{
  "hooks": {}
}
QWEN_JSON

loongsuite-pilot restart || (loongsuite-pilot stop 2>/dev/null || true; loongsuite-pilot start)
sleep 5
loongsuite-pilot status`,
      artifactDir: ARTIFACT_DIR,
      artifactLabel: 'pilot-restart-after-ensure',
    });
    if (restart.code !== 0) {
      console.error(restart.stderr || restart.stdout);
      await keepAliveOnFailure(restart.code ?? 1);
    }
  }

  console.log('[e2e-l1] phase 2.6 = probe detection validation');
  const deployAgents = env.E2E_REQUIRED_DEPLOY_AGENTS;
  const probeValidation = await runLocalScript({
    script: buildProbeDetectionValidationScript(deployAgents),
    artifactDir: ARTIFACT_DIR,
    artifactLabel: 'probe-detection-validate',
  });
  if (probeValidation.code !== 0) {
    console.error('[e2e-l1] Probe detection validation FAILED');
    console.error(probeValidation.stdout || probeValidation.stderr);
    await keepAliveOnFailure(probeValidation.code ?? 1);
  }

  const requiredAgents = deployAgents.split(',').map(s => s.trim()).filter(Boolean);
  console.log(`[e2e-l1] phase 3 = wait pilot detect agents: ${requiredAgents.join(', ')}`);
  const ready = await waitForPilotReady(requiredAgents);
  if (ready.code !== 0) {
    console.error('[e2e-l1] Pilot readiness wait FAILED');
    console.error(ready.stdout || ready.stderr);
    await keepAliveOnFailure(ready.code ?? 1);
  }

  const probeBody = buildAgentProbeOnlyScript({ ...env, E2E_ENSURE_AGENT_CLIS: '0' });
  if (probeBody) {
    console.log('[e2e-l1] phase 4 = agent probes');
    const probeScript = `${buildProbeEnvInjections(env)}${probeBody}`;
    const probe = await runLocalScript({
      script: probeScript,
      artifactDir: ARTIFACT_DIR,
      artifactLabel: 'agent-probe',
    });
    if (probe.code !== 0) {
      console.error(probe.stderr || probe.stdout);
      await keepAliveOnFailure(probe.code ?? 1);
    }
  }

  console.log('[e2e-l1] phase 5 = 60s wait for pilot flush');
  await new Promise(r => setTimeout(r, 60_000));

  const jsonlSh = buildJsonlValidationSh(env);
  if (jsonlSh) {
    console.log('[e2e-l1] phase 6 = JSONL format validation');
    const r = await runLocalScript({
      script: jsonlSh,
      artifactDir: ARTIFACT_DIR,
      artifactLabel: 'jsonl-validate',
    });
    if (r.code !== 0) {
      console.error('[e2e-l1] JSONL validation FAILED');
      await keepAliveOnFailure(r.code ?? 1);
    }
  }

  const required = env.E2E_REQUIRED_JSONL_AGENTS;
  console.log(`[e2e-l1] phase 7 = JSONL agent coverage (${required})`);
  const coverage = await runLocalScript({
    script: buildJsonlAgentCoverageCheck(required),
    artifactDir: ARTIFACT_DIR,
    artifactLabel: 'jsonl-agent-coverage',
  });
  if (coverage.code !== 0) {
    console.error('[e2e-l1] JSONL agent coverage FAILED');
    console.error(coverage.stdout || coverage.stderr);
    await keepAliveOnFailure(coverage.code ?? 1);
  }

  console.log('[e2e-l1] phase 8 = file-collection pipeline validation');
  const fcValidation = await runLocalScript({
    script: buildFileCollectionValidationSh(),
    artifactDir: ARTIFACT_DIR,
    artifactLabel: 'file-collection-validate',
  });
  if (fcValidation.code !== 0) {
    console.error('[e2e-l1] File collection validation FAILED');
    console.error(fcValidation.stdout || fcValidation.stderr);
    await keepAliveOnFailure(fcValidation.code ?? 1);
  }
  console.log('[e2e-l1] install-smoke PASSED.');
}

async function uninstallScenario(env) {
  const installerUrl = (env.E2E_INSTALLER_URL ?? DEFAULT_E2E_INSTALLER_URL).trim();
  console.log('[e2e-l1] uninstall scenario: phase 1 = installer with local package');
  const install = await runLocalScript({
    script: localBuildInstallScript(env.E2E_USER_ID, env),
    artifactDir: ARTIFACT_DIR,
    artifactLabel: 'install',
  });
  if (install.code !== 0) {
    console.error(install.stderr || install.stdout);
    await keepAliveOnFailure(install.code ?? 1);
  }

  console.log('[e2e-l1] uninstall scenario: phase 2 = uninstall + verify');
  const verifyScript = `
${uninstallScript(installerUrl)}

echo "=== verify no residue ==="
fail=0
if [ -d "$HOME/.loongsuite-pilot" ]; then echo "FAIL: ~/.loongsuite-pilot still exists"; fail=1; fi
if command -v loongsuite-pilot >/dev/null 2>&1; then echo "FAIL: loongsuite-pilot still on PATH"; fail=1; fi
if systemctl --user is-enabled loongsuite-pilot.service 2>/dev/null; then echo "FAIL: systemd user unit still enabled"; fail=1; fi
[ "$fail" -eq 0 ] && echo "uninstall: no residue"
exit $fail
`;
  const verify = await runLocalScript({
    script: verifyScript,
    artifactDir: ARTIFACT_DIR,
    artifactLabel: 'uninstall-verify',
  });
  if (verify.code !== 0) {
    console.error(verify.stderr || verify.stdout);
    await keepAliveOnFailure(verify.code ?? 1);
  }
  console.log('[e2e-l1] uninstall scenario PASSED.');
}

async function expandFeaturesScenario(env) {
  const skipPhases = (env.E2E_EXPAND_SKIP_PHASES || '').split(',').map(s => s.trim()).filter(Boolean);
  const failFast = env.E2E_EXPAND_FAIL_FAST === '1';
  const portBase = Number(env.E2E_EXPAND_MOCK_PORT_BASE || '19100');
  let failures = 0;

  // Phase 0: Install pilot
  console.log('[e2e-expand] phase 0: install pilot');
  const install = await runLocalScript({
    script: localBuildInstallScript(env.E2E_USER_ID, env),
    artifactDir: ARTIFACT_DIR,
    artifactLabel: 'expand-install',
  });
  if (install.code !== 0) {
    console.error('[e2e-expand] Install failed:', install.stderr || install.stdout);
    await keepAliveOnFailure(install.code ?? 1);
  }

  // Phase 1: Agent Dynamic Discovery
  if (!skipPhases.includes('1')) {
    console.log('[e2e-expand] phase 1: agent dynamic discovery');
    const r = await runLocalScript({
      script: buildAgentDiscoveryPhaseScript(env),
      artifactDir: ARTIFACT_DIR,
      artifactLabel: 'expand-phase1-discovery',
    });
    if (r.code !== 0) {
      console.error('[e2e-expand] Phase 1 FAILED:', r.stdout || r.stderr);
      failures++;
      if (failFast) await keepAliveOnFailure(r.code ?? 1);
    }
  } else {
    console.log('[e2e-expand] phase 1: SKIPPED');
  }

  // Phase 2: Auto Upgrade
  if (!skipPhases.includes('2')) {
    console.log('[e2e-expand] phase 2: auto upgrade');
    const manifestPort = portBase;
    const pkgPath = '/opt/project/loongsuite-pilot.tar.gz';
    const manifest = { version: '99.0.0', git_commit: 'e2e-fake', package_url: `http://127.0.0.1:${manifestPort}/pkg.tar.gz` };
    let manifestServer;
    try {
      manifestServer = await createManifestServer(manifestPort, { manifest, packagePath: pkgPath });
      const r = await runLocalScript({
        script: buildAutoUpgradePhaseScript(env, manifestPort),
        artifactDir: ARTIFACT_DIR,
        artifactLabel: 'expand-phase2-upgrade',
      });
      if (r.code !== 0) {
        console.error('[e2e-expand] Phase 2 FAILED:', r.stdout || r.stderr);
        failures++;
        if (failFast) await keepAliveOnFailure(r.code ?? 1);
      }
    } catch (e) {
      console.error('[e2e-expand] Phase 2 mock server error:', e.message);
      failures++;
      if (failFast) await keepAliveOnFailure(1);
    } finally {
      if (manifestServer) await manifestServer.close();
    }
  } else {
    console.log('[e2e-expand] phase 2: SKIPPED');
  }

  // Phase 3: Auto Rollback
  if (!skipPhases.includes('3')) {
    console.log('[e2e-expand] phase 3: auto rollback');
    const rollbackPort = portBase + 1;
    const brokenPkgPath = path.join(os.tmpdir(), 'e2e-broken-pkg.tar.gz');
    createBrokenPackage(brokenPkgPath);
    const brokenManifest = { version: '99.9.9', git_commit: 'broken' };
    let brokenServer;
    try {
      brokenServer = await createManifestServer(rollbackPort, { manifest: brokenManifest, packagePath: brokenPkgPath });
      const r = await runLocalScript({
        script: buildAutoRollbackPhaseScript(env, rollbackPort),
        artifactDir: ARTIFACT_DIR,
        artifactLabel: 'expand-phase3-rollback',
      });
      if (r.code !== 0) {
        console.error(`[e2e-expand] Phase 3 FAILED (exit code ${r.code}):`);
        console.error('--- stdout tail ---');
        console.error((r.stdout || '').split('\n').slice(-30).join('\n'));
        console.error('--- stderr ---');
        console.error(r.stderr || '(empty)');
        failures++;
        if (failFast) await keepAliveOnFailure(r.code ?? 1);
      }
    } catch (e) {
      console.error('[e2e-expand] Phase 3 mock server error:', e.message);
      failures++;
      if (failFast) await keepAliveOnFailure(1);
    } finally {
      if (brokenServer) await brokenServer.close();
    }
  } else {
    console.log('[e2e-expand] phase 3: SKIPPED');
  }

  // Phase 4: Dual Send
  if (!skipPhases.includes('4')) {
    console.log('[e2e-expand] phase 4: dual send');
    const portA = portBase + 2;
    const portB = portBase + 3;
    let collectorA, collectorB;
    try {
      collectorA = await createWebtrackingCollector(portA);
      collectorB = await createWebtrackingCollector(portB);
      const r = await runLocalScript({
        script: buildDualSendPhaseScript(env, portA, portB),
        artifactDir: ARTIFACT_DIR,
        artifactLabel: 'expand-phase4-dualsend',
      });
      if (r.code !== 0) {
        console.error('[e2e-expand] Phase 4 script FAILED:', r.stdout || r.stderr);
        failures++;
        if (failFast) await keepAliveOnFailure(r.code ?? 1);
      } else {
        // Assert both collectors received data
        let phase4Pass = true;
        if (collectorA.received.length === 0) {
          console.error('[e2e-expand] Phase 4 FAILED: endpoint A received 0 requests');
          failures++;
          phase4Pass = false;
        }
        if (collectorB.received.length === 0) {
          console.error('[e2e-expand] Phase 4 FAILED: endpoint B received 0 requests');
          failures++;
          phase4Pass = false;
        }
        if (phase4Pass) {
          console.log(`[e2e-expand] Phase 4: endpoint A got ${collectorA.received.length} requests, B got ${collectorB.received.length}`);
        }
        if (failures > 0 && failFast) await keepAliveOnFailure(1);
      }
    } catch (e) {
      console.error('[e2e-expand] Phase 4 mock server error:', e.message);
      failures++;
      if (failFast) await keepAliveOnFailure(1);
    } finally {
      if (collectorA) await collectorA.close();
      if (collectorB) await collectorB.close();
    }
  } else {
    console.log('[e2e-expand] phase 4: SKIPPED');
  }

  // Phase 5: Masking Validation
  if (!skipPhases.includes('5')) {
    console.log('[e2e-expand] phase 5: masking validation');
    const r = await runLocalScript({
      script: buildMaskingPhaseScript(env),
      artifactDir: ARTIFACT_DIR,
      artifactLabel: 'expand-phase5-masking',
    });
    if (r.code !== 0) {
      console.error('[e2e-expand] Phase 5 FAILED:', r.stdout || r.stderr);
      failures++;
      if (failFast) await keepAliveOnFailure(r.code ?? 1);
    }
  } else {
    console.log('[e2e-expand] phase 5: SKIPPED');
  }

  if (failures > 0) {
    console.error(`[e2e-expand] FAILED: ${failures} phase(s) failed`);
    await keepAliveOnFailure(1);
  }
  console.log('[e2e-expand] expand-features PASSED (all phases).');
}

async function main() {
  const env = process.env;
  const scenario = (env.E2E_SCENARIO ?? 'install-smoke').trim();

  let missing;
  try {
    missing = assertL1Env(scenario, env);
  } catch (e) {
    console.error(`[e2e-l1] ${e.message}`);
    console.error(`[e2e-l1] L1 scenarios: ${L1_SCENARIOS.join(', ')}`);
    process.exit(2);
  }
  if (missing.length) {
    console.error('[e2e-l1] Missing required env:');
    for (const k of missing) console.error(`  - ${k}`);
    console.error('\nFix: cp .env.e2e.example .env.e2e && edit .env.e2e');
    process.exit(2);
  }

  applyL1Defaults(env);

  console.log(`[e2e-l1] scenario=${scenario}`);
  try {
    if (scenario === 'preflight') {
      const r = await runLocalScript({
        script: preflightScript(),
        artifactDir: ARTIFACT_DIR,
        artifactLabel: 'preflight',
      });
      if (r.code !== 0) await keepAliveOnFailure(r.code ?? 1);
      console.log('[e2e-l1] preflight PASSED.');
    } else if (scenario === 'install-smoke') {
      await installSmokeScenario(env);
    } else if (scenario === 'uninstall') {
      await uninstallScenario(env);
    } else if (scenario === 'expand-features') {
      await expandFeaturesScenario(env);
    }
  } catch (e) {
    console.error('[e2e-l1] unexpected error:', e);
    await keepAliveOnFailure(1);
  }

  await keepAliveIfRequested(0);
  process.exit(0);
}

main().catch(async err => {
  console.error(err);
  await keepAliveOnFailure(1);
});
