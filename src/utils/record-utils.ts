export function flattenToStrings(obj: object): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    result[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
  return result;
}
