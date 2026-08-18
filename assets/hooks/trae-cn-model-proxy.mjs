#!/usr/bin/env node
// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * TRAE CN local model proxy.
 *
 * Runs a loopback OpenAI-compatible proxy for TRAE CN custom-model settings:
 *   Base URL: http://127.0.0.1:<port>
 *
 * It forwards requests to the upstream model endpoint and writes sanitized local
 * capture JSONL under $PILOT_DATA/logs/trae-cn/model-capture/. The proxy never
 * reports to ARMS/SLS by itself. The collector can correlate these rows with
 * hook events through the current TRAE turn state written by trae-cn-hook-processor.mjs.
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const AGENT_ID = 'trae-cn';
const DEFAULT_PORT = 9100;
const DEFAULT_UPSTREAM = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_DATA_DIR = path.join(os.homedir(), '.loongsuite-pilot');

const SECRET_KEY_RE = /(^|[_\-.])(token|secret|password|passwd|credential|auth|api[_\-.]?key|apikey|access[_\-.]?key|private[_\-.]?key|session[_\-.]?key|bearer|cookie|signature|sign|client[_\-.]?secret|refresh[_\-.]?token|id[_\-.]?token|acl[_\-.]?token)([_\-.]|$)/i;
const SECRET_VALUE_RE = /^(eyJ[A-Za-z0-9_-]{16,}\.eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[bpas]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16}|Bearer\s+\S{16,})/;
const DROP_HEADER_RE = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-access-token|x-csrf-token|x-session-token|acl-token)$/i;

const args = process.argv.slice(2);
const val = flag => {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
};

const port = Number(val('--port') || process.env.LOONGSUITE_TRAE_CN_MODEL_PROXY_PORT || DEFAULT_PORT);
const upstreamBase = val('--upstream') || process.env.LOONGSUITE_TRAE_CN_MODEL_PROXY_UPSTREAM || DEFAULT_UPSTREAM;
const dataDir = val('--data-dir') || process.env.LOONGSUITE_PILOT_DATA_DIR || DEFAULT_DATA_DIR;
const captureDir = val('--capture-dir') || path.join(dataDir, 'logs', AGENT_ID, 'model-capture');
const keepSystemChars = Number(val('--keep-system-chars') || process.env.LOONGSUITE_TRAE_CN_KEEP_SYSTEM_CHARS || 200);
const keepUserChars = Number(val('--keep-user-chars') || process.env.LOONGSUITE_TRAE_CN_KEEP_USER_CHARS || 120);

let seq = 0;
fs.mkdirSync(captureDir, { recursive: true });

function today() {
  return new Date().toISOString().slice(0, 10);
}

function appendCapture(record) {
  const file = path.join(captureDir, `trae-cn-model-${today()}.jsonl`);
  fs.appendFileSync(file, JSON.stringify(record) + '\n');
}

function redactTag(reason, len) {
  return `[REDACTED:${reason}:${len}]`;
}

