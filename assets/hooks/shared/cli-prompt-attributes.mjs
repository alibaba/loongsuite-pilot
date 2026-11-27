// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import path from 'node:path';
import { InvocationAttributeStore, isUsableInvocationId } from './invocation-attribute-store.mjs';

export const CLI_INVOCATION_ID_ENV = 'LOONGSUITE_PILOT_INVOCATION_ID';
const SCOPE = 'native-cli-prompt';
const MAX_LOOKUPS = 256;
const rootFor = dataDir => path.join(dataDir, 'state', 'cli-prompt-attributes');

export function cliPromptAttributesEnabled(env = process.env) {
  // Presence opts into the safe path even if the ID is invalid. Never fall back
  // to ambient process attributes on resume just because a witness was lost.
  return Object.hasOwn(env, CLI_INVOCATION_ID_ENV);
}

export function registerCliPromptAttributes(dataDir, agent, event, attributes, env = process.env) {
  const invocationId = env[CLI_INVOCATION_ID_ENV];
  const sessionId = event?.session_id;
  const turnId = event?.prompt_id;
  if (!isUsableInvocationId(invocationId) || !isUsableInvocationId(sessionId) ||
      !isUsableInvocationId(turnId) || sessionId === turnId) return;
  const store = new InvocationAttributeStore({ root: rootFor(dataDir) });
  try {
    // A launcher invocation may claim only one native prompt. Retries or a
    // tool-continuation hook cannot replace the first association.
    store.registerObservedPrompt({ agent, scope: SCOPE, invocationId, selector: { kind: 'turn', sessionId, turnId }, attributes });
    store.prune();
  } finally {
    store.close();
  }
}

export function readCliPromptAttributes(dataDir, agent, sessionId, turns) {
  const result = new Map();
  if (!isUsableInvocationId(sessionId) || !fs.existsSync(path.join(rootFor(dataDir), 'invocations.sqlite'))) return result;
  let store;
  try {
    store = new InvocationAttributeStore({ root: rootFor(dataDir) });
    const ids = new Set(turns.slice(-MAX_LOOKUPS).map(turn => turn.promptId));
    for (const turnId of ids) {
      if (!isUsableInvocationId(turnId) || turnId === sessionId) continue;
      const decision = store.resolve({ agent, scope: SCOPE, selector: { kind: 'turn', sessionId, turnId } });
      if (decision.state === 'bound' || decision.state === 'noAttrs') result.set(turnId, decision.attributes);
    }
  } catch {
    // Store errors must not stop the host or ordinary telemetry. There is no
    // fallback to the current user's attributes on unresolved historical rows.
  } finally {
    store?.close();
  }
  return result;
}
