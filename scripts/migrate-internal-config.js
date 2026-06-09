#!/usr/bin/env node
/**
 * One-time config migration for internal (集团版) installations.
 *
 * Runs via postinstall.js after auto-update. Idempotent — safe to execute multiple times.
 *
 * What it does:
 *   1. Ensures the internal SLS endpoint (ai-coding-devops) is present in config.sls
 *   2. Ensures autoUpdate.packageUrl is set (so auto-update continues to work)
 *   3. Removes the deprecated `internal` field
 *
 * This file is ONLY included in internal (集团版) packages.
 * Commercial / open-source packages must NOT ship this file.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const INTERNAL_SLS_ENDPOINT = {
  name: 'internal-sls',
  endpoint: 'https://cn-heyuan.log.aliyuncs.com',
  project: 'ai-coding-devops',
  logstore: 'loongsuite_pilot_for_ai_coding',
  mode: 'webtracking',
};

const BASE_PACKAGE_URL = 'https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/';

function resolveDefaultPackageUrl(cfg) {
  const channel = process.env.LOONGSUITE_PILOT_CHANNEL ?? cfg?.channel ?? 'release';
  if (channel === 'test' || channel === 'pre') {
    return `${BASE_PACKAGE_URL}loongsuite-dev/loongsuite-pilot/latest/loongsuite-pilot.tar.gz`;
  } else if (/^test-[a-zA-Z0-9]+$/.test(channel)) {
    return `${BASE_PACKAGE_URL}loongsuite-dev/${channel}/loongsuite-pilot/latest/loongsuite-pilot.tar.gz`;
  }
  return `${BASE_PACKAGE_URL}loongsuite/loongsuite-pilot/latest/loongsuite-pilot.tar.gz`;
}

function hasInternalSlsEndpoint(sls) {
  if (Array.isArray(sls)) {
    return sls.some(ep => ep.project === INTERNAL_SLS_ENDPOINT.project);
  }
  if (sls && typeof sls === 'object') {
    return sls.project === INTERNAL_SLS_ENDPOINT.project;
  }
  return false;
}

function ensureInternalSlsEndpoint(sls) {
  if (!sls) {
    return {
      endpoint: INTERNAL_SLS_ENDPOINT.endpoint,
      project: INTERNAL_SLS_ENDPOINT.project,
      logstore: INTERNAL_SLS_ENDPOINT.logstore,
    };
  }

  if (Array.isArray(sls)) {
    // Filter out incomplete entries that would cause enabled=false
    const valid = sls.filter(ep => ep.endpoint && ep.project && ep.logstore);
    if (!valid.some(ep => ep.project === INTERNAL_SLS_ENDPOINT.project)) {
      valid.push(INTERNAL_SLS_ENDPOINT);
    }
    return valid;
  }

  // sls is a single object — determine if it represents a user endpoint
  const isInternal = sls.project === INTERNAL_SLS_ENDPOINT.project;

  if (sls.project && sls.logstore && !isInternal) {
    // User endpoint — backfill missing endpoint with internal default
    // (old internal mode used INTERNAL_SLS_DESTINATION.endpoint as fallback)
    const patched = { ...sls };
    if (!patched.endpoint) {
      patched.endpoint = INTERNAL_SLS_ENDPOINT.endpoint;
    }
    return [patched, INTERNAL_SLS_ENDPOINT];
  }

  // No user project, or already the internal one — use clean flat internal config
  return {
    endpoint: INTERNAL_SLS_ENDPOINT.endpoint,
    project: INTERNAL_SLS_ENDPOINT.project,
    logstore: INTERNAL_SLS_ENDPOINT.logstore,
  };
}

export function migrate(configPath) {
  if (!fs.existsSync(configPath)) return false;

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return false;
  }

  // Skip if this is clearly a commercial install (old commercial had internal: false)
  if (cfg.internal === false) return false;

  // Detect: this is likely an internal install if internal !== false AND
  // the internal SLS endpoint is not already configured.
  // This covers: internal: true (normal), internal: undefined (edge case).
  const needsSlsMigration = !hasInternalSlsEndpoint(cfg.sls);
  const needsPackageUrl = !cfg.autoUpdate?.packageUrl;
  const hasInternalField = cfg.internal !== undefined;

  if (!needsSlsMigration && !needsPackageUrl && !hasInternalField) return false;

  let changed = false;

  // 1. Ensure internal SLS endpoint is present
  if (needsSlsMigration) {
    cfg.sls = ensureInternalSlsEndpoint(cfg.sls);
    changed = true;
  }

  // 2. Ensure autoUpdate.packageUrl exists
  if (needsPackageUrl) {
    cfg.autoUpdate = cfg.autoUpdate || {};
    cfg.autoUpdate.packageUrl = resolveDefaultPackageUrl(cfg);
    changed = true;
  }

  // 3. Remove deprecated internal field
  if (hasInternalField) {
    delete cfg.internal;
    changed = true;
  }

  if (changed) {
    const content = JSON.stringify(cfg, null, 2) + '\n';
    const tmp = configPath + '.tmp';
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, configPath);
  }

  return changed;
}

// Direct execution (from postinstall.js)
const dataDir = process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(process.env.HOME || '', '.loongsuite-pilot');
const configPath = path.join(dataDir, 'config.json');

if (migrate(configPath)) {
  console.log('[loongsuite-pilot] Config migrated: ensured internal SLS endpoint, removed internal flag');
}
