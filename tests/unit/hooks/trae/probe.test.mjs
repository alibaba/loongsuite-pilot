import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);

const PROBE_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../../../assets/plugins/trae/probe.mjs',
);

// Fixture ground truth: researcher fx-1~fx-5 from AGE-2836 attachment
// `trae-fixture-candidates.json`. Field names + value ranges extracted from
// `/home/admin/trae-install/resources/app/extensions/ai-completion/dist/extension.js`
// (source: comment `fea9f34b`). No fixture payload is invented — see
// ./fixtures/trae-fx-*-*.json for canonical samples.

class FakeIncomingMessage extends EventEmitter {
  constructor(statusCode, headers = {}) {
    super();
    this.statusCode = statusCode;
    this.headers = headers;
  }
}

class FakeClientRequest extends EventEmitter {
  constructor() {
    super();
    this._bodyChunks = [];
    this._fakeResponse = null;
    this.write = (chunk) => {
      if (chunk) {
        this._bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
    };
    this.end = (...args) => {
      if (typeof args[0] !== 'function' && args[0] != null) {
        const buf = Buffer.isBuffer(args[0]) ? args[0] : Buffer.from(String(args[0]));
        this._bodyChunks.push(buf);
      }
      // Synchronously emit 'response' if a fake response was pre-attached.
      if (this._fakeResponse) {
        this.emit('response', this._fakeResponse);
      }
    };
  }
}

let captured;
let origRequest;
let fakeReq;

async function loadProbe() {
  vi.resetModules();
  // Register the capture sink BEFORE the probe activates on import. The
  // probe reads globalThis.__TRAE_PROBE_CAPTURE at module-eval time so the
  // lifecycle activate event is observable in tests.
  globalThis.__TRAE_PROBE_CAPTURE = (line) => {
    captured.push(JSON.parse(line));
  };
  const mod = await import(pathToFileURL(PROBE_PATH).href);
  return mod;
}

beforeEach(async () => {
  captured = [];
  // Stub https.request BEFORE the probe patches it. The probe wraps whatever
  // https.request points to at activation time.
  origRequest = https.request;
  fakeReq = new FakeClientRequest();
  https.request = function (...args) {
    fakeReq._callArgs = args;
    return fakeReq;
  };
  await loadProbe();
});

afterEach(() => {
  https.request = origRequest;
  delete globalThis.__TRAE_PROBE_CAPTURE;
});

// Single helper: pre-attach a fake response, then drive write/end and the
// response data/end events. chunks is an array of strings/buffers pushed in
// order via res.emit('data', ...).
function fireChatverseRequest(opts, bodyObj, responseChunks, statusCode = 200, headers = {}) {
  const res = new FakeIncomingMessage(statusCode, headers);
  fakeReq = new FakeClientRequest();
  fakeReq._fakeResponse = res;
  const req = https.request({
    hostname: 'chatverse-prod.byteintl.net',
    method: 'POST',
    ...opts,
  });
  if (bodyObj !== undefined) req.write(JSON.stringify(bodyObj));
  req.end();
  // 'response' was emitted synchronously in end(); the probe attached its
  // 'data'/'end' listeners via req.on('response', ...). Emit chunks now.
  for (const chunk of responseChunks || []) {
    res.emit('data', Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  res.emit('end');
  return req;
}

describe('Trae probe — host whitelist', () => {
  it('passes the 4 chatverse hosts', async () => {
    const mod = await import(pathToFileURL(PROBE_PATH).href);
    expect(mod.isTargetHost('chatverse-prod.byteintl.net')).toBe(true);
    expect(mod.isTargetHost('chatverse-us-prod.byteintl.net')).toBe(true);
    expect(mod.isTargetHost('chatverse-us.byteintl.net')).toBe(true);
    expect(mod.isTargetHost('chatverse.byteintl.net')).toBe(true);
  });

  it('rejects non-chatverse hosts (no longer matches trae/marscode/icube)', async () => {
    const mod = await import(pathToFileURL(PROBE_PATH).href);
    expect(mod.isTargetHost('trae.cn')).toBe(false);
    expect(mod.isTargetHost('icube.example.com')).toBe(false);
    expect(mod.isTargetHost('marscode.example.com')).toBe(false);
    expect(mod.isTargetHost('localhost')).toBe(false);
    expect(mod.isTargetHost(undefined)).toBe(false);
  });
});

describe('Trae probe — categorizePath', () => {
  it('classifies chatverse endpoints', async () => {
    const mod = await import(pathToFileURL(PROBE_PATH).href);
    expect(mod.categorizePath('/api/ide/v1/chat')).toBe('chat');
    expect(mod.categorizePath('/api/ide/v1/llm_raw_chat')).toBe('chat');
    expect(mod.categorizePath('/api/ide/v2/llm_raw_chat')).toBe('chat');
    expect(mod.categorizePath('/api/ide/v1/agents/runs')).toBe('agent_run');
    expect(mod.categorizePath('/api/ide/v1/agents/runs/abc-123/tool_call_outputs')).toBe('tool_output');
    expect(mod.categorizePath('/api/ide/v1/web_search')).toBe('web_search');
    expect(mod.categorizePath('/api/ide/v1/fast_apply')).toBe('fast_apply');
    expect(mod.categorizePath('/api/ide/v1/ping')).toBe('other');
  });
});

describe('Trae probe — tool status 6→4 mapping', () => {
  it('maps pending/running → running; canceled/interrupted → cancelled', async () => {
    const mod = await import(pathToFileURL(PROBE_PATH).href);
    expect(mod.normalizeToolStatus('pending')).toBe('running');
    expect(mod.normalizeToolStatus('running')).toBe('running');
    expect(mod.normalizeToolStatus('success')).toBe('success');
    expect(mod.normalizeToolStatus('failed')).toBe('failed');
    expect(mod.normalizeToolStatus('canceled')).toBe('cancelled');
    expect(mod.normalizeToolStatus('interrupted')).toBe('cancelled');
  });
});

describe('Trae probe — fx-1 llm.request (POST /api/ide/v1/chat)', () => {
  it('emits llm.request with conversation_id 三件套 + user message parts', async () => {
    const fx1 = require('./fixtures/trae-fx-1-llm-request.json');
    fireChatverseRequest(
      { path: '/api/ide/v1/chat' },
      fx1.request,
      [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: [DONE]\n\n',
      ],
      200,
      { 'content-type': 'text/event-stream' },
    );

    const llmReq = captured.find(r => r['event.name'] === 'llm.request');
    expect(llmReq).toBeDefined();
    expect(llmReq.schema).toBe('loongsuite.pilot.trae.v1');
    expect(llmReq['gen_ai.session.id']).toBe(fx1.request.conversation_id);
    expect(llmReq['gen_ai.turn.id']).toBe(fx1.request.chat_session_id);
    expect(llmReq['gen_ai.step.id']).toBe(fx1.request.chat_message_id);
    expect(llmReq.trace_id).toBe(fx1.request.conversation_id);
    expect(llmReq['gen_ai.request.model']).toBe(fx1.request.model);
    expect(llmReq['gen_ai.agent.name']).toBe(fx1.request.agent.agent_name);
    expect(llmReq['gen_ai.agent.type']).toBe(fx1.request.agent.agent_type);
    expect(llmReq['gen_ai.input.messages']).toEqual([
      { role: 'user', parts: [{ type: 'text', content: fx1.request.query }] },
    ]);
    expect(typeof llmReq['event.id']).toBe('string');
    expect(typeof llmReq.time_unix_nano).toBe('string');
  });

  it('emits llm.response with concatenated delta content on stream end', async () => {
    const fx1 = require('./fixtures/trae-fx-1-llm-request.json');
    fireChatverseRequest(
      { path: '/api/ide/v1/chat' },
      fx1.request,
      [
        'data: {"choices":[{"delta":{"content":"import React"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" from \'react\'"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":";"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ],
    );

    const llmResp = captured.find(r => r['event.name'] === 'llm.response');
    expect(llmResp).toBeDefined();
    expect(llmResp['gen_ai.response.finish_reasons']).toEqual(['stop']);
    expect(llmResp['gen_ai.output.messages']).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: "import React from 'react';" }] },
    ]);
  });
});

