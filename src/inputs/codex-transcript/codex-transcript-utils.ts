export function timestampMs(record: Record<string, unknown>, fallback: number): number {
  const value = stringValue(record.timestamp);
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
