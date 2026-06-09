#!/usr/bin/env node
/**
 * Config migration for internal (集团版) installations.
 *
 * Runs via postinstall.js after auto-update. Idempotent — safe to execute multiple times.
 *
 * What it does:
 *   1. Ensures the internal SLS endpoint lives in configs/inner/data_config.json (not config.json)
 *   2. Removes any internal SLS endpoint from config.json
 *   3. Ensures autoUpdate.packageUrl is set (so auto-update continues to work)
 *   4. Removes the deprecated `internal` field from config.json
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

function isInternalEndpoint(ep) {
  if (!ep || typeof ep !== 'object') return false;
  return ep.name === 'internal-sls' || ep.project === INTERNAL_SLS_ENDPOINT.project;
}

function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const content = JSON.stringify(data, null, 2) + '\n';
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

function writeInnerDataConfig(dataDir) {
  const innerDataConfigPath = path.join(dataDir, 'configs', 'inner', 'data_config.json');
  const innerDataConfig = { sls: [INTERNAL_SLS_ENDPOINT] };
  atomicWriteJson(innerDataConfigPath, innerDataConfig);
}

function removeInternalSlsFromConfig(cfg) {
  const sls = cfg.sls;
  if (!sls) return false;

  if (Array.isArray(sls)) {
    const filtered = sls.filter(ep => !isInternalEndpoint(ep));
    if (filtered.length === sls.length) return false;
    if (filtered.length === 0) {
      delete cfg.sls;
    } else {
      cfg.sls = filtered;
    }
    return true;
  }

  if (typeof sls === 'object' && isInternalEndpoint(sls)) {
    delete cfg.sls;
    return true;
  }

  return false;
}

export function migrate(configPath) {
  if (!fs.existsSync(configPath)) return false;

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return false;
  }

  if (cfg.internal === false) return false;

  const dataDir = path.dirname(configPath);

  const needsPackageUrl = !cfg.autoUpdate?.packageUrl;
  const hasInternalField = cfg.internal !== undefined;
  const hasInternalSlsInConfig = (() => {
    if (Array.isArray(cfg.sls)) return cfg.sls.some(ep => isInternalEndpoint(ep));
    if (cfg.sls && typeof cfg.sls === 'object') return isInternalEndpoint(cfg.sls);
    return false;
  })();

  writeInnerDataConfig(dataDir);

  let configChanged = false;

  if (hasInternalSlsInConfig) {
    configChanged = removeInternalSlsFromConfig(cfg);
  }

  if (needsPackageUrl) {
    cfg.autoUpdate = cfg.autoUpdate || {};
    cfg.autoUpdate.packageUrl = resolveDefaultPackageUrl(cfg);
    configChanged = true;
  }

  if (hasInternalField) {
    delete cfg.internal;
    configChanged = true;
  }

  if (configChanged) {
    atomicWriteJson(configPath, cfg);
  }

  return configChanged;
}
