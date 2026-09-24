import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_MODULE = pathToFileURL(
  path.resolve(__dirname, '../../../assets/hooks/shared/hook-processor-base.mjs'),
).href;

let dataDir;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-line-records-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function runWorker(source, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
      env: {
        ...process.env,
        LOONGSUITE_PILOT_DATA_DIR: dataDir,
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`worker exited ${code}: ${stderr}`));
    });
  });
}

describe('hook processor per-session line records', () => {
  it('persists concurrent sessions in independent files', async () => {
    const worker = `
      import { updateLineRecord } from ${JSON.stringify(BASE_MODULE)};
      const record = JSON.parse(process.env.TEST_LINE_RECORD);
      if (!updateLineRecord('qoder-work', record.transcriptPath, record.sessionId, record.endLine)) {
        process.exit(1);
      }
    `;
    const expected = Array.from({ length: 4 }, (_, index) => ({
      sessionId: `session-${index}`,
      transcriptPath: path.join(dataDir, `transcript-${index}.jsonl`),
      endLine: 100 + index,
    }));

    await Promise.all(expected.map(record => runWorker(worker, {
      TEST_LINE_RECORD: JSON.stringify(record),
    })));

    const cursorDir = path.join(dataDir, 'state', 'hooks', 'qoder-work-line-records');
    const files = fs.readdirSync(cursorDir).filter(file => file.endsWith('.json'));
    expect(files).toHaveLength(expected.length);

    const persisted = files.map(file =>
      JSON.parse(fs.readFileSync(path.join(cursorDir, file), 'utf-8'))
    );
    expect(new Set(persisted.map(record => record.session_id))).toEqual(
      new Set(expected.map(record => record.sessionId)),
    );
    for (const record of expected) {
      expect(persisted).toContainEqual(expect.objectContaining({
        session_id: record.sessionId,
        transcript_path: record.transcriptPath,
        last_line_count: record.endLine,
      }));
    }
    const rollbackShadow = JSON.parse(fs.readFileSync(
      path.join(dataDir, 'state', 'hooks', 'qoder-work-line-records.json'),
      'utf-8',
    ));
    expect(Object.keys(rollbackShadow)).toHaveLength(expected.length);
    expect(fs.existsSync(
      path.join(dataDir, 'state', 'hooks', 'qoder-work-line-records.json.lock'),
    )).toBe(false);
  }, 30_000);

  it('lazily splits the previous aggregate state into session files', async () => {
    const stateDir = path.join(dataDir, 'state', 'hooks');
    fs.mkdirSync(stateDir, { recursive: true });
    const aggregateFile = path.join(stateDir, 'qoder-work-line-records.json');
    fs.writeFileSync(aggregateFile, JSON.stringify({
      '/tmp/transcript-a.jsonl': {
        session_id: 'session-a',
        last_line_count: 10,
        updated_at: '2026-07-22 10:00:00',
      },
      '/tmp/transcript-b.jsonl': {
        session_id: 'session-b',
        last_line_count: 20,
        updated_at: '2026-07-22 10:01:00',
      },
    }));

    const worker = `
      import { loadLineRecord } from ${JSON.stringify(BASE_MODULE)};
      process.stdout.write(JSON.stringify([
        loadLineRecord('qoder-work', 'session-a'),
        loadLineRecord('qoder-work', 'session-b'),
      ]));
    `;
    const stdout = await runWorker(worker);
    const records = JSON.parse(stdout);

    expect(records).toEqual([
      expect.objectContaining({
        session_id: 'session-a',
        transcript_path: '/tmp/transcript-a.jsonl',
        last_line_count: 10,
      }),
      expect.objectContaining({
        session_id: 'session-b',
        transcript_path: '/tmp/transcript-b.jsonl',
        last_line_count: 20,
      }),
    ]);
    // Keep the aggregate as a locked compatibility shadow so the immediately
    // previous Pilot version can still resume if an upgrade is rolled back.
    expect(fs.existsSync(aggregateFile)).toBe(true);
    expect(
      fs.readdirSync(path.join(stateDir, 'qoder-work-line-records'))
        .filter(file => file.endsWith('.json')),
    ).toHaveLength(2);
  });

  it('reconciles cursor advances written by an old version during rollback', async () => {
    const stateDir = path.join(dataDir, 'state', 'hooks');
    fs.mkdirSync(stateDir, { recursive: true });
    const aggregateFile = path.join(stateDir, 'qoder-work-line-records.json');
    const transcriptPath = '/tmp/transcript-rollback.jsonl';
    fs.writeFileSync(aggregateFile, JSON.stringify({
      [transcriptPath]: {
        session_id: 'session-rollback',
        last_line_count: 10,
        updated_at: '2026-07-22 10:00:00',
      },
    }));

    const worker = `
      import { loadLineRecord } from ${JSON.stringify(BASE_MODULE)};
      process.stdout.write(JSON.stringify(loadLineRecord('qoder-work', 'session-rollback')));
    `;
    expect(JSON.parse(await runWorker(worker))).toMatchObject({ last_line_count: 10 });

    // Simulate the previous version running after rollback and advancing its
    // aggregate cursor format, which does not know about per-session files.
    fs.writeFileSync(aggregateFile, JSON.stringify({
      [transcriptPath]: {
        session_id: 'session-rollback',
        last_line_count: 30,
        updated_at: '2026-07-22 10:05:00',
      },
    }));

    expect(JSON.parse(await runWorker(worker))).toMatchObject({
      session_id: 'session-rollback',
      transcript_path: transcriptPath,
      last_line_count: 30,
    });

    // A stale old-version writer can finish later and carry a newer timestamp.
    // The forward version must still keep line progress monotonic.
    fs.writeFileSync(aggregateFile, JSON.stringify({
      [transcriptPath]: {
        session_id: 'session-rollback',
        last_line_count: 20,
        updated_at: '2026-07-22 10:10:00',
      },
    }));
    expect(JSON.parse(await runWorker(worker))).toMatchObject({ last_line_count: 30 });
  });
});

