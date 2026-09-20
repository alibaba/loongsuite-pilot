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
 * Authority rules (architect P0/P1 + reviewer P1-2/4/5/6):
 *   - usage tokens come from `llm_interactions[i].response.usage` (full
 *     cache_creation/cache_read/reasoning_tokens breakdown). The
 *     `agent_steps[i].llm_response.usage` short form is NOT consulted.
 *     For Anthropic-style providers (including Anthropic-compatible proxies
 *     such as DashScope's Claude endpoint) the raw `input_tokens` EXCLUDES
 *     cached tokens, so the standard `gen_ai.usage.input_tokens` is the SUM
 *     of non-cached input + cache_read + cache_creation (the schema requires
 *     the two cache fields to be SUBSETS of input_tokens). Providers whose
 *     input_tokens already includes cache are left untouched. (P1-5)
 *   - tool_calls are read from `llm_interactions[i].response.tool_calls`,
 *     not from the interaction's top level.
 *   - output.messages tool parts use `type: 'tool_call'` (NOT `tool_use`)
 *     and `type: 'tool_call_response'` for results — the validate-trace
 *     rule set recognizes only those part types. The final step's real
 *     `task_done` control tool_call is preserved verbatim (with its
 *     arguments); the converter never fabricates assistant text the model
 *     did not produce. (P1-6)
 *   - Timestamps: trae-agent records COMPLETION times only —
 *     `llm_interactions[i].timestamp` is when LLM response i finished and
 *     `agent_steps[i].timestamp` is when step i finished (after its tools
 *     ran). There is no request-start or tool-start field, so spans use the
 *     nearest verifiable boundaries instead of borrowing the NEXT response's
 *     time (which misattributed tool + next-call latency to the current
 *     span): LLM span i = [previous step completion (or trajectory
 *     start_time) → interaction[i].timestamp]; TOOL span i =
 *     [interaction[i].timestamp → step[i].timestamp]. (P1-4)
 *   - Turn boundary: the finalized last step's llm.response carries
 *     `gen_ai.turn.end=true`, which is the SOLE authoritative boundary for
 *     trae-agent (the OTLP flusher keys off it, NOT finish_reason). The
 *     converter no longer appends a synthetic 'stop'. Because trae-agent
 *     saves the last agent_step BEFORE finalize_recording writes end_time,
 *     a poll can observe the last step while the run is still in progress;
 *     the cycle that first sees end_time then re-emits that step's
 *     llm.response ONCE with turn.end so the buffered turn still closes
 *     (deterministic event.id/span_id make the re-emission idempotent
 *     downstream). (P1-2)
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
 * @param {{
 *   seenStepNumbers?: Set<number>,
 *   sessionReset?: boolean,
 *   runCompletionEmitted?: boolean,
 * }} [opts] `runCompletionEmitted` is true when a prior polling cycle already
 *   emitted the finalize (turn.end) terminal for this run's last step, so the
 *   P1-2 completion marker is not re-emitted on every subsequent poll.
 * @returns {{
 *   entries: Array<Record<string, unknown>>,
 *   emittedStepNumbers: number[],
 *   runCompletionEmitted: boolean,
 * }}
 */
export function convertTrajectory(json, opts = {}) {
  const seen = opts.seenStepNumbers ?? new Set();
  const sessionReset = Boolean(opts.sessionReset);
  const runCompletionEmitted = Boolean(opts.runCompletionEmitted);
  const parsed = parseTrajectory(json);

  const sessionId = deriveSessionId(parsed);
  const traceId = hashId([sessionId, 'trace'], 32);

  /** @type {Array<Record<string, unknown>>} */
  const entries = [];
  /** @type {number[]} */
  const emittedStepNumbers = [];

  const stepCount = parsed.steps.length;
  const lastStepIndex = stepCount - 1;
  // A trajectory is only "complete" once trae-agent finalizes it (writes
  // end_time via finalize_recording). While the run is still in progress the
  // recorder rewrites the whole file after EVERY llm interaction / agent step
  // (record_llm_interaction / record_agent_step both call save_trajectory), so
  // the poller routinely observes partial trajectories whose current tail step
  // is NOT the real last step.
  const runComplete = Boolean(parsed.endTime);
  let firstEmittedLlmRequest = true;
  let emittedTurnEnd = false;

  /**
   * Build the llm.response record for a step. Shared by the main loop and the
   * P1-2 finalize-only completion marker so both produce deterministically-IDed
   * records that collapse onto the same span downstream.
   *
   * `markerOnly` builds the P1-2 turn-end signal: it carries gen_ai.turn.end but
   * OMITS gen_ai.output.messages. The downstream converter
   * (mergeResponsesByResponseId) collapses records sharing gen_ai.response.id by
   * CONCATENATING their output.messages parts, so a marker that repeated the last
   * step's payload would double it (text + task_done emitted twice) on the merged
   * span. The already-buffered record from the poll that first saw the last step
   * carries the real payload; the marker only needs to close the turn.
   */
  const buildLlmResponse = ({ step, interaction, stepSpanId, llmSpanId, stepId, turnId, providerName, llmEndNano, isLastStep, markerOnly }) => {
    const usage = normalizeUsageTokens(interaction.response.usage, providerName);
    const outputMessages = markerOnly ? [] : buildOutputMessages(interaction);
    const finishReasons = buildFinishReasons(interaction.response.finishReason);
    return {
      time_unix_nano: String(llmEndNano),
      observed_time_unix_nano: String(llmEndNano),
      'event.id': hashId([sessionId, 'llm', String(step.stepNumber), 'response'], 32),
      'user.id': '',
      'event.name': 'llm.response',
      trace_id: traceId,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': stepId,
      'gen_ai.agent.type': AGENT_TYPE,
      'gen_ai.agent.id': sessionId,
      'gen_ai.provider.name': providerName,
      ...(sessionReset ? { 'agent.trajectory.session_reset': true } : {}),
      span_id: llmSpanId,
      parent_span_id: stepSpanId,
      'gen_ai.request.model': interaction.model || parsed.model,
      'gen_ai.response.model': interaction.response.model || interaction.model || parsed.model,
      'gen_ai.response.id': `${sessionId}:r${step.stepNumber}`,
      'gen_ai.response.finish_reasons': finishReasons,
      // Explicit turn-end marker, stamped ONLY on the finalized last step. The
      // OTLP flusher (isTerminalEvent) and turn-boundary enrichment both key off
      // this marker for trae-agent instead of finish_reason: an intermediate
      // step can carry a natural 'stop' (the model returned plain text mid-run)
      // while trae-agent keeps going to a later task_done step. (P1-2)
      ...(isLastStep ? { 'gen_ai.turn.end': true } : {}),
      ...(outputMessages.length > 0 ? { 'gen_ai.output.messages': outputMessages } : {}),
      ...(usage
        ? {
            'gen_ai.usage.input_tokens': usage.inputTokens,
            'gen_ai.usage.output_tokens': usage.outputTokens,
            'gen_ai.usage.cache_read.input_tokens': usage.cacheReadInputTokens,
            'gen_ai.usage.cache_creation.input_tokens': usage.cacheCreationInputTokens,
          }
        : {}),
    };
  };

  for (let i = 0; i < stepCount; i++) {
    const step = parsed.steps[i];
    if (!step.stepNumber || seen.has(step.stepNumber)) continue;
    const interaction = parsed.interactions[i] ?? null;
    // Only treat the tail step as "last" (stamp turn.end, close spans) once the
    // run is finalized. During incremental polling the tail is provisional:
    // marking it terminal makes the OTLP flusher close the turn immediately and
    // drop the later steps that share the same turn.id (they then arrive as
    // "late entries" for an already-flushed turn and are discarded), so ARMS
    // would only ever receive the first step of a multi-step ReAct run.
    const isLastStep = runComplete && i === lastStepIndex;
    const providerName = interaction?.provider || parsed.provider || PROVIDER_FALLBACK;

    // ── Timestamp model (P1-4) ──
    // trae-agent records COMPLETION times only: interaction[i].timestamp is when
    // LLM response i finished; step[i].timestamp is when step i finished (after
    // its tools ran). Use the nearest verifiable boundaries rather than the NEXT
    // response's time:
    //   LLM span i  = [previous step completion (or start_time) → interaction[i].ts]
    //   TOOL span i = [interaction[i].ts (LLM done, tools begin) → step[i].ts]
    const llmEndTime = interaction?.timestamp || step.timestamp;
    const llmEndNano = nanoOf(llmEndTime);
    const prevBoundary = i > 0 ? (parsed.steps[i - 1]?.timestamp || '') : parsed.startTime;
    const llmStartNano = lowerBoundNano(prevBoundary, llmEndNano);
    const toolStartNano = llmEndNano;
    const toolEndNano = upperBoundNano(step.timestamp, toolStartNano);

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
      'gen_ai.provider.name': providerName,
      ...(sessionReset ? { 'agent.trajectory.session_reset': true } : {}),
    };

    if (interaction) {
      // ── LLM_CALL request ──
      // On the first emitted LLM request of the turn, also populate
      // gen_ai.input.messages_delta with the initial prompt. The OTLP converter
      // library reads _delta from the first llm.request to build ENTRY/AGENT
      // input.messages (it does NOT read the full gen_ai.input.messages field
      // for ENTRY/AGENT). Without _delta, those synthesized spans carry no
      // input.messages and fail the data-quality checks.
      const isFirstEmitted = firstEmittedLlmRequest;
      firstEmittedLlmRequest = false;
      entries.push({
        time_unix_nano: String(llmStartNano),
        observed_time_unix_nano: String(llmEndNano),
        'event.id': hashId([sessionId, 'llm', String(step.stepNumber), 'request'], 32),
        'user.id': '',
        'event.name': 'llm.request',
        ...commonBase,
        span_id: llmSpanId,
        parent_span_id: stepSpanId,
        'gen_ai.request.model': interaction.model || parsed.model,
        'gen_ai.response.id': `${sessionId}:r${step.stepNumber}`,
        ...(interaction.inputMessages.length > 0
          ? {
              'gen_ai.input.messages': interaction.inputMessages,
              ...(isFirstEmitted
                ? { 'gen_ai.input.messages_delta': interaction.inputMessages }
                : {}),
            }
          : {}),
      });

      // ── LLM_CALL response ── usage authority = interaction.response.usage
      entries.push(buildLlmResponse({
        step, interaction, stepSpanId, llmSpanId, stepId, turnId, providerName, llmEndNano, isLastStep,
      }));
      if (isLastStep) emittedTurnEnd = true;
    }

    // ── TOOL spans (one call+result pair per tool_calls[i]) ──
    // tool_results[i] is matched to tool_calls[i] by call_id; missing result
    // => emit tool.call only (status pending).
    for (let t = 0; t < step.toolCalls.length; t++) {
      const call = step.toolCalls[t];
      const result = step.toolResults.find(r => r.callId && r.callId === call.callId) ?? null;
      const toolSpanId = hashId([sessionId, 'tool', String(step.stepNumber), String(t), call.callId || ''], 16);
      const toolBase = { ...commonBase };

      entries.push({
        time_unix_nano: String(toolStartNano),
        observed_time_unix_nano: String(toolEndNano),
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
          time_unix_nano: String(toolEndNano),
          observed_time_unix_nano: String(toolEndNano),
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

  // ── P1-2: finalize-only completion marker ──
  // trae-agent saves the last agent_step BEFORE finalize_recording writes
  // end_time. A poll that observed the last step while the run was still in
  // progress emitted it WITHOUT turn.end and recorded it as seen. On the poll
  // that first sees end_time every step is skipped, so the turn would never
  // close. Re-emit the finalized last step's llm.response ONCE as a turn-end
  // SIGNAL: its deterministic event.id/span_id/response.id collapse onto the
  // already-buffered record downstream, and the flusher only needs turn.end to
  // close the turn. markerOnly omits output.messages so that collapse does not
  // double the last step's payload (see buildLlmResponse).
  if (runComplete && !emittedTurnEnd && !runCompletionEmitted && lastStepIndex >= 0) {
    const lastStep = parsed.steps[lastStepIndex];
    const lastInteraction = parsed.interactions[lastStepIndex] ?? null;
    if (lastStep?.stepNumber && lastInteraction && seen.has(lastStep.stepNumber)) {
      const providerName = lastInteraction.provider || parsed.provider || PROVIDER_FALLBACK;
      const llmEndNano = nanoOf(lastInteraction.timestamp || lastStep.timestamp);
      entries.push(buildLlmResponse({
        step: lastStep,
        interaction: lastInteraction,
        stepSpanId: hashId([sessionId, 'step', String(lastStep.stepNumber)], 16),
        llmSpanId: hashId([sessionId, 'llm', String(lastStep.stepNumber)], 16),
        stepId: `${sessionId}:s${lastStep.stepNumber}`,
        turnId: sessionId,
        providerName,
        llmEndNano,
        isLastStep: true,
        markerOnly: true,
      }));
      emittedTurnEnd = true;
    }
  }

  entries.sort((a, b) => {
    const an = BigInt(a.time_unix_nano);
    const bn = BigInt(b.time_unix_nano);
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  return { entries, emittedStepNumbers, runCompletionEmitted: emittedTurnEnd || runCompletionEmitted };
}

/**
 * Build the assistant output message list. The assistant message content is
 * whatever the LLM produced (text and/or tool_call parts). Tool-call arguments
 * come from interaction.response.tool_calls (architect P1: not from the
 * top-level field).
 *
 * Part type is 'tool_call' (NOT 'tool_use') — the validate-trace rules only
 * recognize ['text','tool_call','tool_call_response','reasoning'].
 *
 * P1-6: the final step's real `task_done` control tool_call is preserved
 * verbatim (name + arguments). The converter NEVER strips it and NEVER
 * fabricates assistant text the model did not produce — the turn boundary is
 * carried by `gen_ai.turn.end` on the record, not by reshaping the model
 * output. When the model returned only a task_done call (empty text), the
 * output is exactly that tool_call part; no placeholder is invented.
 */
function buildOutputMessages(interaction) {
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
 * Build finish_reasons array from the model's ACTUAL finish reason only.
 * P1-6: no synthetic 'stop' is appended — trae-agent's turn boundary is the
 * explicit `gen_ai.turn.end` marker (the OTLP flusher's trae-agent branch keys
 * off it, not finish_reason), so inventing a 'stop' the model never returned
 * would falsify the response metadata for no benefit.
 */
function buildFinishReasons(actualFinishReason) {
  const reasons = [];
  if (actualFinishReason && actualFinishReason.length > 0) {
    reasons.push(actualFinishReason);
  }
  return reasons;
}

/**
 * P1-5: normalize token usage per provider semantics. Anthropic (and
 * Anthropic-compatible proxies such as DashScope's Claude endpoint) report
 * `input_tokens` EXCLUDING cached tokens, listing `cache_read_input_tokens` and
 * `cache_creation_input_tokens` separately. The GenAI schema requires those two
 * to be SUBSETS of `gen_ai.usage.input_tokens`, so for Anthropic-style providers
 * the standard input total is the SUM of all three. Providers whose input_tokens
 * already includes cache (e.g. OpenAI) are returned untouched to avoid double
 * counting. Returns undefined when the interaction carried no usage.
 */
function normalizeUsageTokens(usage, providerName) {
  if (!usage) return undefined;
  const rawInput = usage.inputTokens || 0;
  const cacheRead = usage.cacheReadInputTokens || 0;
  const cacheCreation = usage.cacheCreationInputTokens || 0;
  const p = String(providerName || '').toLowerCase();
  const anthropicStyle = p.includes('anthropic') || p.includes('claude');
  const inputTokens = anthropicStyle ? rawInput + cacheRead + cacheCreation : rawInput;
  return { ...usage, inputTokens };
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

/** BigInt nanos for a raw timestamp (mirrors timestampToUnixNanos). */
function nanoOf(ts) {
  return BigInt(timestampToUnixNanos(ts));
}

/**
 * P1-4 guard: a span START derived from an earlier boundary. If the boundary is
 * missing or not strictly before `endNano` (clock skew / same-millisecond
 * stamps), clamp to endNano-1 so the span keeps a positive, non-zero duration
 * without borrowing a later event's time.
 */
function lowerBoundNano(boundaryTs, endNano) {
  if (!boundaryTs) return endNano > 0n ? endNano - 1n : 0n;
  const startNano = nanoOf(boundaryTs);
  if (startNano <= 0n || startNano >= endNano) return endNano > 0n ? endNano - 1n : 0n;
  return startNano;
}

/**
 * P1-4 guard: a span END derived from a later boundary. If the boundary is
 * missing or not strictly after `startNano`, clamp to startNano+1 so tool
 * spans keep a positive duration.
 */
function upperBoundNano(boundaryTs, startNano) {
  if (!boundaryTs) return startNano + 1n;
  const endNano = nanoOf(boundaryTs);
  if (endNano <= startNano) return startNano + 1n;
  return endNano;
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
