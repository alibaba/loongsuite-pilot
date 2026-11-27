#!/usr/bin/env node
// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

// CodeBuddy hook event writer — the legacy CodeBuddy client (pre-rename, e.g.
// CodeBuddy CN / genie) shares WorkBuddy's hook contract (same events, same
// stdin payload shape), but stores transcripts under its own globalStorage
// layout instead of ~/.workbuddy/projects. So we only record the hook wakeup
// hint (session/tool boundary metadata) under state/codebuddy/hook-events;
// message content is out of scope for this input.
//
// Reuses workbuddy-hook-event-writer.mjs via LOONGSUITE_HOOK_STATE_DIR so the
// record schema stays byte-identical; only the output directory differs.

process.env.LOONGSUITE_HOOK_STATE_DIR = 'codebuddy';
await import('./workbuddy-hook-event-writer.mjs');
