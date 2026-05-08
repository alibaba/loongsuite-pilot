import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyMethod,
  classifyRecord,
  createOverviewAggregator,
} from '../../../scripts/lib/agent-overview.mjs';

describe('agent overview classification', () => {
  it('maps internal input ids to user-facing agents', () => {
    expect(classifyMethod('cursor-hook')).toBe('cursor');
    expect(classifyMethod('qoder-sqlite')).toBe('qoder');
    expect(classifyMethod('qoder-work-hook')).toBe('qoder-work');
    expect(classifyMethod('qoder-cli-hook')).toBe('qoder-combined');
    expect(classifyMethod('qoder-cli-session')).toBe('qoder-combined');
  });

  it('splits Qoder and Qoder CLI records by variant hints', () => {
    expect(classifyRecord({
      'gen_ai.agent.type': 'qoder',
      'agent.source': 'qoder-sqlite-chat-message',
    })).toBe('qoder');
    expect(classifyRecord({
      'gen_ai.agent.type': 'qoder-cli',
      'agent.qoder_variant': 'qoder-cli',
    })).toBe('qoder-cli');
    expect(classifyRecord({
      'agent.entrypoint': 'cli',
    })).toBe('qoder-cli');
    expect(classifyRecord({
      'agent.type': 'qoder',
      attributes: JSON.stringify({ source: 'qoder-sqlite-chat-message' }),
    })).toBe('qoder');
  });
});

describe('agent overview aggregation', () => {
  it('aggregates service logs, JSONL output, and failed upload logs without exposing message bodies', async () => {
    const dataDir = await fixtureDir();
    await writeRuntimeFiles(dataDir, {
      serviceLog: [
        '[2026-05-05T04:00:00.000Z] [INFO] [Main] AI Agent Input is running {"dataDir":"/tmp/pilot","flushers":["sls","jsonl"]}',
        '[2026-05-05T04:00:01.000Z] [INFO] [InputManager] input started {"id":"qoder-cli-hook"}',
        '[2026-05-05T04:00:02.000Z] [INFO] [InputManager] dispatching entries {"inputId":"qoder-cli-hook","count":2}',
      ].join('\n'),
      outputLines: {
        'qoder-2026-05-05.jsonl': [
          eventLine({
            id: 'qoder-1',
            agentType: 'qoder',
            eventName: 'llm.response',
            tokens: 100,
            attributes: { source: 'qoder-sqlite-chat-message' },
            output: 'secret qoder response',
          }),
        ],
        'qoder-cli-2026-05-05.jsonl': [
          eventLine({
            id: 'cli-1',
            agentType: 'qoder-cli',
            eventName: 'llm.request',
            tokens: 7,
            attributes: { qoder_variant: 'qoder-cli', entrypoint: 'cli' },
            output: 'secret cli prompt',
          }),
        ],
      },
      failedLines: [
        JSON.stringify({ ts: Date.parse('2026-05-05T04:00:03.000Z'), project: 'p', logstore: 'l', error: 'boom' }),
      ],
    });

    const overview = await createOverviewAggregator({
      dataDir,
      nowProvider: () => new Date('2026-05-05T04:01:00.000Z'),
      cacheTtlMs: 1_000,
    }).getOverview({ force: true });

    const qoder = overview.agents.find((agent) => agent.id === 'qoder');
    const qoderCli = overview.agents.find((agent) => agent.id === 'qoder-cli');
    expect(qoder.todayEvents).toBe(1);
    expect(qoder.tokensToday).toBe(100);
    expect(qoderCli.todayEvents).toBe(1);
    expect(qoderCli.tokensToday).toBe(7);
    expect(overview.reporting.failedUploadsToday).toBe(1);
    expect(overview.timeline.some((item) => item.type === 'collection.batch')).toBe(true);
    expect(JSON.stringify(overview)).not.toContain('secret qoder response');
    expect(JSON.stringify(overview)).not.toContain('secret cli prompt');
  });

  it('serves cached summaries within the TTL', async () => {
    const dataDir = await fixtureDir();
    await writeRuntimeFiles(dataDir, {
      outputLines: {
        'cursor-2026-05-05.jsonl': [
          eventLine({ id: 'cursor-1', agentType: 'cursor', eventName: 'tool.call', tokens: 0 }),
        ],
      },
    });

    const aggregator = createOverviewAggregator({
      dataDir,
      nowProvider: () => new Date('2026-05-05T04:01:00.000Z'),
      cacheTtlMs: 60_000,
    });

    const first = await aggregator.getOverview({ force: true });
    const second = await aggregator.getOverview();
    expect(first.cache.hit).toBe(false);
    expect(second.cache.hit).toBe(true);
  });

  it('uses bounded JSONL reads for large files', async () => {
    const dataDir = await fixtureDir();
    const filler = `${JSON.stringify({ output: 'old sensitive body' })}\n`.repeat(200);
    await writeRuntimeFiles(dataDir, {
      outputLines: {
        'cursor-2026-05-05.jsonl': [
          filler,
          eventLine({ id: 'cursor-tail', agentType: 'cursor', eventName: 'tool.result', tokens: 0 }),
        ],
      },
    });

    const overview = await createOverviewAggregator({
      dataDir,
      nowProvider: () => new Date('2026-05-05T04:01:00.000Z'),
      jsonlMaxBytes: 500,
    }).getOverview({ force: true });

    expect(overview.cache.bounded).toBe(true);
    expect(overview.agents.find((agent) => agent.id === 'cursor').warnings.join(' ')).toContain('bounded reads');
    expect(JSON.stringify(overview)).not.toContain('old sensitive body');
  });

  it('marks agents without output evidence as not detected and hides last activity', async () => {
    const dataDir = await fixtureDir();
    await writeRuntimeFiles(dataDir, {
      serviceLog: [
        '[2026-05-05T04:00:00.000Z] [INFO] [InputManager] input started {"id":"claude-code-log"}',
      ].join('\n'),
    });

    const overview = await createOverviewAggregator({
      dataDir,
      nowProvider: () => new Date('2026-05-05T04:01:00.000Z'),
    }).getOverview({ force: true });

    const claude = overview.agents.find((agent) => agent.id === 'claude-code');
    expect(claude.status).toBe('not_detected');
    expect(claude.lastActivityAt).toBe(null);
  });
});

