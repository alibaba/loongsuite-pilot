#!/usr/bin/env node
// Opt-in developer probe; not registered with the collector or any client startup.
import fs from 'node:fs';
import path from 'node:path';
import { SseFrames, projectFrame, scopedRequest } from './doubao-work-stream.mjs';

const [endpoint, nonce, output, duration = '120'] = process.argv.slice(2);
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint ?? '')
  || !/^DBW_[A-Z0-9_]{8,100}$/.test(nonce ?? '') || !output
  || !/^\d+$/.test(duration) || Number(duration) < 10 || Number(duration) > 300) {
  throw Error('Usage: node doubao-work-network-probe.mjs http://127.0.0.1:PORT DBW_UNIQUE_TEST_NONCE NEW_DIRECTORY [10..300 seconds]');
}
if (typeof WebSocket !== 'function') throw Error('This standalone diagnostic needs Node.js 22 or later');
fs.mkdirSync(output, { recursive: false, mode: 0o700 }); // Never mix captures or overwrite evidence.
const file = path.join(output, 'network.jsonl');
const fd = fs.openSync(file, 'wx', 0o600);
const MAX_BYTES = 4 * 1024 * 1024, MAX_STREAM_BYTES = 1024 * 1024;
let bytes = 0, dropped = 0, stopping = false;
const links = new Map(), seen = new Set(), tasks = new Set();
const counts = {}, failures = [];
const count = key => { counts[key] = (counts[key] ?? 0) + 1; };
function record(value) {
  const line = JSON.stringify({ observedMs: Date.now(), ...value }) + '\n';
  const size = Buffer.byteLength(line);
  if (bytes + size > MAX_BYTES) { dropped++; return; }
  try { fs.writeSync(fd, line); bytes += size; } catch { dropped++; }
}
const route = url => { try { return new URL(url).pathname; } catch { return ''; } };
const allowed = url => /^\/chat\/(completion|async\/chunk_stream)$/.test(route(url));

