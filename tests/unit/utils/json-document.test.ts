import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  editJsonc,
  parseJsonDocument,
  readJsonDocument,
} from '../../../src/utils/json-document.js';

// A leading UTF-8 BOM must not make an agent settings file look invalid.
//
// These files belong to the user's editor and toolchain, not to us: PowerShell 5.1's
// `Set-Content -Encoding UTF8` always emits a BOM (no utf8NoBOM before PS 6) and so
// does Notepad, so a BOM'd ~/.claude/settings.json or ~/.cursor/hooks.json is a
// routine state on Windows. Both parser branches used to reject it — JSON.parse
// throws, and jsonc-parser reports a parse error that parseJsonDocument treats as
// fatal — which failed hook *deploy and remove*, not merely a read.
//
// The strip lives in parseJsonDocument rather than readJsonDocument on purpose:
// callers pass the returned `raw` back as the expected content of a compare-and-swap
// write and as the base text for editJsonc, so it must stay byte-identical to disk.
// The last two tests pin that invariant; without them, "fix" the read instead and the
// guarded write starts failing with "file changed before write".

const withBom = (s: string) => `\uFEFF${s}`;

describe('parseJsonDocument with a leading BOM', () => {
  it('parses BOM-prefixed strict JSON', () => {
    const r = parseJsonDocument<{ model: string }>(withBom('{"model":"pilot"}'), 'json');
    expect(r.ok).toBe(true);
    expect(r.ok && r.data.model).toBe('pilot');
  });

  it('parses BOM-prefixed JSONC, comments and trailing commas included', () => {
    // The jsonc branch backs hook deploy/remove (hook-manager's settings edits), so
    // its BOM handling is the one that breaks writes, not just reads.
    const raw = withBom('{\n  // pilot\n  "hooks": {"a": 1},\n}');
    const r = parseJsonDocument<{ hooks: Record<string, number> }>(raw, 'jsonc');
    expect(r.ok).toBe(true);
    expect(r.ok && r.data.hooks.a).toBe(1);
  });

  it('still reports malformed content as an error, BOM or not', () => {
    expect(parseJsonDocument(withBom('{"a":'), 'json').ok).toBe(false);
    expect(parseJsonDocument('{"a":', 'json').ok).toBe(false);
    expect(parseJsonDocument(withBom('{"a": }'), 'jsonc').ok).toBe(false);
  });

  it('strips only a leading BOM, leaving one inside a string intact', () => {
    const r = parseJsonDocument<{ note: string }>('{"note":"a\uFEFFb"}', 'json');
    expect(r.ok && r.data.note).toBe('a\uFEFFb');
  });
});

describe('readJsonDocument keeps raw byte-exact', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'json-doc-test-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('returns the BOM in raw while still parsing the data', async () => {
    const target = path.join(dir, 'settings.json');
    // Byte-for-byte what `Set-Content -Encoding UTF8` produces.
    await fs.writeFile(target, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('{"model":"pilot"}\n', 'utf8'),
    ]));

    const doc = await readJsonDocument<{ model: string }>(target, 'json');
    expect(doc.status).toBe('ok');
    if (doc.status !== 'ok') return;
    expect(doc.data.model).toBe('pilot');
    // Load-bearing: raw is the compare-and-swap baseline, so it must equal the file
    // on disk, BOM included.
    expect(doc.raw).toBe('\uFEFF{"model":"pilot"}\n');
    expect(doc.raw).toBe(await fs.readFile(target, 'utf8'));
  });

  it('editJsonc round-trips BOM-prefixed text and preserves the BOM', () => {
    const raw = '\uFEFF{\n  "model": "old"\n}\n';
    const next = editJsonc(raw, ['model'], 'pilot');
    expect(next.startsWith('\uFEFF')).toBe(true);
    const r = parseJsonDocument<{ model: string }>(next, 'jsonc');
    expect(r.ok && r.data.model).toBe('pilot');
  });
});
