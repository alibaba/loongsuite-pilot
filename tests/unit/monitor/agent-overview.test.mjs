import { appendFile, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
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
      'agent.qoder.variant': 'qoder-cli',
    })).toBe('qoder-cli');
    expect(classifyRecord({
      'agent.qoderwork.variant': 'qoder-work',
    })).toBe('qoder-work');
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

  it('indexes cold large files in bounded batches without exposing message bodies', async () => {
    const dataDir = await fixtureDir();
    await writeRuntimeFiles(dataDir, {
      outputLines: {
        'cursor-2026-05-05.jsonl': [
          eventLine({ id: 'cursor-1', agentType: 'cursor', eventName: 'tool.result', tokens: 10, output: 'old sensitive body' }),
          eventLine({ id: 'cursor-2', agentType: 'cursor', eventName: 'tool.result', tokens: 20 }),
        ],
      },
    });

    const overview = await createOverviewAggregator({
      dataDir,
      nowProvider: () => new Date('2026-05-05T04:01:00.000Z'),
      maxIndexLinesPerRefresh: 1,
    }).getOverview({ force: true });

    expect(overview.cache.bounded).toBe(true);
    expect(overview.cache.indexing).toBe(true);
    expect(overview.cache.outputPartial).toBe(true);
    expect(overview.agents.find((agent) => agent.id === 'cursor').tokensToday).toBe(10);
    expect(overview.agents.find((agent) => agent.id === 'cursor').warnings.join(' ')).toContain('indexing');
    expect(JSON.stringify(overview)).not.toContain('old sensitive body');
  });

  it('continues indexing from the saved offset until totals catch up', async () => {
    const dataDir = await fixtureDir();
    await writeRuntimeFiles(dataDir, {
      outputLines: {
        'qoder-2026-05-05.jsonl': [
          eventLine({ id: 'qoder-1', agentType: 'qoder', eventName: 'llm.response', tokens: 10 }),
          eventLine({ id: 'qoder-2', agentType: 'qoder', eventName: 'llm.response', tokens: 20 }),
          eventLine({ id: 'qoder-3', agentType: 'qoder', eventName: 'llm.response', tokens: 30 }),
        ],
      },
    });
    const aggregator = createOverviewAggregator({
      dataDir,
      nowProvider: () => new Date('2026-05-05T04:01:00.000Z'),
      maxIndexLinesPerRefresh: 1,
    });

    const first = await aggregator.getOverview({ force: true });
    const second = await aggregator.getOverview({ force: true });
    const third = await aggregator.getOverview({ force: true });

    expect(first.totals.tokensToday).toBe(10);
    expect(first.cache.indexing).toBe(true);
    expect(second.totals.tokensToday).toBe(30);
    expect(second.cache.indexing).toBe(true);
    expect(third.totals.tokensToday).toBe(60);
    expect(third.cache.indexing).toBe(false);
  });

  it('processes only appended records after a file is fully indexed', async () => {
    const dataDir = await fixtureDir();
    const outputPath = path.join(dataDir, 'logs', 'output', 'qoder-2026-05-05.jsonl');
    await writeRuntimeFiles(dataDir, {
      outputLines: {
        'qoder-2026-05-05.jsonl': [
          eventLine({ id: 'qoder-1', agentType: 'qoder', eventName: 'llm.response', tokens: 10 }),
        ],
      },
    });
    const aggregator = createOverviewAggregator({
      dataDir,
      nowProvider: () => new Date('2026-05-05T04:01:00.000Z'),
    });

    const first = await aggregator.getOverview({ force: true });
    await appendFile(outputPath, `\n${eventLine({ id: 'qoder-2', agentType: 'qoder', eventName: 'llm.response', tokens: 20 })}`);
    const second = await aggregator.getOverview({ force: true });

    expect(first.totals.tokensToday).toBe(10);
    expect(first.cache.indexing).toBe(false);
    expect(second.totals.tokensToday).toBe(30);
    expect(second.cache.indexing).toBe(false);
  });

  it('rebuilds in bounded batches when a file shrinks', async () => {
    const dataDir = await fixtureDir();
    const outputPath = path.join(dataDir, 'logs', 'output', 'qoder-2026-05-05.jsonl');
    await writeRuntimeFiles(dataDir, {
      outputLines: {
        'qoder-2026-05-05.jsonl': [
          eventLine({ id: 'qoder-1', agentType: 'qoder', eventName: 'llm.response', tokens: 10 }),
          eventLine({ id: 'qoder-2', agentType: 'qoder', eventName: 'llm.response', tokens: 20 }),
        ],
      },
    });
    const aggregator = createOverviewAggregator({
      dataDir,
      nowProvider: () => new Date('2026-05-05T04:01:00.000Z'),
      maxIndexLinesPerRefresh: 1,
    });
    await aggregator.getOverview({ force: true });
    await aggregator.getOverview({ force: true });

    await writeFile(outputPath, eventLine({ id: 'qoder-new', agentType: 'qoder', eventName: 'llm.response', tokens: 5 }));
    const rebuilt = await aggregator.getOverview({ force: true });

    expect(rebuilt.totals.tokensToday).toBe(5);
    expect(rebuilt.cache.indexing).toBe(false);
  });

  it('rebuilds cached totals when a fully indexed file changes without changing size', async () => {
    const dataDir = await fixtureDir();
    const outputPath = path.join(dataDir, 'logs', 'output', 'qoder-2026-05-05.jsonl');
    const original = eventLine({ id: 'qoder-1', agentType: 'qoder', eventName: 'llm.response', tokens: 10 });
    await writeRuntimeFiles(dataDir, {
      outputLines: {
        'qoder-2026-05-05.jsonl': [original],
      },
    });
    const aggregator = createOverviewAggregator({
      dataDir,
      nowProvider: () => new Date('2026-05-05T04:01:00.000Z'),
    });

    const first = await aggregator.getOverview({ force: true });
    const rewritten = eventLine({ id: 'qoder-2', agentType: 'qoder', eventName: 'llm.response', tokens: 20 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(outputPath, rewritten.padEnd(Buffer.byteLength(original), ' '));
    const rebuilt = await aggregator.getOverview({ force: true });

    expect(Buffer.byteLength(rewritten.padEnd(Buffer.byteLength(original), ' '))).toBe(Buffer.byteLength(original));
    expect(first.totals.tokensToday).toBe(10);
    expect(rebuilt.totals.tokensToday).toBe(20);
    expect(rebuilt.cache.indexing).toBe(false);
  });

  it('persists derived cache across aggregator instances without storing sensitive bodies', async () => {
    const dataDir = await fixtureDir();
    await writeRuntimeFiles(dataDir, {
      outputLines: {
        'qoder-2026-05-05.jsonl': [
          eventLine({ id: 'qoder-1', agentType: 'qoder', eventName: 'llm.response', tokens: 10, output: 'secret qoder body' }),
          eventLine({ id: 'qoder-2', agentType: 'qoder', eventName: 'llm.response', tokens: 20 }),
        ],
      },
    });
    const firstAggregator = createOverviewAggregator({
      dataDir,
      nowProvider: () => new Date('2026-05-05T04:01:00.000Z'),
    });
    await firstAggregator.getOverview({ force: true });

    const secondOverview = await createOverviewAggregator({
      dataDir,
      nowProvider: () => new Date('2026-05-05T04:02:00.000Z'),
      maxIndexLinesPerRefresh: 1,
    }).getOverview({ force: true });
    const cacheText = await readFile(path.join(dataDir, 'cache', 'agent-overview', 'output-summary-cache.json'), 'utf8');

    expect(secondOverview.totals.tokensToday).toBe(30);
    expect(secondOverview.cache.indexing).toBe(false);
    expect(cacheText).not.toContain('secret qoder body');
  });

  it('prunes previous-day cache entries after date rollover', async () => {
    const dataDir = await fixtureDir();
    await writeRuntimeFiles(dataDir, {
      outputLines: {
        'qoder-2026-05-05.jsonl': [
          eventLine({ id: 'qoder-old', agentType: 'qoder', eventName: 'llm.response', tokens: 10 }),
        ],
        'qoder-2026-05-06.jsonl': [
          eventLine({ id: 'qoder-new', agentType: 'qoder', eventName: 'llm.response', tokens: 20 }),
        ],
      },
    });
    let now = new Date('2026-05-05T23:59:00.000Z');
    const aggregator = createOverviewAggregator({
      dataDir,
      nowProvider: () => now,
    });
    await aggregator.getOverview({ force: true });

    now = new Date('2026-05-06T00:01:00.000Z');
    const nextDay = await aggregator.getOverview({ force: true });
    const cacheText = await readFile(path.join(dataDir, 'cache', 'agent-overview', 'output-summary-cache.json'), 'utf8');

    expect(nextDay.totals.tokensToday).toBe(20);
    expect(cacheText).toContain('qoder-2026-05-06.jsonl');
    expect(cacheText).not.toContain('qoder-2026-05-05.jsonl');
  });

  it('limits cached output activity events per file', async () => {
    const dataDir = await fixtureDir();
    await writeRuntimeFiles(dataDir, {
      outputLines: {
        'qoder-2026-05-05.jsonl': Array.from({ length: 5 }, (_, index) => (
          eventLine({
            id: `qoder-${index}`,
            agentType: 'qoder',
            eventName: 'llm.response',
            tokens: index + 1,
          })
        )),
      },
    });
    await createOverviewAggregator({
      dataDir,
      nowProvider: () => new Date('2026-05-05T04:01:00.000Z'),
      cachedOutputEventsPerFile: 2,
    }).getOverview({ force: true });

    const cache = JSON.parse(await readFile(path.join(dataDir, 'cache', 'agent-overview', 'output-summary-cache.json'), 'utf8'));
    const [entry] = Object.values(cache.files);

    expect(entry.summary.total).toBe(5);
    expect(entry.summary.tokens).toBe(15);
    expect(entry.summary.events).toHaveLength(2);
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

  it('uses the built-in SLS destination when overview config omits sls fields', async () => {
    const savedEnv = snapshotEnv([
      'SLS_MODE',
      'SLS_ENDPOINT',
      'SLS_PROJECT',
      'SLS_LOGSTORE',
      'SLS_ACCESS_KEY_ID',
      'SLS_ACCESS_KEY_SECRET',
    ]);
    clearEnv(Object.keys(savedEnv));

    try {
      const dataDir = await fixtureDir({ withoutSls: true });

      const overview = await createOverviewAggregator({
        dataDir,
        nowProvider: () => new Date('2026-05-05T04:01:00.000Z'),
      }).getOverview({ force: true });

      const sls = overview.reporting.channels.find((channel) => channel.id === 'sls');
      expect(sls.enabled).toBe(true);
      expect(sls.message).toBe('SLS enabled; no persisted upload failures detected');
    } finally {
      restoreEnv(savedEnv);
    }
  });
});

async function fixtureDir(options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'loongsuite-pilot-overview-'));
  await mkdir(path.join(dataDir, 'logs', 'output'), { recursive: true });
  await mkdir(path.join(dataDir, 'sls-failed-logs'), { recursive: true });
  const config = {
    enabled: true,
    dataDir,
  };
  if (!options.withoutSls) {
    config.sls = {
      endpoint: 'https://example.log.aliyuncs.com',
      project: 'project',
      logstore: 'logstore',
    };
  }
  await writeFile(path.join(dataDir, 'config.json'), JSON.stringify(config));
  await writeFile(path.join(dataDir, 'loongsuite-pilot.pid'), String(process.pid));
  return dataDir;
}

function snapshotEnv(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function clearEnv(keys) {
  for (const key of keys) {
    delete process.env[key];
  }
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
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
