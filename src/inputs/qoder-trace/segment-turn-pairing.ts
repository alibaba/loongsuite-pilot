import type { AgentActivityEntry } from '../../types/index.js';
import type { SegmentTokenData } from './segment-token-reader.js';

// Group segments by their segment turn_id, then sort groups by min responseEndTs
// asc. Used to pair segment turns with OTLP turns by timestamp overlap since
// seg.turn_id and OTLP gen_ai.turn.id come from different sources and do not
// match directly.
export function groupSegmentsByTurn(segments: SegmentTokenData[]): SegmentTokenData[][] {
  const groupsByTurn = new Map<string, SegmentTokenData[]>();
  for (const seg of segments) {
    const tid = seg.turnId || '';
    const list = groupsByTurn.get(tid) ?? [];
    list.push(seg);
    groupsByTurn.set(tid, list);
  }
  return [...groupsByTurn.values()].sort((a, b) => {
    const aMin = a.reduce((m, s) => Math.min(m, s.responseEndTs || s.requestStartTs || Infinity), Infinity);
    const bMin = b.reduce((m, s) => Math.min(m, s.responseEndTs || s.requestStartTs || Infinity), Infinity);
    return aMin - bMin;
  });
}

// Pick the segment group whose [min requestStartTs, max responseEndTs] range
// overlaps with the OTLP turn's [min, max time_unix_nano] range. Stateless —
// safe under incremental collection (one new turn per collect() call) where a
// stateful sequential index would reset and always pick segGroups[0] = T1's
// segments. Picked group is spliced out of segGroups so subsequent turns in the
// same collect() call don't re-pick it.
export function pickSegGroupByTimeOverlap(
  segGroups: SegmentTokenData[][],
  turnEntries: AgentActivityEntry[],
): SegmentTokenData[] {
  if (segGroups.length === 0) return [];
  if (segGroups.length === 1) {
    const picked = segGroups[0];
    segGroups.length = 0;
    return picked;
  }

  let minNanos: bigint | undefined;
  let maxNanos: bigint | undefined;
  for (const e of turnEntries) {
    const ts = e.time_unix_nano;
    if (typeof ts !== 'string' || ts.length === 0) continue;
    let v: bigint;
    try { v = BigInt(ts); } catch { continue; }
    if (minNanos === undefined || v < minNanos) minNanos = v;
    if (maxNanos === undefined || v > maxNanos) maxNanos = v;
  }

  if (minNanos === undefined || maxNanos === undefined) {
    const picked = segGroups[0];
    segGroups.shift();
    return picked;
  }

  const otlpMinMs = Number(minNanos / 1_000_000n);
  const otlpMaxMs = Number(maxNanos / 1_000_000n);

  let bestIdx = -1;
  let bestOverlap = -1;
  for (let i = 0; i < segGroups.length; i++) {
    const grp = segGroups[i];
    let grpMinMs = Infinity;
    let grpMaxMs = 0;
    for (const s of grp) {
      const start = s.requestStartTs || s.responseEndTs;
      const end = s.responseEndTs || s.requestStartTs;
      if (start < grpMinMs) grpMinMs = start;
      if (end > grpMaxMs) grpMaxMs = end;
    }
    const overlapMs = Math.max(0, Math.min(otlpMaxMs, grpMaxMs) - Math.max(otlpMinMs, grpMinMs));
    if (overlapMs > bestOverlap) {
      bestOverlap = overlapMs;
      bestIdx = i;
    }
  }

  if (bestIdx < 0 || bestOverlap === 0) {
    const otlpMidMs = (otlpMinMs + otlpMaxMs) / 2;
    let bestDist = Infinity;
    for (let i = 0; i < segGroups.length; i++) {
      const grp = segGroups[i];
      let grpMinMs = Infinity;
      let grpMaxMs = 0;
      for (const s of grp) {
        const start = s.requestStartTs || s.responseEndTs;
        const end = s.responseEndTs || s.requestStartTs;
        if (start < grpMinMs) grpMinMs = start;
        if (end > grpMaxMs) grpMaxMs = end;
      }
      const grpMidMs = (grpMinMs + grpMaxMs) / 2;
      const dist = Math.abs(grpMidMs - otlpMidMs);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
  }

  const picked = segGroups[bestIdx];
  segGroups.splice(bestIdx, 1);
  return picked;
}
