// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import * as module from 'node:module';
import { fileURLToPath } from 'node:url';

const KEY = Symbol.for('loongsuite-pilot.openclaw.steered-delivery');

function nativeDist(entry) {
  if (typeof entry !== 'string' || !path.isAbsolute(entry)) return;
  let dir;
  try { dir = path.dirname(fs.realpathSync(entry)); } catch { return; }
  for (let depth = 0; depth < 8; depth++, dir = path.dirname(dir)) {
    try {
      const file = path.join(dir, 'package.json');
      if (fs.statSync(file).size > 256 * 1024) return;
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (pkg.name === 'openclaw') return path.join(dir, 'dist') + path.sep;
      if (pkg.name !== undefined) return;
    } catch (err) { if (err.code !== 'ENOENT') return; }
  }
}

// Current native active-run steering drops inter-session provenance before
// before_message_write. Observe the lazy announcement coordinator instead.
// Keep its delivery call, arguments, result and exceptions unchanged. This
// adapter never reads a prompt to identify work, or changes native files.
export function installSteeredDeliveryObserver(observer, entry = process.argv[1]) {
  if (globalThis[KEY]) { globalThis[KEY].observer = observer; return; }
  const state = { observer };
  globalThis[KEY] = state;
  const dist = nativeDist(entry);
  if (!dist || typeof module.registerHooks !== 'function') return;
  state.hook = module.registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      try {
        if (!url.startsWith('file:')) return loaded;
        const file = fileURLToPath(url);
        if (!file.startsWith(dist) || !/^subagent-announce-[\w-]+\.js$/.test(path.basename(file))) return loaded;
        const source = typeof loaded.source === 'string' ? loaded.source : loaded.source && Buffer.from(loaded.source).toString('utf8');
        if (!source?.includes('async function runSubagentAnnounceFlow(params)')) return loaded;
        // Require exactly one imported native boundary. Unsupported layouts
        // continue through ordinary Hooks without guessing a delivery.
        const imported = /\b([\w$]+) as deliverSubagentAnnouncement\b/g;
        if ([...source.matchAll(imported)].length !== 1) return loaded;
        const renamed = source.replace(imported, '$1 as pilotNativeDeliverSubagentAnnouncement');
        return { ...loaded, source: renamed + `
async function deliverSubagentAnnouncement(params) {
  const pilotObserver = globalThis[Symbol.for('loongsuite-pilot.openclaw.steered-delivery')]?.observer;
  let pilotReceipt;
  try { pilotReceipt = pilotObserver?.prepare(params); } catch {}
  const pilotResult = await pilotNativeDeliverSubagentAnnouncement(params);
  try { pilotObserver?.complete(pilotReceipt, pilotResult); } catch {}
  return pilotResult;
}
` };
      } catch { return loaded; }
    },
  });
}
