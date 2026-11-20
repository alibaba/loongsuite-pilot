import { describe, it, expect } from 'vitest';
import { SseFrames, projectFrame, scopedRequest } from '../../../scripts/diagnostics/doubao-work-stream.mjs';

describe('Doubao passive stream diagnostic', () => {
  it('preserves UTF-8 at every packet boundary and dispatches complete CRLF/LF/CR frames once', () => {
    const raw = Buffer.from('id: 1\r\nevent: CHUNK_DELTA\r\ndata: {"text":"中文🙂"}\r\n\r\n'
      + 'id: 2\revent: SSE_REPLY_END\rdata: {"end_type":1}\r\r'
      + ': heartbeat\nevent: custom\ndata: first\ndata: second\n\n');
    for (let split = 0; split <= raw.length; split++) {
      const frames = [];
      const parser = new SseFrames(f => frames.push(f));
      parser.push(raw.subarray(0, split)); parser.push(raw.subarray(split)); parser.end();
      expect(frames).toHaveLength(3);
      expect(projectFrame(frames[0]).text).toBe('中文🙂');
      expect(projectFrame(frames[1]).endType).toBe(1);
      expect(frames[2].data).toBe('first\nsecond');
      expect(parser.dropped).toBe(0);
    }
  });

  it('discards oversized and truncated frames without treating a tail as a new event', () => {
    const frames = [];
    const parser = new SseFrames(f => frames.push(f), 80);
    parser.push(Buffer.from(`data: ${'x'.repeat(100)}\nid: 99\ndata: bad\n\n`
      + 'id: 2\nevent: SSE_REPLY_END\ndata: {"end_type":2}\n\n'
      + 'data: truncated'));
    parser.end();
    expect(parser.dropped).toBe(2);
    expect(frames).toHaveLength(1);
    expect(frames[0].id).toBe('2');
  });

  it('does not export account, signed URL, headers or arbitrary ext fields', () => {
    const projected = projectFrame({ event: 'STREAM_MSG_NOTIFY', id: '3', data: JSON.stringify({
      meta: { message_id: 'answer', conversation_id: 'conversation', sender_id: 'PRIVATE_USER' },
      content: { ext: { model_id: '38', authorization: 'PRIVATE_AUTH', signed_url: 'PRIVATE_URL',
        context_window_usage: '{"messages":12}' }, content_block: [{ block_id: 'block', block_type: 10000,
        content: { text_block: { text: '合成输出' }, secret: 'PRIVATE_EXTRA' } }] },
    }) });
    expect(projected.messageId).toBe('answer');
    expect(projected.blocks[0].text).toBe('合成输出');
    expect(projected.modelEnum).toBe('38');
    expect(projected.contextWindowOccupancy).toBe('{"messages":12}');
    const encoded = JSON.stringify(projected);
    expect(encoded).not.toContain('PRIVATE_');
    expect(encoded).not.toContain('gen_ai.request.model');
    expect(encoded).not.toContain('gen_ai.usage');
  });

  it('does not count mirrored transport requests or tool blocks as model invocations', () => {
    const frame = { event: 'STREAM_CHUNK', id: '4', data: JSON.stringify({ message_id: 'same-answer', patch_op: [{
      patch_object: 1, patch_type: 1, patch_value: { content_block: [{ block_id: 'tool-ui-block', block_type: 10019,
        content: { file_operation_block: { path: 'synthetic.txt', tool_call_id: 'not-a-model' } }, is_finish: true }] },
    }] }) };
    const first = projectFrame(frame), mirror = projectFrame(frame);
    expect(first).toEqual(mirror);
    expect(first.messageId).toBe('same-answer');
    expect(first.patches[0].blocks[0].finished).toBe(true);
    expect(JSON.stringify(first)).not.toMatch(/LLM|invocation|usage/);
  });

  it('scopes capture to explicit test text and follows only evidenced fetch task identities', () => {
    const nonce = 'DBW_SYNTHETIC_TEST';
    expect(scopedRequest(JSON.stringify({ client_meta: { nonce }, messages: [{ content: 'unrelated' }] }), nonce)).toBeUndefined();
    const request = scopedRequest(JSON.stringify({ messages: [
      { content: 'private old history' }, { local_message_id: 'local-1', content: nonce },
    ], headers: { Authorization: 'PRIVATE_AUTH' } }), nonce);
    expect(request.messages).toEqual([{ localMessageId: 'local-1', content: nonce }]);
    expect(JSON.stringify(request)).not.toContain('private');
    expect(scopedRequest(JSON.stringify({ messages: [{ local_message_id: 'local-2', content_block: [{
      block_type: 10000, content: { text_block: { text: nonce }, pc_event_block: { private: 'PRIVATE' } },
    }] }] }), nonce).messages).toEqual([{ localMessageId: 'local-2', content: nonce }]);
    expect(scopedRequest(JSON.stringify({ messages: [{ content_block: [{
      content: { text_block: { text: 'unrelated' }, pc_event_block: { nonce } },
    }] }] }), nonce)).toBeUndefined();
    expect(scopedRequest('{"task_id":"unrelated"}', nonce, new Set(['owned']))).toBeUndefined();
    expect(scopedRequest('{"task_id":"owned"}', nonce, new Set(['owned']))).toEqual({ taskId: 'owned', basis: 'observed_fetch_stream' });
    expect(scopedRequest('{"task_id":"sdk-owned"}', nonce, new Set(), new Set(['sdk-owned']))).toEqual({ taskId: 'sdk-owned', basis: 'explicit_task_scope' });
    const handoff = projectFrame({ event: 'FETCH_STREAM', id: '5', data: '{"fetch_key":"owned","fetch_type":2,"append_scene":4,"secret":"PRIVATE"}' });
    expect(handoff.taskId).toBe('owned');
    expect(JSON.stringify(handoff)).not.toContain('PRIVATE');
  });

  it('tolerates malformed optional fields and never returns arbitrary data', () => {
    expect(projectFrame({ event: 'STREAM_CHUNK', id: '', data: '{"patch_op":[null,7]}' }).patches).toEqual([{}, {}]);
    expect(projectFrame({ event: 'SSE_ACK', id: '', data: '{"query_list":[null]}' }).queries).toEqual([{}]);
    expect(scopedRequest('{"messages":[null,7]}', 'DBW_SYNTHETIC_TEST')).toBeUndefined();
    expect(projectFrame({ event: 'ASYNC_CHUNK_SNAPSHOT', id: '7', data: '{"secret":"PRIVATE"}' })).toEqual({
      event: 'ASYNC_CHUNK_SNAPSHOT', sequence: '7', unprojected: true,
    });
  });
});
