import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execSync } from 'node:child_process';
import {
  createMockServer,
  createWebtrackingCollector,
  createManifestServer,
  createBrokenPackage,
} from '../../scripts/e2e/lib/mock-server.mjs';

const servers = [];
afterEach(async () => {
  for (const s of servers) await s.close();
  servers.length = 0;
});

describe('createMockServer', () => {
  it('routes requests to matching handler', async () => {
    const handlers = new Map();
    handlers.set('/hello', (_req, res) => {
      res.writeHead(200);
      res.end('world');
    });

    const mock = await createMockServer(handlers);
    servers.push(mock);

    const res = await fetch(`http://127.0.0.1:${mock.port}/hello`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('world');
  });

  it('returns 404 for unregistered paths', async () => {
    const mock = await createMockServer(new Map());
    servers.push(mock);

    const res = await fetch(`http://127.0.0.1:${mock.port}/missing`);
    expect(res.status).toBe(404);
  });
});

describe('createWebtrackingCollector', () => {
  it('collects POST bodies into received array', async () => {
    const collector = await createWebtrackingCollector();
    servers.push(collector);

    const body = JSON.stringify({ foo: 'bar' });
    await fetch(`http://127.0.0.1:${collector.port}/logstores/raw/track`, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json' },
    });

    expect(collector.received.length).toBe(1);
    expect(collector.received[0].body).toBe(body);
    expect(collector.received[0].path).toBe('/logstores/raw/track');
    expect(collector.received[0].headers['content-type']).toBe('application/json');
    expect(collector.received[0].timestamp).toBeGreaterThan(0);
  });

  it('collects multiple requests', async () => {
    const collector = await createWebtrackingCollector();
    servers.push(collector);

    await fetch(`http://127.0.0.1:${collector.port}/a`, { method: 'POST', body: '1' });
    await fetch(`http://127.0.0.1:${collector.port}/b`, { method: 'POST', body: '2' });

    expect(collector.received.length).toBe(2);
    expect(collector.received[0].body).toBe('1');
    expect(collector.received[1].body).toBe('2');
  });
});

describe('createManifestServer', () => {
  it('serves manifest.json and package tar.gz', async () => {
    const tmpPkg = path.join(os.tmpdir(), `test-pkg-${Date.now()}.tar.gz`);
    fs.writeFileSync(tmpPkg, 'fake-tar-content');

    const manifest = { version: '99.0.0', git_commit: 'abc123' };
    const mock = await createManifestServer(0, { manifest, packagePath: tmpPkg });
    servers.push(mock);

    const manifestRes = await fetch(`http://127.0.0.1:${mock.port}/manifest.json`);
    expect(manifestRes.status).toBe(200);
    const json = await manifestRes.json();
    expect(json.version).toBe('99.0.0');
    expect(json.git_commit).toBe('abc123');

    const pkgRes = await fetch(`http://127.0.0.1:${mock.port}/pkg.tar.gz`);
    expect(pkgRes.status).toBe(200);
    expect(await pkgRes.text()).toBe('fake-tar-content');

    fs.unlinkSync(tmpPkg);
  });

  it('returns 404 when package path does not exist', async () => {
    const manifest = { version: '1.0.0' };
    const mock = await createManifestServer(0, {
      manifest,
      packagePath: '/tmp/no-such-file.tar.gz',
    });
    servers.push(mock);

    const res = await fetch(`http://127.0.0.1:${mock.port}/pkg.tar.gz`);
    expect(res.status).toBe(404);
  });
});

describe('createBrokenPackage', () => {
  it('generates a valid tar.gz with crashing dist/index.js', () => {
    const tmpOut = path.join(os.tmpdir(), `broken-${Date.now()}.tar.gz`);
    createBrokenPackage(tmpOut);

    expect(fs.existsSync(tmpOut)).toBe(true);
    expect(fs.statSync(tmpOut).size).toBeGreaterThan(0);

    // Extract and verify contents
    const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-'));
    execSync(`tar -xzf "${tmpOut}" -C "${extractDir}"`, { stdio: 'pipe' });

    const pkgJson = JSON.parse(
      fs.readFileSync(path.join(extractDir, 'package', 'package.json'), 'utf-8'),
    );
    expect(pkgJson.version).toBe('99.9.9');

    const indexJs = fs.readFileSync(
      path.join(extractDir, 'package', 'dist', 'index.js'),
      'utf-8',
    );
    expect(indexJs).toContain('broken-package-e2e-crash');

    const version = fs.readFileSync(
      path.join(extractDir, 'package', 'VERSION'),
      'utf-8',
    );
    expect(version).toContain('version=99.9.9');

    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.unlinkSync(tmpOut);
  });
});
