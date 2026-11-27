import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { InvocationAttributeStore, isUsableInvocationId } from '../../assets/hooks/shared/invocation-attribute-store.mjs';
import { readInvocationAttributeConfig } from '../../src/invocation-attributes/config.js';
import { InvocationAttributeJoin } from '../../src/invocation-attributes/join.js';
import type { AgentActivityEntry } from '../../src/types/index.js';

type Turn = { sessionId: string; turnId: string };

/** Replays existing producer schemas into the actual Input and common join. */
export class Inventory {
  constructor(private readonly root: string) {}

  async hook(input: { id: string }, records: Record<string, unknown>[], agent: string, expected?: Turn) {
    // Expose the real protected transform method without replacing it.
    const parser = input as unknown as { transformRecord(record: Record<string, unknown>): Promise<AgentActivityEntry | null> };
    const rows: AgentActivityEntry[] = [];
    for (const record of records) {
      const row = await parser.transformRecord(record);
      if (row) rows.push(row);
    }
    await this.verify(input.id, rows, agent, expected);
  }

  async verify(source: string, rows: AgentActivityEntry[], agent: string, expected?: Turn) {
    const matching = rows.filter(row => row['gen_ai.agent.type'] === agent);
    const scopes = matching.flatMap(row => {
      const sessionId = row['gen_ai.session.id'], turnId = row['gen_ai.turn.id'];
      return isUsableInvocationId(sessionId) && isUsableInvocationId(turnId) && sessionId !== turnId
        ? [{ sessionId, turnId }] : [];
    });
    expect(scopes.length).toBeGreaterThan(0);
    const selector = expected ?? scopes[0];
    expect(scopes).toContainEqual(selector);

    const scope = 'native-fixture-source';
    const store = new InvocationAttributeStore({ root: path.join(this.root, 'attribution') });
    try {
      store.register({ agent, scope, invocationId: randomUUID(), selector: { kind: 'turn', ...selector },
        attributes: { 'memory.owner': 'tenant-fixture', 'memory.verified': true, 'memory.step': 6 } });
      await new InvocationAttributeJoin(store, readInvocationAttributeConfig({
        sources: { [source]: { scope, attributePrefixes: ['memory.'] } },
      })!).apply(source, rows);
    } finally { store.close(); }
    for (const row of rows) {
      const selected = row['gen_ai.agent.type'] === agent && row['gen_ai.session.id'] === selector.sessionId
        && row['gen_ai.turn.id'] === selector.turnId;
      if (selected) expect(row).toMatchObject({ 'memory.owner': 'tenant-fixture', 'memory.verified': true, 'memory.step': 6 });
      else expect(row['memory.owner']).toBeUndefined();
    }
    const evidenceDir = process.env.PILOT_MATRIX_EVIDENCE;
    if (evidenceDir) fs.appendFileSync(path.join(evidenceDir, process.pid + '.jsonl'),
      JSON.stringify({ agent, session: selector.sessionId, turn: selector.turnId, caller: source + '#source-fixture-join' }) + '\n',
      { mode: 0o600 });
  }
}