const {
  getTranscriptLineCount,
  readTranscriptSnapshotLines,
  sliceTranscriptLines,
  readTranscriptLines,
} = await import(BASE_MODULE);

// The pre-Buffer implementation, kept here as an oracle: decode to a UTF-16
// string, count '\n', and add 1 when the final line lacks a trailing newline.
function referenceLineCount(content) {
  let count = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') count++;
  }
  if (content.length > 0 && content[content.length - 1] !== '\n') count++;
  return count;
}

describe('getTranscriptLineCount', () => {
  let file;

  beforeEach(() => {
    file = path.join(dataDir, 'transcript.jsonl');
  });

  it('returns 0 for a nonexistent file', () => {
    expect(getTranscriptLineCount(path.join(dataDir, 'missing.jsonl'))).toBe(0);
  });

  it('returns 0 for an empty file', () => {
    fs.writeFileSync(file, '');
    expect(getTranscriptLineCount(file)).toBe(0);
  });

  const cases = {
    'trailing newline': 'a\nb\nc\n',
    'no trailing newline': 'a\nb\nc',
    'single line no newline': 'only',
    'CRLF endings': 'a\r\nb\r\nc\r\n',
    'CRLF without final newline': 'a\r\nb\r\nc',
    'blank lines': '\n\n\n',
    'multibyte utf-8': '中文一行\n第二行没有换行的多字节内容',
  };

  for (const [name, content] of Object.entries(cases)) {
    it(`matches the reference count for ${name}`, () => {
      fs.writeFileSync(file, content, 'utf-8');
      expect(getTranscriptLineCount(file)).toBe(referenceLineCount(content));
    });
  }
});

describe('readTranscriptSnapshotLines / sliceTranscriptLines', () => {
  let file;

  beforeEach(() => {
    file = path.join(dataDir, 'transcript.jsonl');
  });

  it('reports lineCount 0 and no lines for a nonexistent file', () => {
    const snapshot = readTranscriptSnapshotLines(path.join(dataDir, 'missing.jsonl'));
    expect(snapshot.lineCount).toBe(0);
    expect(snapshot.allLines).toEqual([]);
  });

  it('reports lineCount 0 for an empty file', () => {
    fs.writeFileSync(file, '');
    expect(readTranscriptSnapshotLines(file).lineCount).toBe(0);
  });

  const cases = {
    'trailing newline': 'a\nb\nc\n',
    'no trailing newline': 'a\nb\nc',
    'single line no newline': 'only',
    'CRLF endings': 'a\r\nb\r\nc\r\n',
    'CRLF without final newline': 'a\r\nb\r\nc',
    'blank lines': '\n\n\n',
    'multibyte utf-8': '中文一行\n第二行没有换行的多字节内容',
  };

  for (const [name, content] of Object.entries(cases)) {
    it(`snapshot lineCount agrees with getTranscriptLineCount for ${name}`, () => {
      fs.writeFileSync(file, content, 'utf-8');
      expect(readTranscriptSnapshotLines(file).lineCount).toBe(getTranscriptLineCount(file));
    });

    it(`readTranscriptLines equals sliceTranscriptLines over the snapshot for ${name}`, () => {
      fs.writeFileSync(file, content, 'utf-8');
      const snapshot = readTranscriptSnapshotLines(file);
      for (let start = 0; start <= snapshot.lineCount; start++) {
        for (let end = start; end <= snapshot.lineCount + 1; end++) {
          expect(readTranscriptLines(file, start, end))
            .toEqual(sliceTranscriptLines(snapshot.allLines, start, end));
        }
      }
    });
  }
});