async function fixtureDir() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'loongsuite-pilot-overview-'));
  await mkdir(path.join(dataDir, 'logs', 'output'), { recursive: true });
  await mkdir(path.join(dataDir, 'sls-failed-logs'), { recursive: true });
  await writeFile(path.join(dataDir, 'config.json'), JSON.stringify({
    enabled: true,
    dataDir,
    sls: {
      endpoint: 'https://example.log.aliyuncs.com',
      project: 'project',
      logstore: 'logstore',
    },
  }));
  await writeFile(path.join(dataDir, 'loongsuite-pilot.pid'), String(process.pid));
  return dataDir;
}

async function writeRuntimeFiles(dataDir, options) {
  await writeFile(path.join(dataDir, 'logs', 'loongsuite-pilot-service.log'), options.serviceLog || '');
  for (const [name, lines] of Object.entries(options.outputLines || {})) {
    await writeFile(path.join(dataDir, 'logs', 'output', name), lines.join('\n'));
  }
  if (options.failedLines) {
    await writeFile(path.join(dataDir, 'sls-failed-logs', 'agentActivity.jsonl'), options.failedLines.join('\n'));
  }
}

function eventLine({ id, agentType, eventName, tokens, attributes = {}, output }) {
  return JSON.stringify({
    'event.id': id,
    'event.name': eventName,
    'gen_ai.agent.type': agentType,
    'gen_ai.usage.total_tokens': tokens,
    time_unix_nano: '1777953600000000000',
    ...Object.fromEntries(Object.entries(attributes).map(([key, value]) => [`agent.${key}`, value])),
    'gen_ai.output.messages': output,
  });
}
