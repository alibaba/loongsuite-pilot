import { readFile } from 'node:fs/promises';
import type { MulticaInputConfig } from './types.js';

export class SourceError extends Error {
  constructor(readonly kind: string) { super(kind); }
}

export function errorKind(error: unknown): string {
  if (error instanceof SourceError) return error.kind;
  const err = error as {name?: string; code?: string; status?: number};
  if (err.status) return `sls_http_${err.status}`;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return 'timeout';
  if (err.code && /^[A-Z_]+$/.test(err.code)) return err.code;
  return 'collection_error';
}

export async function fetchBounded(url: string, input: MulticaInputConfig, workspace?: string, profileToken?: string): Promise<{text: string; headers: Headers}> {
  const headers: Record<string, string> = {Accept: 'application/json, text/plain'};
  if (workspace !== undefined || profileToken !== undefined) {
    const token = profileToken ?? (input.TokenFile ? (await readFile(input.TokenFile, 'utf8')).trim() : process.env[input.TokenEnv ?? 'MULTICA_TOKEN']?.trim());
    if (!token) throw new SourceError('missing_api_token');
    headers.Authorization = `Bearer ${token}`;
    if (workspace !== undefined) headers['X-Workspace-ID'] = workspace;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.TimeoutMs ?? 10000);
  try {
    const response = await fetch(url, {headers, signal: controller.signal, redirect: 'manual'});
    if (!response.ok) { await response.body?.cancel(); throw new SourceError(`http_${response.status}`); }
    const maxBytes = input.MaxResponseBytes ?? 4 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel(); throw new SourceError('response_too_large');
    }
    const reader = response.body?.getReader();
    if (!reader) return {text: '', headers: response.headers};
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maxBytes) throw new SourceError('response_too_large');
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel(); }
    return {text: Buffer.concat(chunks).toString('utf8'), headers: response.headers};
  } finally { clearTimeout(timer); }
}
