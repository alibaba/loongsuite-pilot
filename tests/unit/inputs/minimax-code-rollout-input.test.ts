import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { StateStore } from '../../../src/checkpoints/state-store.js';
import { MinimaxCodeRolloutInput } from '../../../src/inputs/minimax-code-rollout/minimax-code-rollout-input.js';

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-code-rollout-test-'));
const ROLLOUT_FIXTURE = path.join(
  __dirname,
  '..',
  'hooks',
  'minimax-code',
  'fixtures',
  'rollout',
  'model-io-sess_test-session-001.jsonl',
);

describe('MinimaxCodeRolloutInput', () => {
  let stateStore: StateStore;

  beforeEach(async () => {
    // Delete any persisted state.json so each test starts with a clean
    // stateStore. Without this, prior tests' persisted turnStepMap / offsets
    // leak into subsequent tests (StateStore.load() re-hydrates from disk).
    fs.rmSync(path.join(TMPDIR, 'state.json'), { force: true });
    stateStore = new StateStore(path.join(TMPDIR, 'state.json'));
    await stateStore.load();
  });

  afterEach(() => {
    // Keep TMPDIR alive across tests; only remove the state.json file so
    // cross-test side effects (e.g. onStart reading the file we wrote) work.
    // Full TMPDIR cleanup happens in a single rmSync at process exit.
    fs.rmSync(path.join(TMPDIR, 'state.json'), { force: true });
  });

  it('id / agentType 与 ClientType.MiniMaxCode 一致', () => {
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    expect(input.id).toBe('minimax-code-rollout');
    expect(input.agentType).toBe('minimax-code');
  });

  it('Round 12: on win32 + 无 sessionDirWindows / sessionDir → 用 Windows 默认 (不是 POSIX fallback)', () => {
    // Round 12 fix (PR #233, copilot suppressed comment): the previous
    // constructor only honored `opts.sessionDirWindows` on Windows; if
    // the caller did not pass it, the constructor fell back to
    // `opts.sessionDir ?? DEFAULT_SESSION_DIR` (the POSIX
    // `~/.minimax-code/rollout`). The Orchestrator calls
    // `new MinimaxCodeRolloutInput({ stateStore })` with no Windows
    // override, so on Windows the input would have tried to read
    // `~/.minimax-code/rollout` (which does not exist on the official
    // MiniMax Code 3.0.60 Windows desktop client) and missed all
    // rollout records. Now the Windows default is
    // `DEFAULT_SESSION_DIR_WINDOWS` ('%APPDATA%/MiniMax/rollout').
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const input = new MinimaxCodeRolloutInput({ stateStore });
      const sessionDir = (input as any).sessionDir;
      // resolveHome is identity for the test env (no %APPDATA% env
      // var set), so the path should be the literal
      // DEFAULT_SESSION_DIR_WINDOWS. Even if resolveHome expanded
      // %APPDATA% on a real Windows host, the path should NOT be
      // the POSIX DEFAULT_SESSION_DIR.
      expect(sessionDir).toBe('%APPDATA%/MiniMax/rollout');
      expect(sessionDir).not.toBe('~/.minimax-code/rollout');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('Round 12: on win32 + 显式 sessionDirWindows → 用显式值 (优先级最高)', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const input = new MinimaxCodeRolloutInput({
        stateStore,
        sessionDirWindows: 'C:\\custom\\path',
      });
      const sessionDir = (input as any).sessionDir;
      expect(sessionDir).toBe('C:\\custom\\path');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('Round 14: on win32 + 仅 sessionDir (无 sessionDirWindows) → 用 sessionDir 覆盖 Windows 默认', () => {
    // Round 14 fix (PR #233, copilot suppressed comment): the Round 12
    // implementation gave sessionDirWindows absolute priority on
    // Windows and IGNORED opts.sessionDir, which contradicted the
    // option comment ("falls back to `sessionDir` if absent"). A
    // caller that wants to override the rollout directory on Windows
    // — e.g. a unit test using TMPDIR, or a custom data-dir
    // deployment — was silently overridden to the Windows default.
    // Now the precedence is consistent on both platforms:
    // sessionDirWindows ?? sessionDir ?? platform-default.
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const input = new MinimaxCodeRolloutInput({
        stateStore,
        sessionDir: 'C:\\custom\\user-supplied',
      });
      const sessionDir = (input as any).sessionDir;
      expect(sessionDir).toBe('C:\\custom\\user-supplied');
      expect(sessionDir).not.toBe('%APPDATA%/MiniMax/rollout');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('Round 12: on POSIX + 无 sessionDir → 用 POSIX 默认 (~/.minimax-code/rollout)', () => {
    // resolveHome expands `~` to the user's home dir, so we check
    // the resolved path ends with the expected suffix instead of
    // exact equality. The fix being tested is "POSIX path used on
    // POSIX, Windows path used on Windows" — not "no expansion".
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      const input = new MinimaxCodeRolloutInput({ stateStore });
      const sessionDir = (input as any).sessionDir;
      // The resolved path should be a POSIX-style home-dir-relative
      // path, NOT a Windows %APPDATA% path. `~` expands to the
      // user's home on POSIX, so we check the suffix.
      expect(sessionDir).toMatch(/\.minimax-code[/\\]rollout$/);
      expect(sessionDir).not.toContain('%APPDATA%');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('discoverSessionFiles 按 model-io-sess_*.jsonl 模式匹配', async () => {
    fs.mkdirSync(path.join(TMPDIR, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(TMPDIR, 'sub', 'model-io-sess_aaa.jsonl'), '');
    fs.writeFileSync(path.join(TMPDIR, 'sub', 'model-io-sess_bbb.jsonl'), '');
    fs.writeFileSync(path.join(TMPDIR, 'sub', 'other-prefix_ccc.jsonl'), '');
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: path.join(TMPDIR, 'sub') });
    const files = await (input as any).discoverSessionFiles();
    expect(files.sort()).toEqual([
      path.join(TMPDIR, 'sub', 'model-io-sess_aaa.jsonl'),
      path.join(TMPDIR, 'sub', 'model-io-sess_bbb.jsonl'),
    ]);
  });

  it('processSessionLine 跳过 type 非 model-io 的记录', async () => {
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const result = await (input as any).processSessionLine(
      { type: 'other', sessionId: 's1' },
      '/tmp/x.jsonl',
    );
    expect(result).toEqual([]);
  });

  it('processSessionLine 缺 sessionId 时从 model-io-sess_<sid>.jsonl 文件名提取', async () => {
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const rec = JSON.parse(fs.readFileSync(ROLLOUT_FIXTURE, 'utf-8').split('\n')[0]);
    delete rec.sessionId;
    const entries = await (input as any).processSessionLine(
      rec,
      '/tmp/rollout/model-io-sess_abc-def-123.jsonl',
    );
    expect(entries).toHaveLength(2);
    expect(entries[1]!['gen_ai.session.id']).toBe('abc-def-123');
  });

  it('processSessionLine 解析 model-io record → emit [llm.request, llm.response] pair', async () => {
    const lines = fs.readFileSync(ROLLOUT_FIXTURE, 'utf-8').split('\n').filter((l) => l.trim());
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const rec = JSON.parse(lines[0]);
    const entries = await (input as any).processSessionLine(rec, '/tmp/x.jsonl');
    expect(entries).toHaveLength(2);

    // ── request entry (entries[0])
    const requestEntry = entries[0];
    expect(requestEntry['event.name']).toBe('llm.request');
    expect(requestEntry['gen_ai.agent.type']).toBe('minimax-code');
    expect(requestEntry['gen_ai.agent.name']).toBe('MiniMax Code');
    expect(requestEntry['gen_ai.session.id']).toBe(rec.sessionId);
    const inMsgs = requestEntry['gen_ai.input.messages'];
    expect(Array.isArray(inMsgs)).toBe(true);
    expect(inMsgs.length).toBeGreaterThan(0);
    for (const m of inMsgs) {
      expect(m.role).toBeDefined();
      expect(Array.isArray(m.parts)).toBe(true);
    }
    expect(requestEntry['gen_ai.request.id']).toBeDefined();
    expect(requestEntry['gen_ai.response.id']).toBeDefined();

    // ── response entry (entries[1])
    const responseEntry = entries[1];
    expect(responseEntry['event.name']).toBe('llm.response');
    expect(responseEntry['gen_ai.session.id']).toBe(rec.sessionId);
    expect(responseEntry['gen_ai.request.id']).toBe(requestEntry['gen_ai.request.id']);
    expect(responseEntry['gen_ai.response.id']).toBe(requestEntry['gen_ai.response.id']);
    const outMsgs = responseEntry['gen_ai.output.messages'];
    expect(Array.isArray(outMsgs)).toBe(true);
    expect(outMsgs[0].role).toBe('assistant');
    expect(outMsgs[0].finish_reason).toBeDefined();
    expect(responseEntry['gen_ai.usage.input_tokens']).toBe(10);
    expect(responseEntry['gen_ai.usage.output_tokens']).toBe(20);

    // time boundaries: request.entry.time_unix_nano <= response.entry.time_unix_nano
    expect(BigInt(requestEntry['time_unix_nano'])).toBeLessThanOrEqual(
      BigInt(responseEntry['time_unix_nano']),
    );
  });

  it('processSessionLine: finish_reasons 缺省 → undefined (source-faithful, Round 8)', async () => {
    // Round 8 fix (PR #233): the previous behavior defaulted to
    // ['stop'] when no finishReason was present, fabricating a
    // termination signal. Source-faithful behavior now omits the
    // field entirely when the source doesn't declare one.
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const rec = {
      type: 'model-io',
      sessionId: 's1',
      turnId: 't1',
      startedAt: 1700000000000,
      completedAt: 1700000001234,
      request: { messages: [{ role: 'user', content: 'hi' }] },
      response: { modelId: 'm1', text: 'hello' /* no finishReason */ },
    };
    const entries = await (input as any).processSessionLine(rec, '/tmp/x.jsonl');
    expect(entries[1]!['gen_ai.response.finish_reasons']).toBeUndefined();
  });

  it('processSessionLine: traceId UUID 带连字符 → 32-hex (W3C)', async () => {
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const rec = {
      type: 'model-io',
      sessionId: 's1',
      traceId: '11111111-2222-3333-4444-555555555555',
      request: { messages: [] },
      response: { modelId: 'm1' },
    };
    const entries = await (input as any).processSessionLine(rec, '/tmp/x.jsonl');
    // trace_id 在 request 和 response entry 上应一致 (OTLP pair key)
    expect(entries[0]!.trace_id).toBe('11111111222233334444555555555555');
    expect(entries[1]!.trace_id).toBe('11111111222233334444555555555555');
    expect(entries[0]!.trace_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('Round 17: object-shaped message content → JSON.stringify 成 string (TextPart schema 合规)', async () => {
    // Round 17 fix (PR #233, copilot suppressed comment): the
    // previous toParts emitted `{ type: 'text', content: <object> }`
    // for non-string non-array object content. validate-trace's
    // schema requires TextPart.content to be a string (the
    // `requireString` check in scripts/validate-trace.mjs); an
    // object content would produce `schema.input_messages` errors
    // if MiniMax Code ever logs object-shaped message content
    // (e.g. a future multi-modal / structured-prompt rollout
    // record). The fix stringifies the object to a JSON string so
    // the data is preserved in a string field. This test
    // exercises a representative object content (image part
    // with text+data fields) and asserts the emitted part is
    // `{ type: 'text', content: '<json-string>' }`.
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const rec = {
      type: 'model-io',
      sessionId: 's1',
      turnId: 't1',
      request: {
        requestId: 'req-object-content',
        messages: [
          { role: 'user', content: 'describe this image' },
          { role: 'user', content: { type: 'image', data: 'base64xyz', text: 'fallback-label' } },
        ],
      },
      startedAt: 1700000000000,
      completedAt: 1700000001234,
      response: { modelId: 'm1', text: 'ok', finishReason: 'stop' },
    };
    const entries = await (input as any).processSessionLine(rec, '/tmp/x.jsonl');
    const requestEntry = entries[0];
    const inputMessages = requestEntry['gen_ai.input.messages'] as Array<Record<string, unknown>>;
    // 2 messages, second one had object content → now a JSON string
    expect(inputMessages).toHaveLength(2);
    const imagePartMessage = inputMessages[1]!;
    expect(imagePartMessage.parts).toHaveLength(1);
    const imagePart = imagePartMessage.parts![0]!;
    expect(imagePart.type).toBe('text');
    // The content MUST be a string (not an object) for validate-trace
    // to accept it. We assert the value is a string AND that it
    // round-trips back to the original object via JSON.parse.
    expect(typeof imagePart.content).toBe('string');
    const roundTripped = JSON.parse(imagePart.content as string);
    expect(roundTripped).toEqual({ type: 'image', data: 'base64xyz', text: 'fallback-label' });
  });

  it('processSessionLine: tool.role 消息 parts.type 为 tool_call_response (P1 fix)', async () => {
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const rec = {
      type: 'model-io',
      sessionId: 's1',
      turnId: 't1',
      request: {
        messages: [
          { role: 'user', content: 'read /etc/hosts' },
          { role: 'tool', toolCallId: 'call-1', content: '127.0.0.1 localhost' },
        ],
      },
      response: { modelId: 'm1', text: 'done' },
    };
    const entries = await (input as any).processSessionLine(rec, '/tmp/x.jsonl');
    // input.messages 应该在 request entry (entries[0])
    const inMsgs = entries[0]!['gen_ai.input.messages'];
    const toolPart = inMsgs.flatMap((m: any) => m.parts).find((p: any) => p.type === 'tool_call_response');
    expect(toolPart).toBeDefined();
    expect(toolPart.id).toBe('call-1');
    // 不应有 tool_result 残留
    const stale = inMsgs.flatMap((m: any) => m.parts).find((p: any) => p.type === 'tool_result');
    expect(stale).toBeUndefined();
  });

  it('processSessionLine: tool definitions 抽取并归一化为 ARMS FunctionToolDefinition (在 request entry)', async () => {
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const rec = {
      type: 'model-io',
      sessionId: 's1',
      request: {
        body: {
          model: 'm1',
          tools: [
            {
              type: 'function',
              function: {
                name: 'Read',
                description: 'Read a file',
                parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
              },
            },
          ],
        },
      },
      response: { modelId: 'm1' },
    };
    const entries = await (input as any).processSessionLine(rec, '/tmp/x.jsonl');
    // tool.definitions 在 request entry
    const defs = entries[0]!['gen_ai.tool.definitions'];
    expect(defs).toBeDefined();
    expect(defs).toHaveLength(1);
    expect(defs[0].type).toBe('function');
    expect(defs[0].name).toBe('Read');
    expect(defs[0].description).toBe('Read a file');
    expect(defs[0].parameters).toBeDefined();
    // OpenAI 嵌套形态展平后不应残留 function 包装
    expect(defs[0].function).toBeUndefined();
  });

  it('checkAvailability 在目录不存在时返回 false (mock directoryExists)', async () => {
    // Copilot review (PR #233, suppressed): 静态 checkAvailability 读真实
    // ~/.minimax-code/rollout 路径, 直接调受 dev 机是否安装 MiniMax Code
    // 影响. 用 vi.mock 强制 directoryExists 返回 false, 测逻辑层短路.
    const fsUtils = await import('../../../src/utils/fs-utils.js');
    const spy = vi.spyOn(fsUtils, 'directoryExists').mockResolvedValue(false);
    try {
      const result = await MinimaxCodeRolloutInput.checkAvailability();
      expect(result).toBe(false);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('onStart: 已存在 rollout 文件 → 状态 pre-seed offset 到 file size (避免回放历史)', async () => {
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const target = path.join(TMPDIR, 'model-io-sess_preseed.jsonl');
    fs.writeFileSync(target, '{"line":1}\n{"line":2}\n');
    await (input as any).onStart();
    const stateKey = `minimax-code-rollout:${target}`;
    const persisted = stateStore.get(stateKey);
    expect(persisted.lastOffset).toBe(fs.statSync(target).size);
    expect(persisted.extra?.minimaxCodeRollout?.inode).toBe(fs.statSync(target).ino);
  });

  it('Round 8: onStart 不重置已有 offset (Pilot 重启后从 checkpoint 恢复, 不丢 Pilot 停机期间的记录)', async () => {
    // Round 8 fix (PR #233, addressing fangxiu-wf review finding #3):
    // the previous onStart unconditionally set offset = stat.size and
    // reset turnStepMap, silently discarding records appended while
    // Pilot was stopped. The new behavior: files with a persisted
    // checkpoint keep their offset; only first-sight files get
    // baselined to EOF.
    //
    // Test setup: pre-seed state with a partial read (offset=50 of a
    // 100-byte file). Then write more data (file grows to 150 bytes).
    // onStart should NOT reset offset to 150; it should leave 50 so
    // the next collect() picks up the 50..150 bytes (records written
    // while Pilot was stopped).
    const target = path.join(TMPDIR, 'model-io-sess_resume.jsonl');
    fs.writeFileSync(target, '{"line":1}\n{"line":2}\n');
    const stateKey = `minimax-code-rollout:${target}`;
    stateStore.setOffset(stateKey, 50);
    stateStore.update(stateKey, {
      extra: {
        minimaxCodeRollout: {
          inode: fs.statSync(target).ino,
          turnStepMap: { 'turn-x': { requestSet: ['old-req'], nextStepIdx: 5 } },
        },
      },
    });

    // Append more data (simulating records written while Pilot was down).
    const originalSize = fs.statSync(target).size; // 22 (2 lines of `{"line":N}\n`)
    fs.appendFileSync(target, '{"line":3}\n{"line":4}\n{"line":5}\n');
    const newSize = fs.statSync(target).size;
    expect(newSize).toBeGreaterThan(originalSize);

    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    await (input as any).onStart();

    // offset should be 50 (NOT 150 — we don't want to lose the
    // records written between offset 50 and 150).
    expect(stateStore.getOffset(stateKey)).toBe(50);
    // turnStepMap should be preserved (not reset).
    const persisted = stateStore.get(stateKey);
    expect(persisted.extra?.minimaxCodeRollout?.turnStepMap?.['turn-x']?.nextStepIdx).toBe(5);
  });

  // ─── Round 2: turnStepMap 持久化 ───

  it('Round 2: 同 turnId + 同 requestId (retry) 共享 step.id', async () => {
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const rec1: any = {
      type: 'model-io',
      sessionId: 's1',
      turnId: 'turn-A',
      requestId: 'req-1',
      startedAt: 1700000000000,
      completedAt: 1700000001234,
      request: { messages: [{ role: 'user', content: 'hi' }] },
      response: { modelId: 'm1', finishReason: 'stop' },
    };
    const rec2: any = {
      ...rec1,
      attempt: 2,
      response: { modelId: 'm1', finishReason: 'stop' },
    };
    const e1 = await (input as any).processSessionLine(rec1, '/tmp/x.jsonl');
    const e2 = await (input as any).processSessionLine(rec2, '/tmp/x.jsonl');
    expect(e1[1]!['gen_ai.step.id']).toBe('turn-A:s1');
    expect(e2[1]!['gen_ai.step.id']).toBe('turn-A:s1');
  });

  it('Round 2: 同 turn 不同 requestId → 递增 stepIdx', async () => {
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const rec1: any = {
      type: 'model-io', sessionId: 's1', turnId: 'turn-A', requestId: 'req-1',
      startedAt: 1700000000000, completedAt: 1700000001234,
      request: { messages: [] }, response: { modelId: 'm1' },
    };
    const rec2: any = {
      ...rec1, requestId: 'req-2', startedAt: 1700000005000,
    };
    const e1 = await (input as any).processSessionLine(rec1, '/tmp/x.jsonl');
    const e2 = await (input as any).processSessionLine(rec2, '/tmp/x.jsonl');
    expect(e1[1]!['gen_ai.step.id']).toBe('turn-A:s1');
    expect(e2[1]!['gen_ai.step.id']).toBe('turn-A:s2');
  });

  it('Round 2: 不同 turnId 各自从 s1 开始', async () => {
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const rec1: any = {
      type: 'model-io', sessionId: 's1', turnId: 'turn-A', requestId: 'req-1',
      request: { messages: [] }, response: { modelId: 'm1' },
    };
    const rec2: any = {
      ...rec1, turnId: 'turn-B', requestId: 'req-1',
    };
    const e1 = await (input as any).processSessionLine(rec1, '/tmp/x.jsonl');
    const e2 = await (input as any).processSessionLine(rec2, '/tmp/x.jsonl');
    expect(e1[1]!['gen_ai.step.id']).toBe('turn-A:s1');
    expect(e2[1]!['gen_ai.step.id']).toBe('turn-B:s1');
  });

  it('Round 2: 缺 turnId 时不分配 step.id (validator 诊断)', async () => {
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const rec: any = {
      type: 'model-io', sessionId: 's1', requestId: 'req-1',
      request: { messages: [] }, response: { modelId: 'm1' },
    };
    const e = await (input as any).processSessionLine(rec, '/tmp/x.jsonl');
    // Round 3 (PR #233): processSessionLine returns AgentActivityEntry[]; the
    // step.id lives on the response entry (index 1) — request side has no
    // step.id when turnId is missing.
    expect(e[1]!['gen_ai.step.id']).toBeUndefined();
  });

  it('Round 2: 跨 input 实例 + 共享 stateStore → step.id 复用序号', async () => {
    const input1 = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const rec1: any = {
      type: 'model-io', sessionId: 's1', turnId: 'turn-A',
      request: { requestId: 'req-1', messages: [] },
      response: { modelId: 'm1' },
    };
    const e1 = await (input1 as any).processSessionLine(rec1, '/tmp/x.jsonl');
    expect(e1[1]!['gen_ai.step.id']).toBe('turn-A:s1');

    // 模拟重启: 新 input 实例, 复用同一 stateStore
    const input2 = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const rec2: any = {
      type: 'model-io', sessionId: 's1', turnId: 'turn-A',
      request: { requestId: 'req-2', messages: [] },
      response: { modelId: 'm1' },
    };
    const e2 = await (input2 as any).processSessionLine(rec2, '/tmp/x.jsonl');
    // 持久化后 nextStepIdx 已递增 → s2
    expect(e2[1]!['gen_ai.step.id']).toBe('turn-A:s2');
  });

  // ─── Round 2: 文件轮转 (inode 变化) ───

  it('Round 2: 文件 inode 变更 (轮转) → turnStepMap 清空,新 turnId 从 s1 重新开始', async () => {
    const sessDir = path.join(TMPDIR, 'rollout-rot');
    fs.mkdirSync(sessDir, { recursive: true });
    const target = path.join(sessDir, 'model-io-sess_rotate.jsonl');
    fs.writeFileSync(target, '');

    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: sessDir });
    await (input as any).onStart();

    const stateKey = `minimax-code-rollout:${target}`;
    // pre-populate stale turnStepMap with old turnId + high nextStepIdx
    stateStore.update(stateKey, {
      extra: {
        minimaxCodeRollout: {
          inode: 999999, // mismatched inode forces rotation detection
          turnStepMap: {
            'turn_old-stale': { requestSet: ['old-req'], nextStepIdx: 99 },
          },
        },
      },
    });

    // Rotate: rewrite file (new inode)
    fs.unlinkSync(target);
    fs.writeFileSync(target, '');

    await input.collect();
    const after = stateStore.get(stateKey);
    expect(after.extra?.minimaxCodeRollout?.inode).toBe(fs.statSync(target).ino);
    // 旧 turnStepMap 已清空
    expect(after.extra.minimaxCodeRollout.turnStepMap['turn_old-stale']).toBeUndefined();
  });

  it('Round 2: 文件 inode=0 sentinel (file appeared after onStart) → seed inode 不清 turnStepMap', async () => {
    const sessDir = path.join(TMPDIR, 'rollout-late');
    fs.mkdirSync(sessDir, { recursive: true });
    const target = path.join(sessDir, 'model-io-sess_late-appear.jsonl');
    // 先不调 onStart,模拟"文件在 onStart 之后才出现"
    fs.writeFileSync(target, '');

    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: sessDir });
    // 不调 onStart
    const stateKey = `minimax-code-rollout:${target}`;

    // pre-populate turnStepMap with stale nextStepIdx=99 (没有 inode 字段)
    stateStore.update(stateKey, {
      extra: {
        minimaxCodeRollout: {
          inode: 0, // 0 sentinel
          turnStepMap: {
            'turn_x': { requestSet: ['req-x'], nextStepIdx: 99 },
          },
        },
      },
    });

    // 给文件 append 一些内容
    fs.appendFileSync(target, '{"a":1}\n');

    await input.collect();
    const after = stateStore.get(stateKey);
    // inode 0 sentinel 时 seed inode 但不清 turnStepMap
    expect(after.extra?.minimaxCodeRollout?.inode).toBe(fs.statSync(target).ino);
    // turn_x 的 nextStepIdx=99 还在
    expect(after.extra.minimaxCodeRollout.turnStepMap['turn_x'].nextStepIdx).toBe(99);
  });

  // ─── Round 8: source-faithful output ───

  it('Round 8: incomplete response (completedAt present, no finishReason/text/toolCalls) → 不合成 finish_reasons / output.messages / usage,emit diagnostic event', async () => {
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const rec: any = {
      type: 'model-io',
      sessionId: 's1',
      turnId: 'turn-A',
      request: { requestId: 'req-incomplete', messages: [{ role: 'user', content: 'hi' }] },
      startedAt: 1700000000000,
      completedAt: 1700000001000,
      response: {
        // No finishReason / text / toolCalls / usage — source is incomplete.
        modelId: 'm1',
        responseId: 'r-incomplete',
      },
    };
    const entries = await (input as any).processSessionLine(rec, '/tmp/x.jsonl');
    // 3 entries: request, response, diagnostic
    expect(entries.length).toBe(3);
    const requestEntry = entries[0];
    const responseEntry = entries[1];
    const diagnosticEntry = entries[2];

    // Source-faithful response: NO finish_reasons, NO output.messages,
    // NO usage tokens. The entry explicitly omits these so downstream
    // can distinguish "incomplete source data" from "synthesized".
    expect(responseEntry['gen_ai.response.finish_reasons']).toBeUndefined();
    expect(responseEntry['gen_ai.output.messages']).toBeUndefined();
    expect(responseEntry['gen_ai.usage.input_tokens']).toBeUndefined();
    expect(responseEntry['gen_ai.usage.output_tokens']).toBeUndefined();
    expect(responseEntry['gen_ai.usage.cache_read.input_tokens']).toBeUndefined();
    expect(responseEntry['gen_ai.usage.cache_creation.input_tokens']).toBeUndefined();

    // Request entry still has the input messages (those were present).
    expect(requestEntry['event.name']).toBe('llm.request');

    // Diagnostic event surfaces the issue without fabricating GenAI
    // semantics in the llm.response entry.
    expect(diagnosticEntry['event.name']).toBe('diagnostic');
    expect(diagnosticEntry['gen_ai.diagnostic.reason']).toBe('incomplete_response');
    expect(diagnosticEntry['gen_ai.diagnostic.missing_fields']).toEqual(
      expect.arrayContaining(['finishReason', 'text', 'toolCalls', 'usage']),
    );
    expect(diagnosticEntry['gen_ai.diagnostic.completed_at_present']).toBe(true);
    expect(diagnosticEntry['gen_ai.diagnostic.llm_response_has_output_messages']).toBe(false);
    expect(diagnosticEntry['gen_ai.diagnostic.llm_response_has_finish_reasons']).toBe(false);

    // Round 9 fix (PR #233, copilot suppressed comment): the diagnostic
    // event must carry the SAME correlation keys as the paired
    // llm.request / llm.response entries so operators can join them
    // back. sessionId / turnId / stepId / responseId / trace_id come
    // from the top-level rollout record (not the nested `response`
    // object), so this assertion would have failed before Round 9.
    expect(diagnosticEntry['gen_ai.session.id']).toBe('s1');
    expect(diagnosticEntry['gen_ai.turn.id']).toBe('turn-A');
    expect(diagnosticEntry['gen_ai.step.id']).toBe('turn-A:s1');
    expect(diagnosticEntry['gen_ai.response.id']).toBe('r-incomplete');
    // session/turn/step/response.id must match the llm.response entry
    // so an operator can join the two on any of these keys.
    expect(diagnosticEntry['gen_ai.session.id']).toBe(responseEntry['gen_ai.session.id']);
    expect(diagnosticEntry['gen_ai.turn.id']).toBe(responseEntry['gen_ai.turn.id']);
    expect(diagnosticEntry['gen_ai.step.id']).toBe(responseEntry['gen_ai.step.id']);
    expect(diagnosticEntry['gen_ai.response.id']).toBe(responseEntry['gen_ai.response.id']);
  });

  it('Round 8: 正常 finishReason 时不 emit diagnostic,只 llm.request + llm.response', async () => {
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const rec: any = {
      type: 'model-io',
      sessionId: 's1',
      turnId: 'turn-A',
      request: { requestId: 'req-normal', messages: [] },
      startedAt: 1700000000000,
      completedAt: 1700000001234,
      response: { modelId: 'm1', text: 'hello', finishReason: 'stop' },
    };
    const entries = await (input as any).processSessionLine(rec, '/tmp/x.jsonl');
    // 2 entries: no diagnostic, normal finish_reasons ['stop']
    expect(entries.length).toBe(2);
    expect(entries[1]['gen_ai.response.finish_reasons']).toEqual(['stop']);
    expect(entries[1]['gen_ai.usage.input_tokens']).toBeUndefined(); // not set, no usage in source
  });

  it('Round 8: completedAt 缺失 + 多个字段缺失 → emit diagnostic', async () => {
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const rec: any = {
      type: 'model-io',
      sessionId: 's1',
      turnId: 'turn-A',
      request: { requestId: 'req-no-completed', messages: [] },
      startedAt: 1700000000000,
      // completedAt missing
      response: { modelId: 'm1' },
    };
    const entries = await (input as any).processSessionLine(rec, '/tmp/x.jsonl');
    expect(entries.length).toBe(3);
    const responseEntry = entries[1];
    expect(responseEntry['gen_ai.response.finish_reasons']).toBeUndefined();
    const diagnosticEntry = entries[2];
    expect(diagnosticEntry['event.name']).toBe('diagnostic');
    expect(diagnosticEntry['gen_ai.diagnostic.completed_at_present']).toBe(false);
  });

  it('Round 8: 有 text + finishReason + usage → 不 emit diagnostic (3 fields present)', async () => {
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const rec: any = {
      type: 'model-io',
      sessionId: 's1',
      turnId: 'turn-A',
      request: { requestId: 'req-3-fields', messages: [] },
      startedAt: 1700000000000,
      // no completedAt
      response: { modelId: 'm1', text: 'ok', finishReason: 'stop', usage: { inputTokens: 5 } },
    };
    const entries = await (input as any).processSessionLine(rec, '/tmp/x.jsonl');
    // 2 entries: 3 of 4 fields present, so not incomplete
    expect(entries.length).toBe(2);
    expect(entries[1]['gen_ai.response.finish_reasons']).toEqual(['stop']);
  });

  // ─── Round 8: empty output.messages omission ───

  it('Round 8: text+toolCalls 都空但有 finishReason (e.g. length cap) → 不 emit output.messages, 不 emit diagnostic (finishReason 已说清)', async () => {
    // The previous Round 6 behavior emitted a placeholder assistant
    // message so validate-trace's semantic.llm_has_input_output rule
    // would not ERROR. Round 8 (source-faithful) reverses that: a model
    // call that produced no recoverable content now leaves
    // gen_ai.output.messages unset. The finish_reasons=['length'] field
    // already tells the story ("model hit token cap, no content"), so
    // we do NOT emit a separate diagnostic — the diagnostic is
    // reserved for the truly broken case (no finishReason + no
    // content). validate-trace WILL flag the entry as missing output
    // messages, which is the correct signal for downstream.
    const input = new MinimaxCodeRolloutInput({ stateStore, sessionDir: TMPDIR });
    const rec: any = {
      type: 'model-io',
      sessionId: 's1',
      turnId: 'turn-A',
      request: { requestId: 'req-empty', messages: [] },
      startedAt: 1700000000000,
      completedAt: 1700000001000,
      response: {
        // 故意 text='' (空字符串) + 无 toolCalls, finishReason='length'
        // (model hit token cap and returned no content)
        modelId: 'm1',
        text: '',
        finishReason: 'length',
      },
    };
    const entries = await (input as any).processSessionLine(rec, '/tmp/x.jsonl');
    expect(entries.length).toBe(2);
    const responseEntry = entries[1];
    // response carries finish_reasons=['length'] but NO output.messages
    expect(responseEntry['gen_ai.response.finish_reasons']).toEqual(['length']);
    expect(responseEntry['gen_ai.output.messages']).toBeUndefined();
  });

  // Round 13 fix (PR #233, copilot suppressed comment): the module-scope
  // TMPDIR is created with `fs.mkdtempSync` at import time but was
  // never removed, so each test run leaked a temp dir under
  // `os.tmpdir()/minimax-code-rollout-test-XXXXXX`. The per-test
  // `beforeEach` already cleans up the per-test `state.json` but
  // not the parent dir. Add an `afterAll` to clean the whole TMPDIR
  // when the suite finishes. (`force: true` makes it tolerant of
  // any pre-existing cleanup paths so this is safe to add
  // unconditionally.)
  afterAll(() => {
    fs.rmSync(TMPDIR, { recursive: true, force: true });
  });
});
