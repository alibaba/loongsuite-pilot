import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// Red-light tests for the not-yet-implemented model name cache. The module
// is added in commit 5; until then this file pins the contract so the
// hook-processor → trace-input pipeline can use displayName as a sidecar
// attribute without disturbing model_source enrichment.
const CACHE_MODULE = '../../../../src/inputs/qoder-work-trace/qoderwork-model-name-cache.js';

async function importCache() {
  // Imported lazily: the module does not exist yet.
  return import(CACHE_MODULE);
}

function streamResponseLine(payload: object, ts = '2026-06-18T01:35:54.477Z') {
  return `[${ts}] [INFO] [QODERCLI] [QueryHandler] StreamResponse ${JSON.stringify(payload)}`;
}

describe('QoderWorkModelNameCache', () => {
  let tmpRoot: string;
  let logFile: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qoderwork-model-name-cache-'));
    logFile = path.join(tmpRoot, 'qodercli.log');
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('parses StreamResponse lines and resolves modelKey → displayName', async () => {
    const { QoderWorkModelNameCache } = await importCache();
    await fs.writeFile(logFile, [
      '[2026-06-18T01:35:54.477Z] [INFO] [QODERCLI] startup line, irrelevant',
      streamResponseLine({ modelKey: 'qwork-ultimate', displayName: 'Premium', isReasoning: true, querySource: 'coder' }),
      streamResponseLine({ modelKey: 'qwork-auto', displayName: 'Standard', isReasoning: false, querySource: 'coder' }),
    ].join('\n') + '\n');

    const cache = new QoderWorkModelNameCache({ logFile });
    await cache.refresh();
    expect(cache.resolve('qwork-ultimate').displayName).toBe('Premium');
    expect(cache.resolve('qwork-auto').displayName).toBe('Standard');
    expect(cache.resolve('not-seen').displayName).toBeUndefined();
  });

  it('does not pollute cache when displayName is missing on a legacy line', async () => {
    const { QoderWorkModelNameCache } = await importCache();
    await fs.writeFile(logFile, [
      streamResponseLine({ modelKey: 'qwork-legacy', isReasoning: false }),
      streamResponseLine({ modelKey: 'qwork-ultimate', displayName: 'Premium' }),
    ].join('\n') + '\n');

    const cache = new QoderWorkModelNameCache({ logFile });
    await cache.refresh();
    // 旧版日志缺 displayName 不能写脏 cache
    expect(cache.resolve('qwork-legacy').displayName).toBeUndefined();
    expect(cache.resolve('qwork-ultimate').displayName).toBe('Premium');
  });

  it('reads only newly appended lines on incremental refresh', async () => {
    const { QoderWorkModelNameCache } = await importCache();
    await fs.writeFile(logFile, [
      streamResponseLine({ modelKey: 'qwork-ultimate', displayName: 'Premium' }),
    ].join('\n') + '\n');

    const cache = new QoderWorkModelNameCache({ logFile });
    await cache.refresh();
    const stats1 = cache.getStats?.() ?? { linesParsed: undefined };
    expect(cache.resolve('qwork-ultimate').displayName).toBe('Premium');

    // append 一条新行
    await fs.appendFile(logFile, streamResponseLine({ modelKey: 'qwork-auto', displayName: 'Standard' }) + '\n');
    await cache.refresh();
    expect(cache.resolve('qwork-auto').displayName).toBe('Standard');
    if (stats1.linesParsed !== undefined) {
      const stats2 = cache.getStats!();
      // 增量解析：第二次只读了新增的 1 条
      expect(stats2.linesParsed - stats1.linesParsed).toBe(1);
    }
  });

  it('resets offset and re-reads on truncate (size shrinks below previous offset)', async () => {
    const { QoderWorkModelNameCache } = await importCache();
    await fs.writeFile(logFile, [
      streamResponseLine({ modelKey: 'qwork-ultimate', displayName: 'Premium' }),
      streamResponseLine({ modelKey: 'qwork-auto', displayName: 'Standard' }),
    ].join('\n') + '\n');

    const cache = new QoderWorkModelNameCache({ logFile });
    await cache.refresh();
    expect(cache.resolve('qwork-ultimate').displayName).toBe('Premium');
    expect(cache.resolve('qwork-auto').displayName).toBe('Standard');

    // 文件被截断后重写
    await fs.writeFile(logFile, [
      streamResponseLine({ modelKey: 'qwork-flash', displayName: 'Lite' }),
    ].join('\n') + '\n');
    await cache.refresh();
    expect(cache.resolve('qwork-flash').displayName).toBe('Lite');
  });

  it('scans runs/<id>/qodercli.log when logFile points to a directory', async () => {
    const { QoderWorkModelNameCache } = await importCache();
    // 构造 directory 模式：根目录 + runs/ 子目录
    const runsDir = path.join(tmpRoot, 'runs');
    await fs.mkdir(runsDir);
    const older = path.join(runsDir, '2026-06-24T10-00-00-000+08-00-run1');
    const newer = path.join(runsDir, '2026-06-25T10-00-00-000+08-00-run2');
    await fs.mkdir(older);
    await fs.mkdir(newer);
    await fs.writeFile(
      path.join(older, 'qodercli.log'),
      streamResponseLine({ modelKey: 'qwork-ultimate', displayName: 'Premium' }) + '\n',
    );
    await fs.writeFile(
      path.join(newer, 'qodercli.log'),
      streamResponseLine({ modelKey: 'qwork-auto', displayName: 'Standard' }) + '\n',
    );
    // mtime 排序：newer 比 older 更新
    const later = new Date(Date.now() + 1000);
    await fs.utimes(path.join(newer, 'qodercli.log'), later, later);

    const cache = new QoderWorkModelNameCache({ logFile: tmpRoot });
    await cache.refresh();
    expect(cache.resolve('qwork-ultimate').displayName).toBe('Premium');
    expect(cache.resolve('qwork-auto').displayName).toBe('Standard');
    const stats = cache.getStats!();
    expect(stats.watchedFiles).toBeGreaterThanOrEqual(2);
  });
});
