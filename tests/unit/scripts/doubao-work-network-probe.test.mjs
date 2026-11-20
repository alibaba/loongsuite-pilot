import { it, expect } from 'vitest';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Exercise the real command without a client/account: Chrome may deliver data
// and loadingFinished before the streamResourceContent command's buffered prefix.
it.skipIf(typeof WebSocket !== 'function')('keeps buffered prefix ordering, handles response-before-body and disconnects without interception', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'doubao-network-probe-'));
  const output = path.join(root, 'capture');
  const taskScope = path.join(root, 'task-scope.json');
  const nonce = 'DBW_SYNTHETIC_NETWORK_TEST';
  const methods = [], streamed = [], sockets = new Set();
  let child, publish;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify([{ id: 'synthetic', type: 'page', url: 'doubaowork://doubaowork-chat/chat',
      webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/page/synthetic` }]));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket) => {
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const send = obj => {
      const body = Buffer.from(JSON.stringify(obj));
      const header = Buffer.alloc(body.length < 126 ? 2 : 4);
      header[0] = 0x81;
      if (body.length < 126) header[1] = body.length;
      else { header[1] = 126; header.writeUInt16BE(body.length, 2); }
      socket.write(Buffer.concat([header, body]));
    };
    publish = params => send(params);
    let buffered = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 2) {
        let length = buffered[1] & 127, offset = 2;
        if (length === 126) { if (buffered.length < 4) return; length = buffered.readUInt16BE(2); offset = 4; }
        const maskSize = buffered[1] & 128 ? 4 : 0;
        if (buffered.length < offset + maskSize + length) return;
        const payload = Buffer.from(buffered.subarray(offset + maskSize, offset + maskSize + length));
        if (maskSize) for (let i = 0; i < length; i++) payload[i] ^= buffered[offset + (i % 4)];
        const opcode = buffered[0] & 15;
        buffered = buffered.subarray(offset + maskSize + length);
        if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (opcode !== 1) continue;
        const msg = JSON.parse(payload.toString());
        methods.push(msg.method);
        if (msg.method === 'Network.getRequestPostData') {
          setTimeout(() => send({ id: msg.id, result: { postData: JSON.stringify({
            messages: [{ local_message_id: 'same-local', content_block: [{ content: { text_block: { text: nonce } } }] }],
            headers: { Authorization: 'PRIVATE_AUTH' },
          }) } }), 20);
          send({ method: 'Network.responseReceived', params: { requestId: msg.params.requestId,
            timestamp: 1, type: 'Fetch', response: { status: 200, headers: { Cookie: 'PRIVATE_COOKIE' } } } });
        } else if (msg.method === 'Network.streamResourceContent') {
          streamed.push(msg.params.requestId);
          const raw = Buffer.from('id: 1\r\nevent: CHUNK_DELTA\r\ndata: {"text":"中文🙂"}\r\n\r\n'
            + 'id: 2\nevent: SSE_REPLY_END\ndata: {"end_type":1,"msg_finish_attr":{"msgid":"same-answer"}}\n\n');
          const split = raw.indexOf(Buffer.from('中文')) + 1;
          send({ method: 'Network.dataReceived', params: { requestId: msg.params.requestId, data: raw.subarray(split).toString('base64') } });
          send({ method: 'Network.loadingFinished', params: { requestId: msg.params.requestId, timestamp: 2 } });
          send({ id: msg.id, result: { bufferedData: raw.subarray(0, split).toString('base64') } });
        } else send({ id: msg.id, result: {} });
      }
    });
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    child = spawn(process.execPath, [fileURLToPath(new URL('../../../scripts/diagnostics/doubao-work-network-probe.mjs', import.meta.url)),
      `http://127.0.0.1:${server.address().port}`, nonce, output, '10', taskScope], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    const deadline = Date.now() + 5000;
    while (!stdout.includes('Ready:')) {
      if (child.exitCode !== null || Date.now() > deadline) throw Error(`Probe did not start: ${stderr}`);
      await new Promise(r => setTimeout(r, 20));
    }
    publish({ method: 'Network.requestWillBeSent', params: { requestId: 'unrelated', request: {
      url: 'https://example.invalid/chat/completion', postData: '{"messages":[{"content":"PRIVATE_OLD_HISTORY"}]}' } } });
    for (const requestId of ['physical-one', 'physical-mirror']) publish({ method: 'Network.requestWillBeSent', params: {
      requestId, timestamp: 0, wallTime: 1790000000, request: { url: 'https://example.invalid/chat/completion', hasPostData: true },
    } });
    let lines;
    while (true) {
      lines = (await readFile(path.join(output, 'network.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
      if (lines.filter(x => x.kind === 'sse').length === 4) break;
      if (Date.now() > deadline) throw Error(`Missing stream events: ${stderr}`);
      await new Promise(r => setTimeout(r, 20));
    }
    expect(lines.filter(x => x.kind === 'sse' && x.event === 'CHUNK_DELTA').map(x => x.text)).toEqual(['中文🙂', '中文🙂']);
    expect(lines.filter(x => x.kind === 'sse' && x.event === 'SSE_REPLY_END').map(x => x.messageId)).toEqual(['same-answer', 'same-answer']);
    expect(JSON.stringify(lines)).not.toContain('PRIVATE_');
    for (const taskId of ['owned-async', 'unrelated-async']) {
      publish({ method: 'Network.requestWillBeSent', params: { requestId: taskId, timestamp: 3, wallTime: 1790000001,
        request: { url: 'https://example.invalid/chat/async/chunk_stream', postData: JSON.stringify({ task_id: taskId, private: 'PRIVATE_ASYNC_BODY' }) },
      } });
      publish({ method: 'Network.responseReceived', params: { requestId: taskId, timestamp: 4, type: 'Fetch', response: { status: 200 } } });
    }
    // Native SDK correlation arrives after the async response. Until this
    // explicit binding exists, neither response may be streamed or recorded.
    await new Promise(r => setTimeout(r, 50));
    expect(streamed).not.toContain('owned-async');
    expect(streamed).not.toContain('unrelated-async');
    await writeFile(taskScope, JSON.stringify(['owned-async']));
    while (true) {
      lines = (await readFile(path.join(output, 'network.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
      if (lines.filter(x => x.kind === 'sse').length === 6) break;
      if (Date.now() > deadline) throw Error(`Late async binding was not captured: ${stderr}`);
      await new Promise(r => setTimeout(r, 20));
    }
    expect(streamed).toContain('owned-async');
    expect(streamed).not.toContain('unrelated-async');
    expect(lines.find(x => x.requestId === 'owned-async' && x.kind === 'request').basis).toBe('explicit_task_scope');
    expect(JSON.stringify(lines)).not.toContain('PRIVATE_');
    expect(methods.every(m => ['Network.enable', 'Network.getRequestPostData', 'Network.streamResourceContent'].includes(m))).toBe(true);
    const exited = new Promise(resolve => child.once('close', resolve));
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    const summary = JSON.parse(await readFile(path.join(output, 'summary.json'), 'utf8'));
    expect(summary.counts.physicalRequests).toBe(3);
    expect(summary.dropped).toBe(0);
    expect(summary.llmInvocationsProven).toBe(false);
  } finally {
    child?.kill('SIGTERM');
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
