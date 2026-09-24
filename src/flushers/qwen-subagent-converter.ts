// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import {
  convertEventLogToTrace,
  type ExtendedTelemetryHandler,
  type EventLogRecord,
} from '@loongsuite/otel-util-genai';
import { SpanStatusCode, type Context } from '@opentelemetry/api';

type Options = NonNullable<Parameters<typeof convertEventLogToTrace>[1]>;
type Result = ReturnType<typeof convertEventLogToTrace>;

/**
 * The shared converter currently expands only one child level. Reuse its
 * normal per-agent message/token/step conversion recursively, suppressing only
 * the virtual child ENTRY and parenting its AGENT to the real invoking TOOL.
 * Scope is restored on invocations; input records are never mutated. Other
 * agents keep the shared converter's existing behavior.
 */
export function convertQwenSubagents(records: EventLogRecord[], options: Options & { handler: ExtendedTelemetryHandler }): Result {
  const roots: EventLogRecord[] = [];
  const groups = new Map<string, EventLogRecord[]>();
  for (const r of records) {
    if (r['gen_ai.agent.scope'] !== 'subagent') { roots.push(r); continue; }
    const id = String(r['gen_ai.agent.id'] ?? '');
    const group = groups.get(id) ?? [];
    group.push(r);
    groups.set(id, group);
  }
  if (!groups.size) return convertEventLogToTrace(records, options);
  const handler = options.handler;
  const result: Result = { traceIds: [], spanCount: 0, warnings: [] };
  const used = new Set<string>();
  const byParent = new Map<string, string[]>();
  for (const [id, group] of groups) {
    const key = JSON.stringify([group[0]['gen_ai.agent.parent.id'], group[0]['gen_ai.subagent.parent_tool_call.id']]);
    const ids = byParent.get(key) ?? [];
    ids.push(id);
    byParent.set(key, ids);
  }

  function convert(group: EventLogRecord[], parent?: Context, depth = 0) {
    const first = group[0];
    if (!first) return;
    const id = String(first['gen_ai.agent.id'] ?? '');
    const child = parent !== undefined;
    const overrides: Partial<ExtendedTelemetryHandler> = {
      ...(child ? {
        startEntry: (inv) => { inv.contextToken = parent; return inv; },
        stopEntry: (inv) => inv,
      } as Pick<ExtendedTelemetryHandler, 'startEntry' | 'stopEntry'> : {}),
      stopInvokeAgent: (inv, endTime) => {
        if (first['agent.qwen-code-cli.subagent.status'] === 'failed') {
          inv.span?.setStatus({ code: SpanStatusCode.ERROR });
          inv.span?.setAttribute('error.type', 'SubagentFailed');
        }
        return handler.stopInvokeAgent(inv, endTime);
      },
      stopExecuteTool: (inv, endTime) => {
        const children = byParent.get(JSON.stringify([id, inv.toolCallId])) ?? [];
        if (children.length === 1 && depth < 100 && !used.has(children[0]) && inv.contextToken) {
          used.add(children[0]);
          convert(groups.get(children[0])!, inv.contextToken, depth + 1);
        } else if (children.length) {
          result.warnings.push('Qwen child has an ambiguous or cyclic parent tool relation');
        }
        // Foreground source timestamps already lie within this tool interval.
        // Never stretch the tool into an asynchronous task lifetime.
        return handler.stopExecuteTool(inv, endTime);
      },
    };
    const wrapped = new Proxy(handler, {
      get(target, key) {
        const override = overrides[key as keyof ExtendedTelemetryHandler];
        if (override) return override;
        const value = Reflect.get(target, key);
        if (typeof value !== 'function') return value;
        if (child && String(key).startsWith('start')) {
          return (inv: { passthroughAttributes?: Record<string, unknown> }, ...args: unknown[]) => {
            inv.passthroughAttributes = { ...inv.passthroughAttributes, 'gen_ai.agent.scope': 'subagent' };
            return value.call(target, inv, ...args);
          };
        }
        return value.bind(target);
      },
    });
    const local = group.map(r => {
      const copy = { ...r };
      delete copy['gen_ai.agent.scope'];
      return copy;
    });
    const converted = convertEventLogToTrace(local, { ...options, handler: wrapped });
    result.spanCount += converted.spanCount - (child ? 1 : 0); // virtual child ENTRY
    result.warnings.push(...converted.warnings);
    result.traceIds.push(...converted.traceIds);
  }
  convert(roots);
  if (used.size !== groups.size) result.warnings.push('Qwen child records without a matching parent tool were not converted');
  result.traceIds = [...new Set(result.traceIds)];
  return result;
}
