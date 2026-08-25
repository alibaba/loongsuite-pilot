// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * trae-agent trajectory -> GenAI activity entry converter.
 *
 * Emits a flat list of AgentActivityEntry records that the OTLP trace flusher
 * (`@loongsuite/otel-util-genai` event-log converter) assembles into a
 * 5-layer span tree:
 *
 *   ENTRY (synthesized by the converter library)
 *    └── AGENT (synthesized)
 *         └── STEP (one per gen_ai.step.id, synthesized from LLM/TOOL records)
 *              ├── LLM (one per llm.request + llm.response pair)
 *              └── TOOL (one per tool.call + tool.result pair)
 *
 * The converter does NOT emit SESSION/STEP 'other' marker events. Those are
 * synthesized by the OTLP converter library from the LLM/TOOL records'
 * gen_ai.session.id / gen_ai.step.id / gen_ai.agent.type fields. Emitting
 * a separate 'other' marker creates a phantom turn-keyed buffer that the
 * converter library turns into a duplicate bare ENTRY/AGENT pair (P1-3/8).
 *
 * Span IDs are deterministic hashes of (sessionId, stepNumber, spanKind) so
 * that re-emitting the same step across polling cycles yields the same IDs
 * (downstream dedup relies on this).
 *
 * Authority rules (architect P0/P1):
 *   - usage tokens come from `llm_interactions[i].response.usage` (full
 *     cache_creation/cache_read/reasoning_tokens breakdown). The
 *     `agent_steps[i].llm_response.usage` short form is NOT consulted.
 *   - tool_calls are read from `llm_interactions[i].response.tool_calls`,
 *     not from the interaction's top level.
 *   - output.messages tool parts use `type: 'tool_call'` (NOT `tool_use`)
 *     and `type: 'tool_call_response'` for results — the validate-trace
 *     rule set recognizes only those part types.
 *   - llm.request and llm.response get distinct timestamps (request at the
 *     interaction's timestamp, response at the NEXT step's timestamp — or
 *     trajectory.end_time for the last step) so LLM spans have non-zero
 *     duration. The same scheme applies to tool.call / tool.result.
 *   - On the LAST step's llm.response, 'stop' is appended to
 *     finish_reasons so the OTLP flusher's Signal A terminal-event check
 *     fires and the turn closes without waiting for shutdown.
 */

import crypto from 'node:crypto';
import { parseTrajectory } from './trajectory-parser.mjs';

const AGENT_TYPE = 'trae-agent';
const PROVIDER_FALLBACK = 'anthropic';
const ROOT_PARENT_SPAN_ID = '0000000000000000';

/**
 * @typedef {import('./trajectory-parser.mjs').TrajectoryJson} TrajectoryJson
 */

/**
 * Convert a trajectory JSON object into a flat, time-sorted list of
 * AgentActivityEntry records. The caller passes a Set of already-emitted
 * step numbers; steps in that set are skipped.
 *
 * @param {TrajectoryJson} json
 * @param {{ seenStepNumbers?: Set<number>, sessionReset?: boolean }} [opts]
 * @returns {{ entries: Array<Record<string, unknown>>, emittedStepNumbers: number[] }}
 */
