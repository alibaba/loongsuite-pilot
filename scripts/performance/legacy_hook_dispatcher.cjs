#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');

const [queuePath, statusPath, donePath, container, hookPath] = process.argv.slice(2);
const concurrency = 8;
const capacity = 8192;
const queues = new Map();
const active = new Map();
let pending = 0;
let queued = 0;
let started = 0;
let completed = 0;
let offset = 0;
let carry = Buffer.alloc(0);
let lastStatus = '';
let stopped = false;
let timer;

function publish(state, error) {
    const value = JSON.stringify({
        state, consumed_bytes: offset - carry.length,
        queued, started, completed, active: active.size, pending,
        ...(error ? { error } : {}),
    });
    if (value !== lastStatus) {
        fs.writeFileSync(statusPath + '.tmp', value);
        fs.renameSync(statusPath + '.tmp', statusPath);
        lastStatus = value;
    }
}

function fail(error) {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    for (const { child } of active.values()) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    }
    publish('failed', String(error.message || error));
    console.error(error.stack || error);
    process.exit(1);
}

const fd = fs.openSync(queuePath, 'r');
const readBuffer = Buffer.alloc(65536);

function enqueue(line) {
    const payload = JSON.parse(line);
    if (payload.hook_event_name !== 'Stop' ||
            typeof payload.session_id !== 'string' ||
            typeof payload.transcript_path !== 'string' ||
            typeof payload.cwd !== 'string') {
        throw new Error('invalid raw legacy Stop payload');
    }
    if (pending >= capacity) throw new Error('legacy Stop queue capacity exceeded');
    const key = payload.transcript_path;
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key).push(line);
    pending++;
    queued++;
}

function launch(key, line) {
    const child = spawn('docker', ['exec', '-i', container, 'bash', hookPath], {
        stdio: ['pipe', 'ignore', 'pipe'],
        detached: true,
    });
    const job = { child, stderr: '' };
    active.set(key, job);
    started++;
    child.stderr.on('data', data => {
        job.stderr = (job.stderr + data.toString()).slice(-4096);
    });
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.on('close', (code, signal) => {
        if (stopped) return;
        active.delete(key);
        if (code !== 0) {
            fail(new Error('legacy Stop Hook failed code=' + code + ' signal=' + signal + ' ' + job.stderr));
            return;
        }
        completed++;
        pump();
    });
    child.stdin.end(line + '\n');
}

function pump() {
    if (stopped) return;
    try {
        // Preserve every Stop. Only the product's own cursor decides which raw
        // transcript rows a Hook invocation consumes.
        for (let reads = 0; reads < 4; reads++) {
            const count = fs.readSync(fd, readBuffer, 0, readBuffer.length, offset);
            if (count === 0) break;
            offset += count;
            carry = Buffer.concat([carry, readBuffer.subarray(0, count)]);
            let newline;
            while ((newline = carry.indexOf(10)) !== -1) {
                const line = carry.subarray(0, newline).toString('utf8');
                carry = carry.subarray(newline + 1);
                enqueue(line);
            }
            if (carry.length > 65536) throw new Error('oversized legacy Stop payload');
        }
        for (const [key, jobs] of queues) {
            if (active.size >= concurrency) break;
            if (active.has(key)) continue;
            const line = jobs.shift();
            pending--;
            if (jobs.length === 0) queues.delete(key);
            launch(key, line);
        }
        if (fs.existsSync(donePath)) {
            const expectedBytes = Number(fs.readFileSync(donePath, 'utf8'));
            if (!Number.isSafeInteger(expectedBytes) || expectedBytes < offset) {
                throw new Error('invalid legacy Stop queue close boundary');
            }
            if (offset === expectedBytes && carry.length !== 0) {
                throw new Error('incomplete legacy Stop payload at close');
            }
            if (offset === expectedBytes && pending === 0 && active.size === 0) {
                stopped = true;
                clearInterval(timer);
                fs.closeSync(fd);
                publish('closed');
                return;
            }
        }
        publish(active.size || pending ? 'running' : 'ready');
    } catch (error) {
        fail(error);
    }
}

process.on('SIGTERM', () => fail(new Error('legacy Stop dispatcher terminated')));
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
publish('ready');
timer = setInterval(pump, 20);
pump();
