/**
 * skill-detector.mjs — Detect skill usage from Cursor transcript post-assembly.
 *
 * Strategy: After assembly completes, scan the transcript to find Read tool_use
 * entries targeting ~/.cursor/skills/<name>/SKILL.md paths within the matched turn.
 */

import fs from 'node:fs';

// Path pattern: /.cursor/skills/<skill-name>/SKILL.md (case-insensitive)
const SKILL_PATH_RE = /[/\\]\.cursor[/\\]skills[/\\]([\w-]+)[/\\]SKILL\.md/i;

/**
 * Detect skill usage from transcript for a specific turn.
 *
 * @param {string} transcriptPath - Path to the transcript JSONL file
 * @param {string} userPrompt - The user prompt text to match the correct turn
 * @returns {{ skillName: string, skillPath: string }[] | null}
 */
export function detectSkillFromTranscript(transcriptPath, userPrompt) {
  if (!transcriptPath || !userPrompt) return null;

  let content;
  try {
    content = fs.readFileSync(transcriptPath, 'utf-8');
  } catch (_e) {
    return null; // transcript file not accessible
  }

  const lines = content.trim().split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch (_e) { /* skip malformed */ }
  }

  if (entries.length === 0) return null;

  // Step 1: Find the user message that matches our prompt
  // The user prompt in transcript is wrapped in <user_query> tags and may have <timestamp>
  // Match strategy: normalize both sides and check inclusion
  const normalizedPrompt = normalizeForMatch(userPrompt);

  let matchedTurnStart = -1;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.role !== 'user') continue;
    const userText = extractUserText(e);
    if (userText && normalizeForMatch(userText).includes(normalizedPrompt)) {
      matchedTurnStart = i;
    }
  }

  if (matchedTurnStart < 0) return null;

  // Step 2: Scan assistant messages after matched user message until next turn_ended or next user message
  const skills = [];
  for (let i = matchedTurnStart + 1; i < entries.length; i++) {
    const e = entries[i];
    if (e.type === 'turn_ended' || e.role === 'user') break;

    if (e.role === 'assistant' && e.message?.content) {
      for (const block of e.message.content) {
        if (block.type === 'tool_use' && (block.name === 'Read' || block.name === 'ReadFile')) {
          const filePath = block.input?.path || '';
          const match = filePath.match(SKILL_PATH_RE);
          if (match) {
            skills.push({
              skillName: match[1],
              skillPath: filePath,
            });
          }
        }
      }
    }
  }

  return skills.length > 0 ? skills : null;
}

/**
 * Extract plain text from a user message entry.
 */
function extractUserText(entry) {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return '';
  const textParts = content.filter(b => b.type === 'text');
  return textParts.map(b => b.text || '').join('\n');
}

/**
 * Normalize text for fuzzy matching: strip tags, collapse whitespace, lowercase.
 */
function normalizeForMatch(text) {
  return text
    .replace(/<[^>]+>/g, '') // strip XML/HTML tags
    .replace(/\s+/g, ' ')    // collapse whitespace
    .trim()
    .toLowerCase();
}