export function convertTrajectory(json, opts = {}) {
  const seen = opts.seenStepNumbers ?? new Set();
  const sessionReset = Boolean(opts.sessionReset);
  const parsed = parseTrajectory(json);

  const sessionId = deriveSessionId(parsed);
  const traceId = hashId([sessionId, 'trace'], 32);

  /** @type {Array<Record<string, unknown>>} */
  const entries = [];
  /** @type {number[]} */
  const emittedStepNumbers = [];

  const stepCount = parsed.steps.length;
  const lastStepIndex = stepCount - 1;
  for (let i = 0; i < stepCount; i++) {
    const step = parsed.steps[i];
    if (!step.stepNumber || seen.has(step.stepNumber)) continue;
    const interaction = parsed.interactions[i] ?? null;
    const isLastStep = i === lastStepIndex;
    // The "end" timestamp for LLM/TOOL spans of this step is the next
    // interaction's timestamp (start of the next LLM call). This is strictly
    // <= the next STEP's start time (because trae-agent stamps step[i+1]
    // ~0.5ms AFTER interaction[i+1]), so adjacent STEP spans do not overlap.
    // For the last step, fall back to trajectory.end_time.
    const nextInteractionTs = !isLastStep && parsed.interactions[i + 1]?.timestamp
      ? parsed.interactions[i + 1].timestamp
      : (parsed.endTime || step.timestamp);
    const stepEndTime = nextInteractionTs;

    const stepSpanId = hashId([sessionId, 'step', String(step.stepNumber)], 16);
    const llmSpanId = hashId([sessionId, 'llm', String(step.stepNumber)], 16);
    const stepId = `${sessionId}:s${step.stepNumber}`;
    const turnId = sessionId; // single-turn trajectory
    const commonBase = {
      trace_id: traceId,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': stepId,
      'gen_ai.agent.type': AGENT_TYPE,
      'gen_ai.agent.id': sessionId,
      'gen_ai.provider.name': interaction?.provider || parsed.provider || PROVIDER_FALLBACK,
      ...(sessionReset ? { 'agent.trajectory.session_reset': true } : {}),
    };

    if (interaction) {
      const requestTime = interaction.timestamp || step.timestamp;
      const responseTime = stepEndTime;
      // ── LLM_CALL request ──
      entries.push({
        time_unix_nano: timestampToUnixNanos(requestTime),
        observed_time_unix_nano: timestampToUnixNanos(responseTime),
        'event.id': hashId([sessionId, 'llm', String(step.stepNumber), 'request'], 32),
        'user.id': '',
        'event.name': 'llm.request',
        ...commonBase,
        span_id: llmSpanId,
        parent_span_id: stepSpanId,
        'gen_ai.request.model': interaction.model || parsed.model,
        'gen_ai.response.id': `${sessionId}:r${step.stepNumber}`,
        ...(interaction.inputMessages.length > 0
          ? { 'gen_ai.input.messages': interaction.inputMessages }
          : {}),
      });

      // ── LLM_CALL response ── usage authority = interaction.response.usage
      const usage = interaction.response.usage;
      const outputMessages = buildOutputMessages(interaction, isLastStep);
      // On the last step, append 'stop' to finish_reasons so Signal A fires
      // and the turn flushes at the boundary instead of waiting for shutdown.
      const finishReasons = buildFinishReasons(interaction.response.finishReason, isLastStep);
      entries.push({
        time_unix_nano: timestampToUnixNanos(responseTime),
        observed_time_unix_nano: timestampToUnixNanos(responseTime),
        'event.id': hashId([sessionId, 'llm', String(step.stepNumber), 'response'], 32),
        'user.id': '',
        'event.name': 'llm.response',
        ...commonBase,
        span_id: llmSpanId,
        parent_span_id: stepSpanId,
        'gen_ai.request.model': interaction.model || parsed.model,
        'gen_ai.response.model': interaction.response.model || interaction.model || parsed.model,
        'gen_ai.response.id': `${sessionId}:r${step.stepNumber}`,
        'gen_ai.response.finish_reasons': finishReasons,
        ...(outputMessages.length > 0 ? { 'gen_ai.output.messages': outputMessages } : {}),
        ...(usage
          ? {
              'gen_ai.usage.input_tokens': usage.inputTokens,
              'gen_ai.usage.output_tokens': usage.outputTokens,
              'gen_ai.usage.cache_read.input_tokens': usage.cacheReadInputTokens,
              'gen_ai.usage.cache_creation.input_tokens': usage.cacheCreationInputTokens,
            }
          : {}),
      });
    }

    // ── TOOL spans (one call+result pair per tool_calls[i]) ──
    // tool_results[i] is matched to tool_calls[i] by call_id; missing result
    // => emit tool.call only (status pending).
    for (let t = 0; t < step.toolCalls.length; t++) {
      const call = step.toolCalls[t];
      const result = step.toolResults.find(r => r.callId && r.callId === call.callId) ?? null;
      const toolSpanId = hashId([sessionId, 'tool', String(step.stepNumber), String(t), call.callId || ''], 16);
      const toolBase = {
        trace_id: traceId,
        'gen_ai.session.id': sessionId,
        'gen_ai.turn.id': turnId,
        'gen_ai.step.id': stepId,
        'gen_ai.agent.type': AGENT_TYPE,
        'gen_ai.agent.id': sessionId,
        'gen_ai.provider.name': interaction?.provider || parsed.provider || PROVIDER_FALLBACK,
        ...(sessionReset ? { 'agent.trajectory.session_reset': true } : {}),
      };

      entries.push({
        time_unix_nano: timestampToUnixNanos(step.timestamp),
        observed_time_unix_nano: timestampToUnixNanos(stepEndTime),
        'event.id': hashId([sessionId, 'tool', String(step.stepNumber), String(t), 'call'], 32),
        'user.id': '',
        'event.name': 'tool.call',
        ...toolBase,
        span_id: toolSpanId,
        parent_span_id: stepSpanId,
        'gen_ai.tool.name': call.name,
        'gen_ai.tool.call.id': call.callId || undefined,
        'gen_ai.tool.call.arguments': call.arguments ?? undefined,
      });

      if (result) {
        entries.push({
          time_unix_nano: timestampToUnixNanos(stepEndTime),
          observed_time_unix_nano: timestampToUnixNanos(stepEndTime),
          'event.id': hashId([sessionId, 'tool', String(step.stepNumber), String(t), 'result'], 32),
          'user.id': '',
          'event.name': 'tool.result',
          ...toolBase,
          span_id: toolSpanId,
          parent_span_id: stepSpanId,
          'gen_ai.tool.name': call.name,
          'gen_ai.tool.call.id': call.callId || undefined,
          'gen_ai.tool.call.result': {
            role: 'tool',
            content: result.success ? serializeResult(result.result) : '',
            tool_call_id: call.callId || undefined,
            error: result.error || undefined,
            success: result.success,
          },
          'tool.result.status': result.success ? 'success' : 'failure',
        });
      }
    }

    emittedStepNumbers.push(step.stepNumber);
  }

  entries.sort((a, b) => {
    const an = BigInt(a.time_unix_nano);
    const bn = BigInt(b.time_unix_nano);
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  return { entries, emittedStepNumbers };
}

/**
 * Build the assistant output message list. The assistant message content is
 * whatever the LLM produced (text or thinking + tool_call parts). Tool-call
 * arguments come from interaction.response.tool_calls (architect P1: not
 * from the top-level field).
 *
 * Part type is 'tool_call' (NOT 'tool_use') — the validate-trace rules only
 * recognize ['text','tool_call','tool_call_response','reasoning'].
 */
/**
 * Build the assistant output message list. The assistant message content is
 * whatever the LLM produced (text or thinking + tool_call parts). Tool-call
 * arguments come from interaction.response.tool_calls (architect P1: not
 * from the top-level field).
 *
 * Part type is 'tool_call' (NOT 'tool_use') — the validate-trace rules only
 * recognize ['text','tool_call','tool_call_response','reasoning'].
 *
 * On the last step, `task_done` tool_calls are stripped from output.messages:
 * trae-agent uses `task_done` as a control-flow terminal marker (no result,
 * no real tool execution), and the validate-trace `semantic.last_step_no_tool_call`
 * rule expects the final step's LLM output to be a plain-text answer without
 * tool_calls. The text answer is preserved as the terminal output.
 */
function buildOutputMessages(interaction, isLastStep = false) {
  const parts = [];
  const content = interaction.response.content;
  if (typeof content === 'string' && content.length > 0) {
    parts.push({ type: 'text', content });
  } else if (Array.isArray(content)) {
    for (const c of content) {
      if (c && typeof c === 'object' && typeof c.type === 'string') {
        parts.push(c);
      } else if (typeof c === 'string') {
        parts.push({ type: 'text', content: c });
      }
    }
  }
  for (const call of interaction.response.toolCalls) {
    if (isLastStep && call.name === 'task_done') continue;
    parts.push({
      type: 'tool_call',
      id: call.callId || call.id || undefined,
      name: call.name,
      content: call.arguments ?? null,
    });
  }
  if (parts.length === 0) return [];
  return [{ role: 'assistant', parts }];
}

/**
 * Build finish_reasons array. On the last step, append 'stop' to the actual
 * finish reason so the OTLP flusher's terminal-event check (Signal A) fires
 * and the turn closes at the boundary. trae-agent trajectories always end
 * with `finish_reason='tool_use'` (the final LLM call still produced a tool
 * call before `success=true` was reached), so without this marker the turn
 * only flushes at shutdown.
 */
function buildFinishReasons(actualFinishReason, isLastStep) {
  const reasons = [];
  if (actualFinishReason && actualFinishReason.length > 0) {
    reasons.push(actualFinishReason);
  }
  if (isLastStep && !reasons.includes('stop')) {
    reasons.push('stop');
  }
  return reasons;
}

function serializeResult(result) {
  if (result === null || result === undefined) return '';
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function deriveSessionId(parsed) {
  // Trajectory has no explicit session id; derive a stable one from the
  // start time + task hash so re-parsing the same trajectory yields the
  // same id (and the same span IDs).
  const seed = `${parsed.startTime}|${parsed.provider}|${parsed.task}`.slice(0, 256);
  return 'trae-' + hashId([seed], 24);
}

function hashId(parts, length) {
  const hash = crypto.createHash('sha256');
  for (const p of parts) hash.update(String(p ?? ''));
  return hash.digest('hex').slice(0, length);
}

function timestampToUnixNanos(ts) {
  if (!ts) return timestampToUnixNanos(Date.now());
  if (typeof ts === 'number') {
    if (!Number.isFinite(ts)) return timestampToUnixNanos(Date.now());
    if (ts >= 1e16) return String(Math.trunc(ts));
    if (ts >= 1e12) return `${Math.trunc(ts)}000000`;
    return `${Math.trunc(ts * 1000)}000000`;
  }
  const trimmed = String(ts).trim();
  if (/^\d{16,}$/.test(trimmed)) return trimmed;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) return timestampToUnixNanos(numeric);
  const parsed = Date.parse(trimmed);
  return timestampToUnixNanos(Number.isNaN(parsed) ? Date.now() : parsed);
}

// ── CLI entry: read trajectory file, emit JSONL ──
// Usage: node trajectory-converter.mjs <trajectory.json> [output.jsonl]
//   If no output path: writes to stdout.
//   Each line is a JSON object (AgentActivityEntry projection) — used by
//   the smoke test to verify the converter end-to-end with a real fixture.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath) {
    process.stderr.write('usage: trajectory-converter.mjs <trajectory.json> [output.jsonl]\n');
    process.exit(1);
  }
  try {
    const raw = await import('node:fs/promises').then(fs => fs.readFile(inputPath, 'utf8'));
    const json = JSON.parse(raw);
    const { entries } = convertTrajectory(json);
    const lines = entries.map(e => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : '');
    if (outputPath) {
      await import('node:fs/promises').then(fs => fs.writeFile(outputPath, lines));
      process.stderr.write(`wrote ${entries.length} entries to ${outputPath}\n`);
    } else {
      process.stdout.write(lines);
    }
  } catch (err) {
    process.stderr.write(`converter failed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  }
}
