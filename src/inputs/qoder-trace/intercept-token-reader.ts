import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { resolveHome } from '../../utils/fs-utils.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('InterceptTokenReader');

const MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const CACHE_TTL_MS = 30_000;

export interface InterceptTokenData {
  id: string;
  ts: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface InterceptSystemPrompt {
  ts: number;
  content: string;
}

export interface InterceptData {
  tokens: InterceptTokenData[];
  systemPrompt: InterceptSystemPrompt | null;
}

let cache: { data: InterceptData; ts: number } | null = null;

function getInterceptFile(): string {
  return resolveHome('~/.loongsuite-pilot/logs/qodercli-intercept.jsonl');
}

export async function readInterceptData(sinceTs?: number): Promise<InterceptData> {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) {
    return cache.data;
  }

  const filePath = getInterceptFile();
  const result: InterceptData = { tokens: [], systemPrompt: null };

  let content: string;
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_FILE_SIZE) {
      await fs.truncate(filePath, 0);
      logger.info('intercept file truncated (exceeded 10MB)');
      return result;
    }
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return result;
  }

  const cutoff = sinceTs ?? (Date.now() - MAX_AGE_MS);

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      const ts = record.ts as number;
      if (ts < cutoff) continue;

      if (record.type === 'token') {
        result.tokens.push({
          id: record.id as string,
          ts,
          promptTokens: (record.prompt_tokens as number) || 0,
          completionTokens: (record.completion_tokens as number) || 0,
          cachedTokens: (record.cached_tokens as number) || 0,
          reasoningTokens: (record.reasoning_tokens as number) || 0,
          totalTokens: (record.total_tokens as number) || 0,
        });
      } else if (record.type === 'system_prompt') {
        result.systemPrompt = {
          ts,
          content: record.content as string,
        };
      }
    } catch {
      continue;
    }
  }

  cache = { data: result, ts: Date.now() };
  return result;
}

export function clearInterceptCache(): void {
  cache = null;
}
