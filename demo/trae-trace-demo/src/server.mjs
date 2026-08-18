/**
 * 本地验证服务：构建 trace JSON + 托管前端页面
 * 零外部依赖，只用 node 内置模块。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTrace } from './build-trace.mjs';
import { parseAgentLog } from './parse-agent-log.mjs';
import { loadHookEvents } from './parse-hook-events.mjs';
import { PORT, DEFAULT_SESSION_ID, ensureDataDir, HOOK_EVENTS_FILE, PILOT_DATA_DIR, findLatestLogSession } from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body, null, 2), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

function readJsonlTail(dir, limit = 200) {
  try {
    if (!fs.existsSync(dir)) return { dir, exists: false, count: 0, rows: [] };
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const p = path.join(dir, f);
        return { p, name: f, mtime: fs.statSync(p).mtimeMs };
      })
      .sort((a, b) => a.mtime - b.mtime);
    const rows = [];
    for (const f of files.slice(-5)) {
      const lines = fs.readFileSync(f.p, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try { rows.push({ file: f.name, ...JSON.parse(line) }); } catch { /* ignore bad line */ }
      }
    }
    return { dir, exists: true, count: rows.length, rows: rows.slice(-limit) };
  } catch (err) {
    return { dir, exists: false, count: 0, rows: [], error: String(err && err.stack ? err.stack : err) };
  }
}

const MODEL_CAPTURE_DIR = path.join(PILOT_DATA_DIR, 'logs', 'trae-cn', 'model-capture');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  try {
    if (url.pathname === '/api/trace') {
      const sessionId = url.searchParams.get('session') || DEFAULT_SESSION_ID;
      const started = Date.now();
      const trace = await buildTrace({ sessionId });
      trace.buildMs = Date.now() - started;
      return sendJson(res, trace.ok ? 200 : 500, trace);
    }

    if (url.pathname === '/api/sessions') {
      const started = Date.now();
      const session = findLatestLogSession();
      if (!session) return sendJson(res, 200, { ok: false, sessions: [], buildMs: Date.now() - started });
      const parsed = await parseAgentLog(session.agentLog, { sessionFilter: null });
      const sessions = (parsed.sessions || []).slice().reverse();
      return sendJson(res, 200, {
        ok: true,
        logDir: session.name,
        sessions,
        latest: sessions[0] || DEFAULT_SESSION_ID,
        buildMs: Date.now() - started,
      });
    }

    if (url.pathname === '/api/hook-events') {
      const events = loadHookEvents();
      return sendJson(res, 200, {
        file: HOOK_EVENTS_FILE,
        exists: fs.existsSync(HOOK_EVENTS_FILE),
        count: events.length,
        events: events.slice(-200),
      });
    }

    if (url.pathname === '/api/model-capture') {
      return sendJson(res, 200, readJsonlTail(MODEL_CAPTURE_DIR, 200));
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return sendFile(res, path.join(WEB_DIR, 'index.html'));
    }

    // 静态资源：限制在 web 目录内，避免路径穿越
    const safe = path.normalize(path.join(WEB_DIR, url.pathname));
    if (safe.startsWith(WEB_DIR) && fs.existsSync(safe) && fs.statSync(safe).isFile()) {
      return sendFile(res, safe);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (err) {
    sendJson(res, 500, { ok: false, error: String(err && err.stack ? err.stack : err) });
  }
});

ensureDataDir();
server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(
    [
      '',
      '  TRAE CN Trace Demo 已启动',
      `  前端:      http://127.0.0.1:${PORT}/`,
      `  Trace API: http://127.0.0.1:${PORT}/api/trace?session=${DEFAULT_SESSION_ID}`,
      `  Hook API:  http://127.0.0.1:${PORT}/api/hook-events`,
      `  Model API: http://127.0.0.1:${PORT}/api/model-capture`,
      '',
      '  首次加载需流式扫描数百 MB 日志，约需数秒，请耐心等待。',
      '',
    ].join('\n'),
  );
});
