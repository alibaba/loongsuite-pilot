#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOverviewAggregator } from './lib/agent-overview.mjs';
import { getMetricsCsv, getMetricsStatus, parseWindowMinutes } from './lib/process-metrics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const dashboardPath = path.join(repoRoot, 'assets', 'monitor', 'loongsuite-pilot-monitor.html');

const port = Number(process.env.LOONGSUITE_PILOT_MONITOR_PORT || 8765);
const host = process.env.LOONGSUITE_PILOT_MONITOR_HOST || '127.0.0.1';
const dataDir = process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(homedir(), '.loongsuite-pilot');
const monitorDir = process.env.LOONGSUITE_PILOT_MONITOR_DIR || path.join(dataDir, 'logs', 'process-monitor');
const overview = createOverviewAggregator({ dataDir });
/** ISO timestamp when this dashboard Node process started (same run as `monitor start` dashboard). */
const monitorDashboardStartedAt = new Date().toISOString();

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function sendFile(response, filePath, contentType) {
  response.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'no-store',
  });
  createReadStream(filePath).pipe(response);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host}`);

    if (url.pathname === '/' || url.pathname === '/index.html') {
      sendFile(response, dashboardPath, 'text/html; charset=utf-8');
      return;
    }

    if (url.pathname === '/api/metrics') {
      const minutes = parseWindowMinutes(
        url.searchParams.get('minutes') ?? process.env.LOONGSUITE_PILOT_MONITOR_WINDOW_MINUTES,
      );
      response.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(await getMetricsCsv({ monitorDir, minutes }));
      return;
    }

    if (url.pathname === '/api/status') {
      const minutes = parseWindowMinutes(
        url.searchParams.get('minutes') ?? process.env.LOONGSUITE_PILOT_MONITOR_WINDOW_MINUTES,
      );
      sendJson(response, 200, await getMetricsStatus({ monitorDir, minutes }));
      return;
    }

    if (url.pathname === '/api/overview') {
      const body = await overview.getOverview({
        force: url.searchParams.get('force') === 'true',
      });
      sendJson(response, 200, { ...body, monitorDashboardStartedAt });
      return;
    }

    if (url.pathname.startsWith('/api/overview/agents/')) {
      const agentId = decodeURIComponent(url.pathname.replace('/api/overview/agents/', ''));
      const agent = await overview.getAgent(agentId);
      if (!agent) {
        sendJson(response, 404, { error: 'agent not found', agentId });
        return;
      }
      sendJson(response, 200, agent);
      return;
    }

    sendJson(response, 404, { error: 'not found' });
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : String(error),
      monitorDir,
    });
  }
});

server.listen(port, host, () => {
  console.log(`LoongSuite Pilot monitor dashboard: http://${host}:${port}/`);
  console.log(`Reading monitor CSVs from: ${monitorDir}`);
});
