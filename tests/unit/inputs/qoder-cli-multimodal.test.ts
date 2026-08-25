import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  attachmentImageFilenames,
  enrichCliMultimodal,
  extractInputImagePaths,
  extractToolImagePaths,
  resolveImagePath,
} from '../../../src/inputs/qoder-trace/qoder-cli-multimodal.js';
import { statImagePath } from '../../../src/multimodal/resolve.js';
import { MAX_MULTIMODAL_DATA_SIZE, MAX_MULTIMODAL_PARTS } from '../../../src/multimodal/types.js';
import type { UriResult } from '../../../src/multimodal/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'pilot-qoder-cli-mm-'));
  tmpDirs.push(dir);
  return dir;
}

function writePng(dir: string, name: string, content = 'png-bytes'): string {
  const file = path.join(dir, name);
  fsSync.writeFileSync(file, Buffer.from(content));
  return file;
}

function fakePathToUri() {
  return vi.fn(async (filePath: string): Promise<UriResult | null> => {
    const stated = await statImagePath(filePath);
    if (!stated || stated.size <= 0 || stated.size > MAX_MULTIMODAL_DATA_SIZE) return null;
    const bytes = fsSync.readFileSync(stated.resolvedPath);
    return {
      uri: `oss://test/${bytes.toString('utf8')}`,
      mime_type: stated.mime_type,
      modality: 'image',
      size: stated.size,
      sha256: 'deadbeef',
    };
  });
}

function cliEntry(overrides: Partial<AgentActivityEntry> = {}): AgentActivityEntry {
  return {
    'event.id': 'e1',
    'event.name': 'other',
    'gen_ai.agent.type': 'qoder-cli',
    'gen_ai.session.id': 'sess',
    'gen_ai.turn.id': 'turn-1',
    time_unix_nano: String(1_700_000_000_000_000_000n),
    ...overrides,
  } as AgentActivityEntry;
}

