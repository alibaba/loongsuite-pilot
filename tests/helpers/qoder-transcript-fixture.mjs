// Test fixtures only; production collection uses the bounded native tailer.
import fs from 'node:fs';
import crypto from 'node:crypto';
export function readTranscriptSnapshot(transcriptPath, { includeContentHash = false } = {}) {
  try {
    if (!fs.existsSync(transcriptPath)) {
      return { lineCount: 0, rows: [], contentHash: '', reason: 'transcript-missing' };
    }
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const lines = content.split('\n');
    const lineCount = content.length > 0 && content[content.length - 1] !== '\n'
      ? lines.length
      : Math.max(0, lines.length - 1);
    const rows = new Array(lineCount);
    for (let i = 0; i < lineCount; i++) {
      const text = lines[i].trim();
      if (!text) continue;
      try { rows[i] = JSON.parse(text); } catch { /* skip malformed line */ }
    }
    const contentHash = includeContentHash
      ? crypto.createHash('sha1').update(content).digest('hex')
      : '';
    return { lineCount, rows, contentHash, reason: 'ok' };
  } catch {
    return { lineCount: 0, rows: [], contentHash: '', reason: 'read-failed' };
  }
}

