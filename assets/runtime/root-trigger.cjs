// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function rootTriggerEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.LOONGSUITE_PILOT_ROOT_TRIGGER || '').trim());
}

// Embedding launchers must preserve their caller's cwd for Agent discovery.
function collectorCwd() {
  return process.cwd();
}

// Call only for PID/sentinel descriptors, never configuration or event files.
function prepareCoordinationFile(fd) {
  if (process.getuid?.() === 0 && rootTriggerEnabled()) fs.fchmodSync(fd, 0o644);
}

// Publish a coordination claim without replacing another trigger's file.
function atomicClaim(target, payload) {
  const temporary = `${target}.${process.pid}.${process.hrtime.bigint()}.tmp`;
  let created = false;
  try {
    const fd = fs.openSync(temporary, 'wx');
    created = true;
    try {
      fs.writeFileSync(fd, payload, 'utf8');
      prepareCoordinationFile(fd);
    } finally { fs.closeSync(fd); }
    try { fs.linkSync(temporary, target); return true; }
    catch (error) {
      if (error.code === 'EEXIST') return false;
      // Some mounted filesystems do not support hardlinks. The empty exclusive
      // claim retains the launcher's existing stale-claim recovery protocol.
      let fallback;
      try { fallback = fs.openSync(target, 'wx'); }
      catch (error) { if (error.code === 'EEXIST') return false; throw error; }
      try { prepareCoordinationFile(fallback); }
      finally { fs.closeSync(fallback); }
      return true;
    }
  } finally {
    if (created) { try { fs.unlinkSync(temporary); } catch {} }
  }
}

function reuseRootCollector(dataDir, daemonEntry) {
  if (process.platform !== 'linux' || process.getuid?.() === 0 || !rootTriggerEnabled()) return false;
  let fd;
  try {
    fd = fs.openSync(path.join(dataDir, 'daemon.spawn.lock'), fs.constants.O_RDONLY
      | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== 0 || stat.size > 64) return false;
    const bytes = Buffer.alloc(65);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (count > 64) return false;
    const pid = bytes.toString('utf8', 0, count).trim();
    if (!pid) {
      const age = Date.now() - stat.mtimeMs;
      return age >= 0 && age < 60_000;
    }
    if (!/^[1-9]\d*$/.test(pid)) return false;
    const procFd = fs.openSync(`/proc/${pid}/cmdline`, 'r');
    try {
      const command = Buffer.alloc(4096);
      const length = fs.readSync(procFd, command, 0, command.length, 0);
      return command.toString('utf8', 0, length).split('\0').includes(daemonEntry);
    } finally { fs.closeSync(procFd); }
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

module.exports = { rootTriggerEnabled, collectorCwd, prepareCoordinationFile, atomicClaim, reuseRootCollector };