describe('extractInputImagePaths / extractToolImagePaths', () => {
  it('parses paste Image:source and @ relative/absolute paths', () => {
    if (process.platform === 'win32') {
      const cwd = 'C:\\Users\\me\\workspace';
      expect(extractInputImagePaths(
        '[Image: source: C:\\tmp\\clip.png.png]',
      )).toEqual([path.win32.normalize('C:\\tmp\\clip.png.png')]);
      expect(extractInputImagePaths(
        '@loongsuite-pilot/picture/pipeline.jpg 这个图像是上个图像的扩展？',
        cwd,
      )).toEqual([path.win32.resolve(cwd, 'loongsuite-pilot/picture/pipeline.jpg')]);
      expect(extractInputImagePaths(
        '@C:\\Users\\me\\Documents\\picture\\pipeline.jpg 这个图是一样的？',
      )).toEqual([path.win32.normalize('C:\\Users\\me\\Documents\\picture\\pipeline.jpg')]);
      expect(extractInputImagePaths(
        '[Image: source: docs/_assets/img/dashboard.png, original 2556x1656, displayed at 2000x1296]',
        cwd,
      )).toEqual([path.win32.resolve(cwd, 'docs/_assets/img/dashboard.png')]);
      expect(extractInputImagePaths(
        '[Image: source: C:\\tmp\\chart,final.png]',
      )).toEqual([path.win32.normalize('C:\\tmp\\chart,final.png')]);
      expect(extractInputImagePaths(
        '[Image: source: C:\\tmp\\chart,final.png, original 100x80, displayed at 50x40]',
      )).toEqual([path.win32.normalize('C:\\tmp\\chart,final.png')]);
      return;
    }

    const cwd = '/Users/me/workspace';
    expect(extractInputImagePaths(
      '[Image: source: /tmp/clip.png.png]',
    )).toEqual(['/tmp/clip.png.png']);
    expect(extractInputImagePaths(
      '@loongsuite-pilot/picture/pipeline.jpg 这个图像是上个图像的扩展？',
      cwd,
    )).toEqual([path.join(cwd, 'loongsuite-pilot/picture/pipeline.jpg')]);
    expect(extractInputImagePaths(
      '@/Users/me/Documents/picture/pipeline.jpg 这个图是一样的？',
    )).toEqual(['/Users/me/Documents/picture/pipeline.jpg']);
    expect(extractInputImagePaths(
      '[Image: source: docs/_assets/img/dashboard.png, original 2556x1656, displayed at 2000x1296]',
      cwd,
    )).toEqual([path.join(cwd, 'docs/_assets/img/dashboard.png')]);
    expect(extractInputImagePaths(
      '[Image: source: /tmp/chart,final.png]',
    )).toEqual(['/tmp/chart,final.png']);
    expect(extractInputImagePaths(
      '[Image: source: /tmp/chart,final.png, original 100x80, displayed at 50x40]',
    )).toEqual(['/tmp/chart,final.png']);
  });

  it('unions attachment filename with @ / Image:source and unique-resolves', () => {
    const filename = process.platform === 'win32'
      ? 'C:\\Users\\me\\workspace\\picture\\pipeline.jpg'
      : '/Users/me/workspace/picture/pipeline.jpg';
    const extra = process.platform === 'win32' ? 'C:\\tmp\\extra.png' : '/tmp/extra.png';
    const cwd = process.platform === 'win32' ? 'C:\\Users\\me\\workspace' : '/Users/me/workspace';
    const entry = cliEntry({
      'event.name': 'llm.request',
      'agent.qoder.cwd': cwd as any,
      'agent.qoder.attachments': [
        { type: 'image_file', filename, displayPath: 'picture/pipeline.jpg' },
        { type: 'skill_listing', filename: '/tmp/ignore.png' },
      ] as any,
      'gen_ai.input.messages_delta': [
        {
          role: 'user',
          parts: [
            { type: 'text', content: '@picture/pipeline.jpg 用一句话说明这张图' },
            { type: 'text', content: `[Image: source: ${extra}]` },
          ],
        },
      ],
    });
    expect(attachmentImageFilenames(entry)).toEqual([filename]);
    const resolvedFilename = process.platform === 'win32' ? path.win32.normalize(filename) : filename;
    const resolvedExtra = process.platform === 'win32' ? path.win32.normalize(extra) : extra;
    expect(extractInputImagePaths(entry, cwd)).toEqual([resolvedFilename, resolvedExtra]);
  });

  it('parses Read image / Image file / ImageGen tool texts', () => {
    if (process.platform === 'win32') {
      const cwd = 'C:\\Users\\me\\proj';
      expect(extractToolImagePaths('Read image: picture/pipeline.jpg (52KB)', cwd)).toEqual([
        path.win32.resolve(cwd, 'picture/pipeline.jpg'),
      ]);
      expect(extractToolImagePaths('Image file: C:\\tmp\\a.png')).toEqual([
        path.win32.normalize('C:\\tmp\\a.png'),
      ]);
      expect(extractToolImagePaths(
        'Image generated successfully! The absolute path of the image is: C:\\tmp\\gen.png\nRequest ID: x',
      )).toEqual([path.win32.normalize('C:\\tmp\\gen.png')]);
      return;
    }

    const cwd = '/Users/me/proj';
    expect(extractToolImagePaths('Read image: picture/pipeline.jpg (52KB)', cwd)).toEqual([
      path.join(cwd, 'picture/pipeline.jpg'),
    ]);
    expect(extractToolImagePaths('Image file: /tmp/a.png')).toEqual(['/tmp/a.png']);
    expect(extractToolImagePaths(
      'Image generated successfully! The absolute path of the image is: /tmp/gen.png\nRequest ID: x',
    )).toEqual(['/tmp/gen.png']);
  });

  it('ignores glob listings and non-image @ mentions', () => {
    expect(extractToolImagePaths('docs/_assets/img/dashboard.png\npicture/pipeline.jpg')).toEqual([]);
    expect(extractInputImagePaths('hello @someone please look')).toEqual([]);
    expect(extractInputImagePaths(
      'picture/pipeline.jpg这个是什么？',
      process.platform === 'win32' ? 'C:\\tmp' : '/tmp',
    )).toEqual([]);
  });

  it('resolveImagePath joins cwd only for relative paths', () => {
    if (process.platform === 'win32') {
      expect(resolveImagePath('C:\\abs\\a.png', 'C:\\cwd')).toBe(path.win32.normalize('C:\\abs\\a.png'));
      expect(resolveImagePath('rel\\a.png', 'C:\\cwd')).toBe(path.win32.resolve('C:\\cwd', 'rel\\a.png'));
      return;
    }

    expect(resolveImagePath('/abs/a.png', '/cwd')).toBe(path.normalize('/abs/a.png'));
    expect(resolveImagePath('rel/a.png', '/cwd')).toBe(path.resolve('/cwd', 'rel/a.png'));
  });
});