function sanitize(value, key = '', depth = 12) {
  if (depth <= 0) return '[REDACTED:max-depth]';
  if (value == null) return value;
  if (typeof value === 'string') {
    if (SECRET_KEY_RE.test(key)) return redactTag('key-name', value.length);
    if (SECRET_VALUE_RE.test(value)) return redactTag('value-shape', value.length);
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(v => sanitize(v, key, depth - 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitize(v, k, depth - 1);
    return out;
  }
  return String(value);
}

function sanitizeHeaders(headers) {
  const kept = {};
  const dropped = [];
  for (const [key, value] of Object.entries(headers || {})) {
    const sv = String(value);
    if (DROP_HEADER_RE.test(key) || SECRET_KEY_RE.test(key) || SECRET_VALUE_RE.test(sv)) {
      dropped.push(key.toLowerCase());
      continue;
    }
    kept[key.toLowerCase()] = sv;
  }
  return { headers: kept, dropped_headers: dropped };
}

function summarizeMessages(messages) {
  if (!Array.isArray(messages)) return undefined;
  return messages.map(message => {
    const content = typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? null);
    const keep = message?.role === 'system' ? keepSystemChars : keepUserChars;
    return {
      role: message?.role,
      chars: content.length,
      head: content.slice(0, keep),
      truncated: content.length > keep,
    };
  });
}

function latestTurnContext() {
  const dir = path.join(dataDir, 'state', AGENT_ID, 'turns');
  try {
    const files = fs.readdirSync(dir)
      .filter(name => name.endsWith('.json'))
      .map(name => {
        const file = path.join(dir, name);
        return { file, mtimeMs: fs.statSync(file).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const item of files.slice(0, 5)) {
      const state = JSON.parse(fs.readFileSync(item.file, 'utf8'));
      if (!state?.traceId || !state?.turnId) continue;
      if (Date.now() - Number(state.startedAt || item.mtimeMs) > 10 * 60 * 1000) continue;
      return {
        trace_id: state.traceId,
        'gen_ai.turn.id': state.turnId,
        'gen_ai.step.id': state.stepId,
        'agent.trae.model_proxy.turn_state_file': path.basename(item.file),
      };
    }
  } catch {
    // no active hook turn yet
  }
  return {
    'gen_ai.observability.missing.trace_correlation': true,
    'gen_ai.observability.missing.trace_correlation.reason': 'no_recent_trae_cn_hook_turn_state',
  };
}

function buildUpstreamUrl(base, reqUrl) {
  const b = new URL(base);
  const normalizedBasePath = b.pathname.replace(/\/$/, '');
  const normalizedReqPath = String(reqUrl || '/').replace(/^\//, '');
  return new URL(`${b.origin}${normalizedBasePath}/${normalizedReqPath}`);
}

const server = http.createServer((req, res) => {
  const id = ++seq;
  const startedAt = Date.now();
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const bodyBuf = Buffer.concat(chunks);
    let body = null;
    try { body = bodyBuf.length ? JSON.parse(bodyBuf.toString('utf8')) : null; } catch { /* non-json */ }

    const requestedUpstream = req.headers['x-upstream-target'] || upstreamBase;
    const upstream = buildUpstreamUrl(String(requestedUpstream), req.url);
    const safeHeaders = sanitizeHeaders(req.headers);
    delete safeHeaders.headers['x-upstream-target'];
    const turn = latestTurnContext();

    appendCapture({
      id,
      ts: new Date().toISOString(),
      kind: 'llm.request.capture',
      agent_id: AGENT_ID,
      ...turn,
      method: req.method,
      url: upstream.pathname + upstream.search,
      upstream_host: upstream.host,
      ...safeHeaders,
      body_chars: bodyBuf.length,
      body: body ? sanitize(body) : undefined,
      messages_summary: summarizeMessages(body?.messages),
      model: body?.model ?? null,
      stream: Boolean(body?.stream),
    });

    const transport = upstream.protocol === 'https:' ? https : http;
    const fwdHeaders = { ...req.headers, host: upstream.host };
    delete fwdHeaders['x-upstream-target'];
    const upReq = transport.request(upstream, { method: req.method, headers: fwdHeaders }, upRes => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      const isSse = String(upRes.headers['content-type'] || '').includes('text/event-stream');
      const respChunks = [];
      const sseEvents = [];
      const sseDeltaTexts = [];
      const sseReasoningTexts = [];
      upRes.on('data', chunk => {
        res.write(chunk);
        respChunks.push(chunk);
        if (!isSse) return;
        for (const line of chunk.toString('utf8').split('\n')) {
          const m = /^data:\s*(.+)$/.exec(line.trim());
          if (!m) continue;
          if (m[1] === '[DONE]') { sseEvents.push({ done: true }); continue; }
          try {
            const ev = JSON.parse(m[1]);
            const delta = ev.choices?.[0]?.delta;
            const deltaText = delta?.content || '';
            const reasoningText = delta?.reasoning_content || delta?.reasoning || '';
            if (deltaText) sseDeltaTexts.push(deltaText);
            if (reasoningText) sseReasoningTexts.push(reasoningText);
            sseEvents.push({
              delta_chars: deltaText.length,
              reasoning_chars: reasoningText.length,
              delta_text: deltaText || undefined,
              reasoning_text: reasoningText || undefined,
              tool_calls: delta?.tool_calls?.length || 0,
              tool_calls_delta: delta?.tool_calls ? sanitize(delta.tool_calls) : undefined,
              finish_reason: ev.choices?.[0]?.finish_reason ?? null,
              usage: ev.usage ? sanitize(ev.usage) : undefined,
            });
          } catch {
            // heartbeat or vendor-specific non-json chunk
          }
        }
      });
      upRes.on('end', () => {
        res.end();
        const respBuf = Buffer.concat(respChunks);
        let respBody;
        if (!isSse) {
          try { respBody = JSON.parse(respBuf.toString('utf8')); } catch { /* non-json */ }
        }
        const totalReasoning = sseEvents.reduce((sum, e) => sum + (e.reasoning_chars || 0), 0);
        const totalDelta = sseEvents.reduce((sum, e) => sum + (e.delta_chars || 0), 0);
        const sseText = sseDeltaTexts.join('');
        const sseReasoningText = sseReasoningTexts.join('');
        appendCapture({
          id,
          ts: new Date().toISOString(),
          kind: 'llm.response.capture',
          agent_id: AGENT_ID,
          ...turn,
          status: upRes.statusCode,
          ms: Date.now() - startedAt,
          is_sse: isSse,
          body_chars: respBuf.length,
          body: respBody ? sanitize(respBody) : undefined,
          sse_events: isSse ? sseEvents : undefined,
          sse_text: isSse ? sseText : undefined,
          sse_reasoning_text: isSse ? sseReasoningText : undefined,
          sse_total_delta_chars: isSse ? totalDelta : undefined,
          sse_total_reasoning_chars: isSse ? totalReasoning : undefined,
          'gen_ai.observability.missing.reasoning': isSse && totalReasoning === 0 ? true : undefined,
          'gen_ai.observability.missing.reasoning.reason': isSse && totalReasoning === 0 ? 'upstream_sse_has_no_reasoning_delta' : undefined,
        });
        console.log(`[#${id}] <- ${upRes.statusCode} ${respBuf.length}B ${Date.now() - startedAt}ms${isSse ? ` (SSE ${sseEvents.length} events)` : ''}`);
      });
    });

    upReq.on('error', err => {
      appendCapture({ id, ts: new Date().toISOString(), kind: 'error', agent_id: AGENT_ID, ...turn, error: String(err.message || err) });
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream', detail: String(err.message || err) }));
    });
    if (bodyBuf.length) upReq.write(bodyBuf);
    upReq.end();
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`TRAE CN model proxy on http://127.0.0.1:${port}`);
  console.log(`upstream: ${upstreamBase}`);
  console.log(`capture : ${captureDir}`);
  console.log('Authorization/Cookie/acl-token are dropped from capture output.');
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
