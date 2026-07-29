import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGrokTranscript } from '../../../../assets/hooks/grok-build/transcript-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');

function readFixture(name) {
  return path.join(FIXTURES, name);
}

describe('grok-build parseGrokTranscript — fixtures 真实 chat_history 格式', () => {
  test('nextOffset == 文件大小', () => {
    const fp = readFixture('chat_history.single-llm-single-tool.jsonl');
    const data = parseGrokTranscript(fp);
    expect(data.nextOffset).toBe(fs.statSync(fp).size);
  });

  test('byteOffset >= 文件大小返回空', () => {
    const fp = readFixture('chat_history.single-llm-single-tool.jsonl');
    const size = fs.statSync(fp).size;
    const data = parseGrokTranscript(fp, size);
    expect(data.turns).toEqual([]);
    expect(data.nextOffset).toBe(size);
  });

  test('单 turn、单 LLM、无 tool — 提取 system + prompt + 单 assistant', () => {
    const data = parseGrokTranscript(readFixture('chat_history.single-llm-single-tool.jsonl'));
    expect(data.turns.length).toBe(1);
    const turn = data.turns[0];
    expect(turn.llmCalls.length).toBe(1);
    expect(turn.prompt).toBe('say hi');
    expect(turn.promptTimestamp).toBe('2026-07-16T06:51:00.910Z');
    expect(turn.llmCalls[0].model).toBe('grok-3');
    expect(turn.llmCalls[0].stop_reason).toBe('end_turn');
    expect(turn.llmCalls[0].input_tokens).toBe(10);
    expect(turn.llmCalls[0].output_tokens).toBe(2);
    expect(turn.llmCalls[0].declaredToolIds).toEqual([]);
  });

  test('单 turn、多 LLM、每 LLM 1 tool — 3 STEP / 2 TOOL', () => {
    const data = parseGrokTranscript(readFixture('chat_history.single-turn-multi-step.jsonl'));
    expect(data.turns.length).toBe(1);
    const turn = data.turns[0];
    expect(turn.llmCalls.length).toBe(3);
    expect(turn.llmCalls[0].declaredToolIds).toEqual(['tu_read_1']);
    expect(turn.llmCalls[1].declaredToolIds).toEqual(['tu_bash_1']);
    expect(turn.llmCalls[2].declaredToolIds).toEqual([]);

    const readDetails = turn.llmCalls[0].toolDetails.get('tu_read_1');
    expect(readDetails.call).toBe('2026-07-16T06:51:03.500Z');
    expect(readDetails.result).toBe('2026-07-16T06:51:03.800Z');
    expect(readDetails.resultContent).toBe('iZbp1abc123');
    expect(readDetails.isError).toBe(false);

    const bashDetails = turn.llmCalls[1].toolDetails.get('tu_bash_1');
    expect(bashDetails.call).toBe('2026-07-16T06:51:06.000Z');
    expect(bashDetails.result).toBe('2026-07-16T06:51:06.300Z');

    expect(turn.llmCalls[1].request_start_time).toBe('2026-07-16T06:51:03.800Z');
  });

  test('单 turn、单 LLM、3 并行 tool — 全部归属到声明方 step', () => {
    const data = parseGrokTranscript(readFixture('chat_history.parallel-tools.jsonl'));
    expect(data.turns.length).toBe(1);
    const turn = data.turns[0];
    expect(turn.llmCalls.length).toBe(2);
    expect(turn.llmCalls[0].declaredToolIds).toEqual(['tu_par_1', 'tu_par_2', 'tu_par_3']);

    const toolDetails = turn.llmCalls[0].toolDetails;
    expect(toolDetails.get('tu_par_1').resultContent).toBe('aaa');
    expect(toolDetails.get('tu_par_2').resultContent).toBe('bbb');
    expect(toolDetails.get('tu_par_3').resultContent).toBe('ccc');
  });

  test('多 turn session — prompt_index 切分 3 个 turn', () => {
    const data = parseGrokTranscript(readFixture('chat_history.three-turns.jsonl'));
    expect(data.turns.length).toBe(3);
    expect(data.turns[0].prompt).toContain('2+2');
    expect(data.turns[1].prompt).toContain('3+3');
    expect(data.turns[2].prompt).toContain('4+4');
    expect(data.turns[0].promptIndex ?? data.turns[0].llmCalls[0].promptIndex).toBe('0');
    expect(data.turns[1].llmCalls[0].promptIndex).toBe('1');
    expect(data.turns[2].llmCalls[0].promptIndex).toBe('2');
  });

  test('synthetic_reason + user_info/system-reminder user records 跳过 conversationHistory 但不影响 turn 切分', () => {
    const data = parseGrokTranscript(readFixture('chat_history.single-turn-multi-step.jsonl'));
    const turn = data.turns[0];
    // user_info + system-reminder 应被跳过 — input_messages 只含真实 user_query
    const inputMsgs = turn.llmCalls[0].input_messages;
    // system prompt + 真实 user_query
    expect(inputMsgs.some((m) => m.role === 'user' && JSON.stringify(m).includes('user_query'))).toBe(true);
    expect(inputMsgs.some((m) => JSON.stringify(m).includes('user_info>'))).toBe(false);
    expect(inputMsgs.some((m) => JSON.stringify(m).includes('system-reminder>'))).toBe(false);
  });

  test('无 assistant 记录 → turns 为空(首次运行防护不触发)', () => {
    const fp = path.join(fs.mkdtempSync(path.join(process.cwd(), '.tmp-grok-parser-')), 'chat_history.jsonl');
    try {
      fs.writeFileSync(fp, [
        { type: 'system', content: 'sys' },
        { type: 'user', content: [{ type: 'text', text: '<user_query>\nhi\n</user_query>' }], prompt_index: 0, timestamp: '2026-07-16T10:00:00Z' },
      ].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
      const data = parseGrokTranscript(fp);
      expect(data.turns).toEqual([]);
    } finally {
      fs.rmSync(path.dirname(fp), { recursive: true, force: true });
    }
  });

  test('末行未写完时不推进该行 offset，补全后下次可重试', () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-grok-parser-torn-'));
    const fp = path.join(dir, 'chat_history.jsonl');
    const complete = [
      { type: 'system', content: 'sys' },
      {
        type: 'user',
        content: [{ type: 'text', text: '<user_query>\nhi\n</user_query>' }],
        prompt_index: 0,
      },
      { type: 'assistant', content: 'hello', model_id: 'grok' },
    ].map((record) => `${JSON.stringify(record)}\n`).join('');
    const torn = '{"type":"assistant","content":"later"';
    try {
      fs.writeFileSync(fp, complete + torn, 'utf-8');
      const first = parseGrokTranscript(fp);
      expect(first.turns[0].llmCalls).toHaveLength(1);
      expect(first.nextOffset).toBe(Buffer.byteLength(complete));

      fs.appendFileSync(fp, ',"model_id":"grok"}\n', 'utf-8');
      const second = parseGrokTranscript(fp, first.nextOffset);
      expect(second.turns[0].llmCalls).toHaveLength(1);
      expect(second.nextOffset).toBe(fs.statSync(fp).size);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('grok-build parseGrokTranscript — OpenAI-style tool_calls(真实 grok 0.2.x fixture)', () => {
  // Fixture 来源: tester CP5 真实 grok qwen3.7-max 抓取 (comment 324cfcab, 2026-07-17, attachment evidence-chat-history.jsonl)。
  // 真实结构: assistant.content 为字符串(可空)+ 顶层 tool_calls:[{id:"",name,arguments(JSON 串)}];
  // tool_result 为顶层 record {tool_call_id:"",content}; reasoning record 跳过。
  const FIXTURE = readFixture('chat_history.openai-style-real.jsonl');

  test('解析 OpenAI-style tool_calls；空 result id 保持不可归属', () => {
    const data = parseGrokTranscript(FIXTURE);
    expect(data.turns.length).toBe(1);
    const turn = data.turns[0];

    // 3 条 assistant record → 3 个 LLM call
    expect(turn.llmCalls.length).toBe(3);

    const allDeclared = turn.llmCalls.flatMap((c) => c.declaredToolIds);
    // 2 tool_calls (assistant #1) + 1 tool_call (assistant #2) = 3
    expect(allDeclared.length).toBe(3);
    // 合成 id 形如 `<name>_<assistantSeq>_<idx>`
    expect(allDeclared.every((id) => /_\d+_\d+$/.test(id))).toBe(true);

    // Empty tool_result IDs cannot be attributed truthfully in chat_history.
    // The three-source fusion layer may recover them from updates + unified.
    const withResult = turn.llmCalls
      .flatMap((c) => Array.from(c.toolDetails.values()))
      .filter((d) => d.hasResult);
    expect(withResult.length).toBe(0);
  });

  test('tool_call.arguments(JSON 字符串)被解析为对象 input', () => {
    const data = parseGrokTranscript(FIXTURE);
    const turn = data.turns[0];
    const firstLlm = turn.llmCalls[0];
    // assistant #1 第一个 tool_call = read_file, arguments 应解析为对象 {target_file:"/etc/hostname"}
    const readBlock = firstLlm.output_content.find(
      (b) => b.type === 'tool_use' && b.name === 'read_file',
    );
    expect(readBlock).toBeTruthy();
    expect(readBlock.input).toEqual({ target_file: '/etc/hostname' });
  });

  test('reasoning record 被跳过,不影响 LLM call 计数', () => {
    const data = parseGrokTranscript(FIXTURE);
    const turn = data.turns[0];
    // fixture 含 3 条 reasoning(line 5/8/11)+ 3 条 assistant,parser 只识别 assistant
    expect(turn.llmCalls.length).toBe(3);
  });

  test('model_id 字段作为 model fallback', () => {
    const data = parseGrokTranscript(FIXTURE);
    const turn = data.turns[0];
    expect(turn.llmCalls[0].model).toBe('qwen3.7-max');
    expect(turn.llmCalls[2].model).toBe('qwen3.7-max');
  });
});
