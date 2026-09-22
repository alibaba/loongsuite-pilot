// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

// Minimal declaration for the .mjs transcript parser so TypeScript can import
// it without forcing `any` on the whole module. The runtime export is
// `parseTranscript(filePath: string): AgentActivityEntry[]`.
export declare function parseTranscript(
  filePath: string,
): import('../../src/types/events.js').AgentActivityEntry[];

export declare function hasSessionShutdown(filePath: string): boolean;