async function connect(target) {
  const address = new URL(target.webSocketDebuggerUrl);
  if (address.protocol !== 'ws:' || address.hostname !== '127.0.0.1'
    || address.port !== new URL(endpoint).port) throw Error('Non-loopback debugger rejected');
  const ws = new WebSocket(address);
  const pending = new Map(), requests = new Map();
  let seq = 0;
  function call(method, params = {}) {
    if (stopping || pending.size >= 8 || ws.readyState !== WebSocket.OPEN) return Promise.reject(Error('Unavailable'));
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(Error('Timeout')); }, 4000);
      pending.set(id, { resolve, reject, timer });
      try { ws.send(JSON.stringify({ id, method, params })); }
      catch { clearTimeout(timer); pending.delete(id); reject(Error('Disconnected')); }
    });
  }
  const finish = request => {
    request.parser?.end();
    if (request.parser?.dropped) count('incompleteOrOversizedSse');
    request.parser = undefined;
  };
  const close = () => {
    for (const request of requests.values()) finish(request);
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('Disconnected')); }
    pending.clear(); requests.clear(); ws.close();
  };
  ws.addEventListener('message', event => {
    let msg; try { msg = JSON.parse(event.data); } catch { count('invalidCdp'); return; }
    if (msg.id) {
      const p = pending.get(msg.id); if (!p) return;
      pending.delete(msg.id); clearTimeout(p.timer);
      msg.error ? p.reject(Error('CDP method unavailable')) : p.resolve(msg.result);
      return;
    }
    const p = msg.params ?? {};
    if (msg.method === 'Network.requestWillBeSent' && allowed(p.request?.url)) {
      if (requests.size >= 64) { count('requestLimit'); return; }
      const request = { requestId: p.requestId, path: route(p.request.url), chunks: [], streamBytes: 0 };
      requests.set(p.requestId, request);
      void (async () => {
        let body = p.request.postData;
        if (body === undefined && p.request.hasPostData) body = (await call('Network.getRequestPostData', { requestId: p.requestId })).postData;
        if (typeof body !== 'string' || Buffer.byteLength(body) > 262144) { requests.delete(p.requestId); return; }
        const projection = scopedRequest(body, nonce, tasks);
        if (!projection) { count('unrelatedRequestsSkipped'); requests.delete(p.requestId); return; }
        request.owned = true;
        count('physicalRequests');
        record({ kind: 'request', targetId: target.id, requestId: p.requestId, path: request.path,
          timestamp: p.timestamp, wallTime: p.wallTime, ...projection });
        if (request.response) await startStream(request, request.response);
      })().catch(() => { count('requestBodyUnavailable'); requests.delete(p.requestId); });
      return;
    }
    const request = requests.get(p.requestId); if (!request) return;
    if (msg.method === 'Network.responseReceived') {
      request.response = p;
      if (request.owned) void startStream(request, p);
    }
    if (!request.owned) return;
    if (msg.method === 'Network.dataReceived' && p.data && request.streaming) {
      const buffer = Buffer.from(p.data, 'base64');
      request.streamBytes += buffer.length;
      if (request.streamBytes > MAX_STREAM_BYTES) {
        if (!request.oversized) { request.oversized = true; count('streamLimit'); finish(request); request.chunks = []; }
        return;
      }
      if (request.parser) request.parser.push(buffer);
      else request.chunks.push(buffer); // Buffered prefix must precede these packets.
    }
    if (msg.method === 'Network.loadingFinished' || msg.method === 'Network.loadingFailed') {
      request.ended = true;
      record({ kind: 'transport_end', targetId: target.id, requestId: p.requestId, timestamp: p.timestamp,
        failed: msg.method === 'Network.loadingFailed', cancelled: p.canceled === true });
      if (request.parser) { finish(request); requests.delete(p.requestId); }
    }
  });
  async function startStream(request, response) {
    if (request.streaming) return;
    request.streaming = true;
    record({ kind: 'response', targetId: target.id, requestId: request.requestId,
      timestamp: response.timestamp, status: response.response?.status, resourceType: response.type });
    try {
      const result = await call('Network.streamResourceContent', { requestId: request.requestId });
      if (stopping || request.oversized) return;
      request.parser = new SseFrames(frame => {
        const projection = projectFrame(frame);
        if (!projection) { count('invalidSseJson'); return; }
        if (projection.event === 'FETCH_STREAM' && projection.taskId && tasks.size < 128) tasks.add(projection.taskId);
        record({ kind: 'sse', targetId: target.id, requestId: request.requestId, ...projection });
      });
      const prefix = Buffer.from(result.bufferedData ?? '', 'base64');
      request.streamBytes += prefix.length;
      if (request.streamBytes > MAX_STREAM_BYTES) { count('streamLimit'); finish(request); request.chunks = []; return; }
      request.parser.push(prefix);
      for (const chunk of request.chunks) request.parser.push(chunk);
      request.chunks = [];
      if (request.ended) { finish(request); requests.delete(request.requestId); }
    } catch { count('streamUnavailable'); request.chunks = []; requests.delete(request.requestId); }
  }
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Connect timeout')), 4000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(Error('Connect failed')); }, { once: true });
    });
    ws.addEventListener('close', close, { once: true });
    await call('Network.enable', { maxTotalBufferSize: 2097152, maxResourceBufferSize: 1048576, maxPostDataSize: 262144 });
    links.set(target.id, { close });
    record({ kind: 'attached', targetId: target.id, targetType: target.type });
  } catch (error) { close(); throw error; }
}

async function discover() {
  const response = await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(4000) });
  const targets = await response.json();
  for (const target of targets) {
    if (stopping || seen.size >= 16) break;
    if (seen.has(target.id) || !['page', 'iframe', 'webview', 'worker', 'service_worker'].includes(target.type)
      || !target.webSocketDebuggerUrl || !/^(?:chrome|doubaowork):\/\/doubaowork-/.test(target.url)) continue;
    seen.add(target.id);
    try { await connect(target); } catch { failures.push({ targetId: target.id, reason: 'attach_failed' }); }
  }
}
let interval, resolveStop;
const stopped = new Promise(resolve => { resolveStop = resolve; });
const stop = () => { stopping = true; resolveStop(); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
const timer = setTimeout(stop, Number(duration) * 1000);
try {
  await discover();
  if (!links.size) throw Error('No supported Doubao page with Network enabled');
  fs.writeFileSync(path.join(output, 'ready.json'), JSON.stringify({ pid: process.pid, attached: links.size, nonce }), { mode: 0o600 });
  console.log(`Ready: ${links.size} Doubao targets. Submit only the new test task containing ${nonce}.`);
  let discovering = false;
  interval = setInterval(() => {
    if (!stopping && !discovering) {
      discovering = true;
      void discover().catch(() => count('discoveryUnavailable')).finally(() => { discovering = false; });
    }
  }, 2500);
  await stopped;
} finally {
  stopping = true; clearTimeout(timer); clearInterval(interval);
  for (const link of links.values()) link.close();
  fs.closeSync(fd);
  const summary = { bytes, dropped, counts, failures, attached: links.size,
    scope: 'client_stream_observation', llmInvocationsProven: false };
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(summary));
}
