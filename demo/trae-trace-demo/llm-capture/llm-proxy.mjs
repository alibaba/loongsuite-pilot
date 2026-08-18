#!/usr/bin/env node
/**
 * LLM capture proxy —— OpenAI-compatible 捕获代理（路线 A）。
 *
 * 用途：把 IDE/Agent 的「自定义模型」指到本代理，代理透传到真实上游，
 * 同时把请求体结构与响应（含 SSE delta）捕获到本地 JSONL，供接进 trace demo。
 *
 * 用法：
 *   node llm-capture/llm-proxy.mjs \
 *     [--port 9100] \
 *     [--upstream https://dashscope.aliyuncs.com/compatible-mode/v1] \
 *     [--out llm-capture/out/capture.jsonl]
 *
 *   客户端配置 base_url = http://127.0.0.1:9100
 *   单请求临时改上游：加请求头 `X-Upstream-Target: https://host/path-prefix`
 *
 * 安全约定（不可协商）：
 *   1. Authorization / Cookie 等凭据头**整体丢弃**，不进捕获文件；
 *      但会原样转发给上游（否则上游 401）；
 *   2. 请求体 / 响应体过 sanitize() 递归脱敏后才落盘；
 *   3. 捕获文件默认落在 llm-capture/out/，该目录已加 .gitignore；
 *   4. 不做 TLS 拦截——这是明文本地代理，客户端要信任它才能用。
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { sanitize, sanitizeHeaders, summarizeMessages } from './sanitize.mjs';

const args = process.argv.slice(2);
const val = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const PORT = Number(val('--port') || 9100);
const DEFAULT_UPSTREAM = val('--upstream') || null;
const OUT = val('--out') || path.join(path.dirname(new URL(import.meta.url).pathname), 'out', 'capture.jsonl');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const outStream = fs.createWriteStream(OUT, { flags: 'a' });
const write = rec => outStream.write(JSON.stringify(rec) + '\n');

let seq = 0;

const server = http.createServer((clientReq, clientRes) => {
  const id = ++seq;
  const startedAt = Date.now();

  // 上游目标：默认值或请求头临时指定（X-Upstream-Target）
  const upstreamBase = clientReq.headers['x-upstream-target'] || DEFAULT_UPSTREAM;
  if (!upstreamBase) {
    clientRes.writeHead(502, { 'content-type': 'application/json' });
    clientRes.end(JSON.stringify({ error: 'no upstream: set --upstream or X-Upstream-Target header' }));
    return;
  }

  const chunks = [];
  clientReq.on('data', c => chunks.push(c));
  clientReq.on('end', () => {
    const bodyBuf = Buffer.concat(chunks);

    // ---- 捕获请求（脱敏后）----
    let bodyJson = null;
    try { bodyJson = bodyBuf.length ? JSON.parse(bodyBuf.toString('utf8')) : null; } catch { /* 非 JSON，只记长度 */ }
    const { headers: safeHeaders, dropped } = sanitizeHeaders(clientReq.headers);
    delete safeHeaders['x-upstream-target'];
    const upstream = new URL(new URL(upstreamBase).origin + path.posix.join(new URL(upstreamBase).pathname, clientReq.url));

    const record = {
      id,
      ts: new Date().toISOString(),
      kind: 'request',
      method: clientReq.method,
      url: upstream.pathname + upstream.search,
      upstream_host: upstream.host,
      headers: safeHeaders,
      dropped_headers: dropped,
      body_chars: bodyBuf.length,
      body: bodyJson ? sanitize(bodyJson) : null,
      // messages 单独摘要：结构指纹，便于对拍 trace 里的 LLM span
      messages_summary: bodyJson?.messages ? summarizeMessages(bodyJson.messages) : undefined,
      stream: Boolean(bodyJson?.stream),
      model: bodyJson?.model ?? null,
    };
    write(record);
    console.log(`[#${id}] ${clientReq.method} ${upstream.host}${upstream.pathname} model=${record.model ?? '-'} stream=${record.stream}`);

    // ---- 转发（原始头 + 原始体，凭据头照转不误，只是不落盘）----
    const mod = upstream.protocol === 'https:' ? https : http;
    const fwdHeaders = { ...clientReq.headers };
    delete fwdHeaders['x-upstream-target'];
    delete fwdHeaders['host'];
    fwdHeaders['host'] = upstream.host;

    const upReq = mod.request(upstream, { method: clientReq.method, headers: fwdHeaders }, upRes => {
      clientRes.writeHead(upRes.statusCode || 502, upRes.headers);

      const isSSE = String(upRes.headers['content-type'] || '').includes('text/event-stream');
      const respChunks = [];
      const sseEvents = [];

      upRes.on('data', c => {
        clientRes.write(c);
        respChunks.push(c);
        // SSE 逐条解析 delta，只留增量文本与 finish_reason，不存原文
        if (isSSE) {
          for (const line of c.toString('utf8').split('\n')) {
            const m = /^data:\s*(.+)$/.exec(line.trim());
            if (!m) continue;
            if (m[1] === '[DONE]') { sseEvents.push({ done: true }); continue; }
            try {
              const ev = JSON.parse(m[1]);
              const delta = ev.choices?.[0]?.delta;
              sseEvents.push({
                delta_chars: (delta?.content || '').length,
                reasoning_chars: (delta?.reasoning_content || delta?.reasoning || '').length,
                tool_calls: delta?.tool_calls?.length || 0,
                finish_reason: ev.choices?.[0]?.finish_reason ?? null,
                usage: ev.usage ?? undefined,
              });
            } catch { /* 心跳/注释行 */ }
          }
        }
      });
      upRes.on('end', () => {
        clientRes.end();
        const respBuf = Buffer.concat(respChunks);
        let respJson = null;
        if (!isSSE) {
          try { respJson = JSON.parse(respBuf.toString('utf8')); } catch { /* 非 JSON */ }
        }
        write({
          id,
          ts: new Date().toISOString(),
          kind: 'response',
          status: upRes.statusCode,
          ms: Date.now() - startedAt,
          is_sse: isSSE,
          body_chars: respBuf.length,
          // 非 SSE：脱敏后的完整响应；SSE：只存 delta 统计序列
          body: respJson ? sanitize(respJson) : undefined,
          sse_events: isSSE ? sseEvents : undefined,
          sse_total_delta_chars: isSSE ? sseEvents.reduce((s, e) => s + (e.delta_chars || 0), 0) : undefined,
          sse_total_reasoning_chars: isSSE ? sseEvents.reduce((s, e) => s + (e.reasoning_chars || 0), 0) : undefined,
        });
        console.log(`[#${id}] <- ${upRes.statusCode} ${respBuf.length}B ${Date.now() - startedAt}ms${isSSE ? ` (SSE ${sseEvents.length} events)` : ''}`);
      });
    });

    upReq.on('error', err => {
      write({ id, ts: new Date().toISOString(), kind: 'error', error: String(err.message || err) });
      console.error(`[#${id}] upstream error: ${err.message}`);
      if (!clientRes.headersSent) clientRes.writeHead(502, { 'content-type': 'application/json' });
      clientRes.end(JSON.stringify({ error: 'upstream', detail: String(err.message || err) }));
    });

    if (bodyBuf.length) upReq.write(bodyBuf);
    upReq.end();
  });

  clientReq.on('error', () => { /* 客户端断连，忽略 */ });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`LLM capture proxy on http://127.0.0.1:${PORT}`);
  console.log(`upstream: ${DEFAULT_UPSTREAM || '(未设，需请求头 X-Upstream-Target)'}`);
  console.log(`capture : ${OUT}`);
  console.log('注意：Authorization/Cookie 不落盘；请求响应体均脱敏。');
});

process.on('SIGINT', () => { outStream.end(); process.exit(0); });
process.on('SIGTERM', () => { outStream.end(); process.exit(0); });
