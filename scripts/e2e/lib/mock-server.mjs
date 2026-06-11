import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import os from 'node:os';

/**
 * Generic HTTP mock server with path→handler routing.
 */
export function createMockServer(handlers, port = 0) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1`);
      const handler = handlers.get(url.pathname);
      if (handler) {
        handler(req, res);
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    server.listen(port, '127.0.0.1', () => {
      const assignedPort = server.address().port;
      resolve({
        port: assignedPort,
        server,
        close: () => new Promise((r) => server.close(r)),
      });
    });

    server.on('error', reject);
  });
}

/**
 * Mock webtracking collector — collects POST bodies into an array.
 */
export async function createWebtrackingCollector(port = 0) {
  const received = [];

  const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        received.push({
          path: req.url,
          body: Buffer.concat(chunks).toString('utf-8'),
          headers: req.headers,
          timestamp: Date.now(),
        });
        res.writeHead(200);
        res.end('OK');
      });
    } else {
      res.writeHead(200);
      res.end('OK');
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        received,
        port: server.address().port,
        close: () => new Promise((r) => server.close(r)),
      });
    });
    server.on('error', reject);
  });
}

/**
 * Serves manifest.json and a tar.gz package file for updater testing.
 */
export async function createManifestServer(port = 0, { manifest, packagePath }) {
  const handlers = new Map();

  handlers.set('/manifest.json', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(manifest));
  });

  handlers.set('/pkg.tar.gz', (_req, res) => {
    if (!fs.existsSync(packagePath)) {
      res.writeHead(404);
      res.end('Package not found');
      return;
    }
    const stat = fs.statSync(packagePath);
    res.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Length': stat.size,
    });
    fs.createReadStream(packagePath).pipe(res);
  });

  return createMockServer(handlers, port);
}

/**
 * Generates a minimal tar.gz with a crashing dist/index.js for rollback testing.
 */
export function createBrokenPackage(outputPath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broken-pkg-'));
  const pkgDir = path.join(tmpDir, 'package');
  fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(pkgDir, 'scripts'), { recursive: true });

  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'loongsuite-pilot', version: '99.9.9' }, null, 2),
  );

  fs.writeFileSync(
    path.join(pkgDir, 'VERSION'),
    'version=99.9.9\ngit_commit=broken\n',
  );

  fs.writeFileSync(
    path.join(pkgDir, 'dist', 'index.js'),
    'throw new Error("broken-package-e2e-crash");\n',
  );

  fs.writeFileSync(
    path.join(pkgDir, 'scripts', 'collector-daemon.js'),
    `'use strict';
// Crash immediately so installer health-check detects failure and triggers rollback
process.exit(1);
`,
  );

  fs.writeFileSync(
    path.join(pkgDir, 'scripts', 'updater-daemon.js'),
    'process.exit(0);\n',
  );

  // Include the real loongsuite-pilot.sh so installer's install_loongsuite_pilot_command succeeds
  const candidates = [
    path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../loongsuite-pilot.sh'),
    '/opt/project/scripts/loongsuite-pilot.sh',
  ];
  const realScriptPath = candidates.find((p) => fs.existsSync(p));
  if (realScriptPath) {
    fs.copyFileSync(realScriptPath, path.join(pkgDir, 'scripts', 'loongsuite-pilot.sh'));
  } else {
    throw new Error(
      `createBrokenPackage: cannot find loongsuite-pilot.sh (tried: ${candidates.join(', ')})`,
    );
  }

  const parentDir = path.dirname(outputPath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  execSync(`tar -czf "${outputPath}" -C "${tmpDir}" package`, { stdio: 'pipe' });

  fs.rmSync(tmpDir, { recursive: true, force: true });

  return outputPath;
}