describe('Trae probe — fx-3 tool.call + tool.result (run_mcp)', () => {
  it('emits tool.call on POST /agents/runs/:id/tool_call_outputs and tool.result on response', async () => {
    const fx3 = require('./fixtures/trae-fx-3-tool-call-mcp.json');
    fireChatverseRequest(
      { path: `/api/ide/v1/agents/runs/${fx3.run_id}/tool_call_outputs` },
      fx3.request,
      [JSON.stringify(fx3.response)],
      200,
      { 'content-type': 'application/json' },
    );

    const toolCall = captured.find(r => r['event.name'] === 'tool.call');
    const toolResult = captured.find(r => r['event.name'] === 'tool.result');
    expect(toolCall).toBeDefined();
    expect(toolResult).toBeDefined();
    expect(toolCall['gen_ai.tool.name']).toBe('run_mcp');
    expect(toolCall['gen_ai.tool.call.id']).toBe(fx3.request.tool_call_key);
    expect(toolCall['gen_ai.session.id']).toBe(fx3.request.conversation_id);
    expect(toolCall['gen_ai.turn.id']).toBe(fx3.request.chat_session_id);
    expect(toolResult['gen_ai.tool.call.id']).toBe(fx3.request.tool_call_key);
    expect(toolResult['tool.result.status']).toBe('success');
    expect(typeof toolResult['gen_ai.tool.call.duration']).toBe('number');
  });

  it('normalizes canceled tool status → cancelled', async () => {
    const fx3 = require('./fixtures/trae-fx-3-tool-call-mcp.json');
    const canceledResp = {
      ...fx3.response,
      tool: { ...fx3.response.tool, status: 'canceled' },
    };
    fireChatverseRequest(
      { path: `/api/ide/v1/agents/runs/${fx3.run_id}/tool_call_outputs` },
      fx3.request,
      [JSON.stringify(canceledResp)],
    );

    const toolResult = captured.find(r => r['event.name'] === 'tool.result');
    expect(toolResult).toBeDefined();
    expect(toolResult['tool.result.status']).toBe('cancelled');
  });
});

