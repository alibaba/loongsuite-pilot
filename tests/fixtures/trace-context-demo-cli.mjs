#!/usr/bin/env node
// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal downstream CLI used by trace-context propagation tests.
 *
 * It behaves like a user-owned CLI: read W3C context from the environment,
 * validate TRACEPARENT, and persist what the process actually received.
 */

import fs from 'node:fs';
import path from 'node:path';

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
const ZERO_TRACE_ID = '0'.repeat(32);
const ZERO_SPAN_ID = '0'.repeat(16);

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const outputPath = option('--output');
const allowMissing = process.argv.includes('--allow-missing');
const requestedExitCode = Number.parseInt(option('--exit-code') ?? '0', 10);
const traceparent = process.env.TRACEPARENT ?? null;
const tracestate = process.env.TRACESTATE ?? null;
const resourceAttributes = process.env.OTEL_RESOURCE_ATTRIBUTES ?? null;
const match = typeof traceparent === 'string' ? TRACEPARENT_RE.exec(traceparent.trim()) : null;
const valid = Boolean(
  match
  && match[1].toLowerCase() !== ZERO_TRACE_ID
  && match[2].toLowerCase() !== ZERO_SPAN_ID,
);

const result = {
  traceparent,
  tracestate,
  resourceAttributes,
  valid,
  traceId: valid ? match[1].toLowerCase() : null,
  parentSpanId: valid ? match[2].toLowerCase() : null,
  traceFlags: valid ? match[3].toLowerCase() : null,
  argv: process.argv.slice(2),
};

if (outputPath) {
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result)}\n`, 'utf-8');
}

process.stdout.write(`${JSON.stringify(result)}\n`);

if (!valid && !allowMissing) {
  process.exitCode = 2;
} else if (Number.isInteger(requestedExitCode) && requestedExitCode >= 0) {
  process.exitCode = requestedExitCode;
}