describe('enrichCliMultimodal', () => {
  it('input mode attaches paste source onto every carrier that has the path', async () => {
    const dir = makeTempDir();
    const img = writePng(dir, 'clip.png', 'clip');
    writePng(dir, 'at.png', 'at');
    const pathToUri = fakePathToUri();
    const other = cliEntry({
      'event.name': 'other',
      'gen_ai.input.messages_delta': [
        {
          role: 'user',
          parts: [
            { type: 'text', content: `[Image #0]看图` },
            { type: 'text', content: `[Image: source: ${img}]` },
          ],
        },
      ],
    });
    const request = cliEntry({
      'event.name': 'llm.request',
      'gen_ai.input.messages_delta': [
        {
          role: 'user',
          parts: [
            { type: 'text', content: `[Image #0]看图` },
            { type: 'text', content: `[Image: source: ${img}]` },
          ],
        },
      ],
    });
    await enrichCliMultimodal([other, request], { uploadMode: 'input', pathToUri });
    expect((request['gen_ai.input.messages_delta'] as any[])[0].parts.some(
      (p: any) => p.type === 'uri' && p.uri === 'oss://test/clip',
    )).toBe(true);
    expect((other['gen_ai.input.messages_delta'] as any[])[0].parts.some(
      (p: any) => p.type === 'uri' && p.uri === 'oss://test/clip',
    )).toBe(true);

    const atReq = cliEntry({
      'event.name': 'llm.request',
      'gen_ai.turn.id': 'turn-at',
      'agent.qoder.cwd': dir as any,
      'gen_ai.input.messages_delta': [
        { role: 'user', parts: [{ type: 'text', content: `@at.png 这是什么` }] },
      ],
    });
    await enrichCliMultimodal([atReq], { uploadMode: 'input', pathToUri: fakePathToUri() });
    expect((atReq['gen_ai.input.messages_delta'] as any[])[0].parts.some(
      (p: any) => p.type === 'uri' && p.uri === 'oss://test/at',
    )).toBe(true);
  });

  it('keeps @ image on the first llm.request when a later same-turn request has no image', async () => {
    const dir = makeTempDir();
    writePng(dir, 'pipeline.jpg', 'pipe');
    const first = cliEntry({
      'event.name': 'llm.request',
      'gen_ai.step.id': 't:s1',
      'agent.qoder.cwd': dir as any,
      'gen_ai.input.messages_delta': [
        { role: 'user', parts: [{ type: 'text', content: `@${path.join(dir, 'pipeline.jpg')}` }] },
      ],
    });
    const followUp = cliEntry({
      'event.name': 'llm.request',
      'gen_ai.step.id': 't:s2',
      'agent.qoder.cwd': dir as any,
      'gen_ai.input.messages_delta': [
        { role: 'user', parts: [{ type: 'text', content: 'tool follow-up without image' }] },
      ],
    });
    await enrichCliMultimodal([first, followUp], { uploadMode: 'input', pathToUri: fakePathToUri() });
    expect((first['gen_ai.input.messages_delta'] as any[])[0].parts.some(
      (p: any) => p.type === 'uri' && p.uri === 'oss://test/pipe',
    )).toBe(true);
    expect((followUp['gen_ai.input.messages_delta'] as any[])[0].parts.some(
      (p: any) => p.type === 'uri',
    )).toBe(false);
  });

  it('tool mode rewrites Read image and ImageGen results; input/output skip tool', async () => {
    const dir = makeTempDir();
    const img = writePng(dir, 'read.png', 'read-img');
    const gen = writePng(dir, 'gen.png', 'gen-img');
    const makeRead = () => cliEntry({
      'event.name': 'tool.result',
      'gen_ai.tool.name': 'Read',
      'gen_ai.tool.call.result': `Read image: ${img} (31KB)`,
    });
    const makeGen = () => cliEntry({
      'event.name': 'tool.result',
      'gen_ai.tool.name': 'ImageGen',
      'gen_ai.tool.call.result':
        `Image generated successfully! The absolute path of the image is: ${gen}\nRequest ID: abc`,
    });

    for (const mode of ['input', 'output'] as const) {
      const tool = makeRead();
      const before = tool['gen_ai.tool.call.result'];
      await enrichCliMultimodal([tool], { uploadMode: mode, pathToUri: fakePathToUri() });
      expect(tool['gen_ai.tool.call.result'], mode).toBe(before);
    }

    const read = makeRead();
    await enrichCliMultimodal([read], { uploadMode: 'tool', pathToUri: fakePathToUri() });
    const readParts = read['gen_ai.tool.call.result'] as any[];
    expect(readParts[0]).toEqual({ type: 'text', content: `Read image: ${img} (31KB)` });
    expect(readParts.some((p: any) => p.type === 'uri' && p.uri === 'oss://test/read-img')).toBe(true);

    const genEntry = makeGen();
    await enrichCliMultimodal([genEntry], { uploadMode: 'both', pathToUri: fakePathToUri() });
    expect((genEntry['gen_ai.tool.call.result'] as any[]).some(
      (p: any) => p.type === 'uri' && p.uri === 'oss://test/gen-img',
    )).toBe(true);
  });

  it('uploadMode none / missing file / toUri null leave entries unchanged', async () => {
    const dir = makeTempDir();
    const img = writePng(dir, 'x.png', 'x');
    const tool = cliEntry({
      'event.name': 'tool.result',
      'gen_ai.tool.call.result': `Read image: ${img} (1KB)`,
    });
    const before = structuredClone(tool);
    await enrichCliMultimodal([tool], { uploadMode: 'none', pathToUri: fakePathToUri() });
    expect(tool).toEqual(before);

    const missing = cliEntry({
      'event.name': 'tool.result',
      'gen_ai.tool.call.result': 'Read image: /no/such/file.png (1KB)',
    });
    await enrichCliMultimodal([missing], { uploadMode: 'tool', pathToUri: fakePathToUri() });
    expect(missing['gen_ai.tool.call.result']).toBe('Read image: /no/such/file.png (1KB)');

    const nullUri = cliEntry({
      'event.name': 'tool.result',
      'gen_ai.tool.call.result': `Read image: ${img} (1KB)`,
    });
    await enrichCliMultimodal([nullUri], { uploadMode: 'tool', pathToUri: async () => null });
    expect(nullUri['gen_ai.tool.call.result']).toBe(`Read image: ${img} (1KB)`);
  });

  it('caps converted images at MAX_MULTIMODAL_PARTS; extract already unique-paths', async () => {
    const dir = makeTempDir();
    const paths: string[] = [];
    for (let i = 0; i < MAX_MULTIMODAL_PARTS + 3; i++) {
      paths.push(writePng(dir, `n${i}.png`, `img-${i}`));
    }
    const tool = cliEntry({
      'event.name': 'tool.result',
      'gen_ai.tool.call.result': paths.map(p => `Read image: ${p} (1KB)`).join('\n'),
    });
    await enrichCliMultimodal([tool], { uploadMode: 'tool', pathToUri: fakePathToUri() });
    const uriCount = (tool['gen_ai.tool.call.result'] as any[]).filter((p: any) => p.type === 'uri').length;
    expect(uriCount).toBe(MAX_MULTIMODAL_PARTS);

    const one = writePng(dir, 'dup.png', 'dup');
    const dup = cliEntry({
      'event.name': 'tool.result',
      'gen_ai.turn.id': 'dup-turn',
      'gen_ai.tool.call.result': `Read image: ${one} (1KB)\nImage file: ${one}`,
    });
    await enrichCliMultimodal([dup], { uploadMode: 'tool', pathToUri: fakePathToUri() });
    const dupUris = (dup['gen_ai.tool.call.result'] as any[]).filter((p: any) => p.type === 'uri');
    expect(dupUris).toHaveLength(1);
  });

  it('does not throw when pathToUri throws; original result text remains', async () => {
    const dir = makeTempDir();
    const img = writePng(dir, 'boom.png', 'boom');
    const tool = cliEntry({
      'event.name': 'tool.result',
      'gen_ai.tool.call.result': `Read image: ${img} (1KB)`,
    });
    await expect(enrichCliMultimodal([tool], {
      uploadMode: 'tool',
      pathToUri: async () => {
        throw new Error('processor boom');
      },
    })).resolves.toBeUndefined();
    expect(tool['gen_ai.tool.call.result']).toBe(`Read image: ${img} (1KB)`);
  });

  it('relative Read image joins agent.qoder.cwd', async () => {
    const dir = makeTempDir();
    writePng(dir, 'rel.png', 'rel-img');
    const tool = cliEntry({
      'event.name': 'tool.result',
      'agent.qoder.cwd': dir as any,
      'gen_ai.tool.call.result': 'Read image: rel.png (1KB)',
    });
    await enrichCliMultimodal([tool], { uploadMode: 'tool', pathToUri: fakePathToUri() });
    expect((tool['gen_ai.tool.call.result'] as any[]).some(
      (p: any) => p.type === 'uri' && p.uri === 'oss://test/rel-img',
    )).toBe(true);
  });
});
