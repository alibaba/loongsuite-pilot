#!/usr/bin/env node
/**
 * L1 E2E entry — Docker quick check for current branch code.
 * Three scenarios: preflight, install-smoke, uninstall.
 * env contract: 9 user envs (see .env.e2e.example).
 * Everything else gets a hardcoded default in lib/l1-env.mjs.
 */
import process from 'node:process';
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
  buildAgentProbeOnlyScript,
  buildProbeEnvInjections,
  buildProbeDetectionValidationScript,
  DEFAULT_E2E_INSTALLER_URL,
} from './lib/e2e-scenarios.mjs';

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
    'LOG="$HOME/.loongsuite-pilot/logs/loongsuite-pilot-service.log"',
    'TIMEOUT=180',
    'ELAPSED=0',
    `REQUIRED="${requiredAgents.join(' ')}"`,
    'while [ $ELAPSED -lt $TIMEOUT ]; do',
    '  ALL_FOUND=1',
    '  for agent in $REQUIRED; do',
    '    if ! grep -q "\\"id\\":\\"deploy:${agent}\\".*agent detected and started" "$LOG" 2>/dev/null; then',
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
    '  if grep -q "\\"id\\":\\"deploy:${agent}\\".*agent detected and started" "$LOG" 2>/dev/null; then',
    '    echo "  OK: $agent"',
    '  else',
    '    echo "  MISSING: $agent"',
    '  fi',
    'done',
    'echo ""',
    'echo "[pilot-ready] Last 10 deploy-related log lines:"',
    'grep -iE "deploy|Discover|detected" "$LOG" 2>/dev/null | tail -10 || true',
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

  console.log('[e2e-l1] phase 1.5 = probe detection validation');
  const probeValidation = await runLocalScript({
    script: buildProbeDetectionValidationScript(),
    artifactDir: ARTIFACT_DIR,
    artifactLabel: 'probe-detection-validate',
  });
  if (probeValidation.code !== 0) {
    console.error('[e2e-l1] Probe detection validation FAILED');
    console.error(probeValidation.stdout || probeValidation.stderr);
    await keepAliveOnFailure(probeValidation.code ?? 1);
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

  const requiredAgents = ['claude-code', 'codex', 'qoder'];
  console.log(`[e2e-l1] phase 3 = wait pilot detect agents: ${requiredAgents.join(', ')}`);
  await waitForPilotReady(requiredAgents);

  const probeBody = buildAgentProbeOnlyScript(env);
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
