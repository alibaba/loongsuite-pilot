import * as fs from 'node:fs/promises';
import {
  applyEdits,
  modify,
  parse as parseJsonc,
  printParseErrorCode,
  type FormattingOptions,
  type JSONPath,
  type ParseError,
} from 'jsonc-parser';

export type JsonSyntax = 'json' | 'jsonc';

export type JsonDocumentReadResult<T> =
  | { status: 'ok'; data: T; raw: string }
  | { status: 'missing' }
  | { status: 'error'; error: Error };

export type JsonTextParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: Error };

/**
 * Parse a complete JSON/JSONC document without accepting partial recovery.
 * jsonc-parser is deliberately fault tolerant, so its error list must be
 * checked before the returned value can be trusted.
 */
export function parseJsonDocument<T>(
  raw: string,
  syntax: JsonSyntax = 'json',
): JsonTextParseResult<T> {
  if (syntax === 'json') {
    try {
      return { ok: true, data: JSON.parse(raw) as T };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }

  const errors: ParseError[] = [];
  const data = parseJsonc(raw, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as T;
  if (errors.length > 0) {
    const first = errors[0]!;
    return {
      ok: false,
      error: new SyntaxError(
        `invalid JSONC: ${printParseErrorCode(first.error)} at offset ${first.offset}`,
      ),
    };
  }
  return { ok: true, data };
}

/**
 * Keep missing files distinct from unreadable or invalid files. Callers may
 * create a missing file, but must never treat a parse failure as an empty one.
 */
export async function readJsonDocument<T>(
  filePath: string,
  syntax: JsonSyntax = 'json',
): Promise<JsonDocumentReadResult<T>> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'missing' };
    }
    return {
      status: 'error',
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  const parsed = parseJsonDocument<T>(raw, syntax);
  if (!parsed.ok) {
    return { status: 'error', error: parsed.error };
  }
  return { status: 'ok', data: parsed.data, raw };
}

export function detectJsonFormatting(raw: string): FormattingOptions {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const indent = raw.match(/(?:^|\r?\n)([ \t]+)(?=["}])/m)?.[1];
  if (indent?.includes('\t')) {
    return { insertSpaces: false, tabSize: 1, eol };
  }
  return {
    insertSpaces: true,
    tabSize: indent?.length || 2,
    eol,
  };
}

/**
 * Apply one path-level JSONC edit. Text outside the edited node is preserved,
 * including comments and original formatting.
 */
export function editJsonc(
  raw: string,
  jsonPath: JSONPath,
  value: unknown,
  options: { isArrayInsertion?: boolean } = {},
): string {
  const edits = modify(raw, jsonPath, value, {
    formattingOptions: detectJsonFormatting(raw),
    isArrayInsertion: options.isArrayInsertion,
  });
  return applyEdits(raw, edits);
}