describe('Trae probe — fx-4 web_search tool', () => {
  it('emits tool.call + tool.result for /api/ide/v1/web_search', async () => {
    const fx4 = require('./fixtures/trae-fx-4-tool-call-web-search.json');
    fireChatverseRequest(
      { path: '/api/ide/v1/web_search' },
      fx4.request,
      [JSON.stringify(fx4.response)],
    );

    const toolCall = captured.find(r => r['event.name'] === 'tool.call');
    const toolResult = captured.find(r => r['event.name'] === 'tool.result');
    expect(toolCall).toBeDefined();
    expect(toolResult).toBeDefined();
    expect(toolCall['gen_ai.tool.name']).toBe('web_search');
    expect(toolResult['gen_ai.tool.call.id']).toBe(fx4.request.tool_call_key);
    expect(toolResult['tool.result.status']).toBe('success');
  });
});

describe('Trae probe — fx-5 agent_finish usage renaming', () => {
  it('emits llm.response with gen_ai.usage.* when tool.name=agent_finish', async () => {
    const fx5 = require('./fixtures/trae-fx-5-agent-finish.json');
    fireChatverseRequest(
      { path: `/api/ide/v1/agents/runs/${fx5.run_id}/tool_call_outputs` },
      fx5.request,
      [JSON.stringify(fx5.response)],
    );

    const llmResp = captured.find(r => r['event.name'] === 'llm.response');
    expect(llmResp).toBeDefined();
    expect(llmResp['gen_ai.usage.input_tokens']).toBe(fx5.response.tool.usage.prompt_tokens);
    expect(llmResp['gen_ai.usage.output_tokens']).toBe(fx5.response.tool.usage.completion_tokens);
    expect(llmResp['gen_ai.usage.total_tokens']).toBe(fx5.response.tool.usage.total_tokens);
    expect(llmResp['gen_ai.response.finish_reasons']).toEqual(['stop']);
  });
});

describe('Trae probe — non-chatverse passthrough', () => {
  it('does not emit llm.request/tool.call for non-whitelisted hosts', async () => {
    fakeReq = new FakeClientRequest();
    const res = new FakeIncomingMessage(200, {});
    fakeReq._fakeResponse = res;
    const req = https.request({
      hostname: 'cdn.trae.cn',
      path: '/some/asset',
      method: 'GET',
    });
    req.end();
    res.emit('data', Buffer.from('asset bytes'));
    res.emit('end');

    const filtered = captured.filter(r =>
      r['event.name'] === 'llm.request' || r['event.name'] === 'tool.call');
    expect(filtered).toHaveLength(0);
  });
});

describe('Trae probe — lifecycle activate event', () => {
  it('emits a lifecycle event on import', async () => {
    const lifecycle = captured.find(r => r['event.name'] === 'other' && r.module);
    expect(lifecycle).toBeDefined();
    expect(lifecycle.module).toBe('loongsuite-pilot-trae-probe');
    expect(typeof lifecycle.pid).toBe('number');
  });
});
