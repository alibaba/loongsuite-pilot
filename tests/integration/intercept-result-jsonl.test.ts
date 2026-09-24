import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { InputManager } from '../../src/core/input-manager.js';
import { InterceptResultLinker } from '../../src/core/intercept-result-linker.js';
import { ToolVerdictStore } from '../../src/interceptor/tool-verdict-store.js';
import { JsonlFlusher } from '../../src/flushers/jsonl-flusher.js';
import { ClientType, CollectionMethod } from '../../src/types/index.js';
import { buildTestEntry, cleanupTempDir, createTempDir } from '../helpers/fixture-builder.js';

class StubInput extends EventEmitter {
  readonly id = 'qoder-trace';
  readonly agentType = ClientType.Qoder;
  readonly collectionMethod = CollectionMethod.HookJsonl;
  async start() {}
  async stop() {}
}

describe('interceptor result JSONL output', () => {
  it('writes guardrail fields onto flushed tool events', async () => {
    const root = await createTempDir('intercept-jsonl-');
    const outputDir = path.join(root, 'output');
    const store = new ToolVerdictStore(path.join(root, 'tool-verdicts.json'));
    store.put({ sessionId: 'native-session', toolUseId: 'call-1', phase: 'PreToolUse' }, 'allow');
    store.put({ sessionId: 'native-session', toolUseId: 'call-1', phase: 'PostToolUse' }, 'deny');

    const manager = new InputManager();
    const flusher = new JsonlFlusher({
      enabled: true,
      outputDir,
      rotateDaily: true,
      maxFileSizeMb: 10,
    });
    await flusher.start();
    manager.setFlusher(flusher);
    manager.setInterceptResultLinker(new InterceptResultLinker(store, true));
    const input = new StubInput();
    manager.registerInput(input as any);

    input.emit('entries', [
      buildTestEntry({
        'event.name': 'tool.call',
        'event.id': 'call',
        'gen_ai.session.id': 'native-session',
        'gen_ai.tool.call.id': 'call-1',
        'gen_ai.tool.name': 'Bash',
      }),
      buildTestEntry({
        'event.name': 'tool.result',
        'event.id': 'result',
        'gen_ai.session.id': 'native-session',
        'gen_ai.tool.call.id': 'call-1',
        'gen_ai.tool.name': 'Bash',
      }),
    ]);
    await manager.stopAll();
    await flusher.shutdown();

    const files = (await fs.readdir(outputDir)).filter(name => name.endsWith('.jsonl'));
    expect(files).toHaveLength(1);
    const lines = (await fs.readFile(path.join(outputDir, files[0]!), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({
      'event.name': 'tool.call',
      'gen_ai.guardrail.triggered': true,
      'gen_ai.guardrail.action': 'allow',
    });
    expect(lines[1]).toMatchObject({
      'event.name': 'tool.result',
      'gen_ai.guardrail.triggered': true,
      'gen_ai.guardrail.action': 'deny',
    });
    await cleanupTempDir(root);
  });
});
