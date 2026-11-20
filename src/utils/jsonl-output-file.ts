/** Closed output segments keep the date suffix understood by metrics/retention. */
export function parseOutputSegment(file: string): { stream: string; date: string } | undefined {
  const match = /^(.+)\.part-([0-9a-f]{32})-(\d{4}-\d{2}-\d{2}|all)\.jsonl$/.exec(file);
  if (!match) return undefined;
  return { stream: match[1], date: match[3] };
}
