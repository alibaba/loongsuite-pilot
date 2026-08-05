/**
 * skill-detector.mjs — Detect skill usage from Cursor transcript post-assembly.
 *
 * Strategy: After assembly completes, match the transcript user row for the
 * current turn, then collect skills from either:
 * - Cursor's <manually_attached_skills> metadata on that user row; or
 * - A standalone <agent_skill fullPath="..."> usage signal; or
 * - Read tool_use entries targeting a recognized skills[-suffix] path.
 */

import fs from 'node:fs';

// Keep path semantics aligned with @loongsuite/otel-util-genai while requiring
// the path to end at the skill definition document. The stricter suffix avoids
// treating arbitrary files below an ordinary "skills" directory as usage.
const SKILL_DOCUMENT_PATH_RE =
  /(?:^|[/\\])skills(?:-[A-Za-z0-9][A-Za-z0-9_-]*)?[/\\](?:\.system[/\\])?([^/\\"'\s]+)[/\\]SKILL\.md$/i;
const MANUALLY_ATTACHED_SKILLS_RE =
  /<manually_attached_skills>([\s\S]*?)<\/manually_attached_skills>/i;
const ATTACHED_SKILL_HEADER_RE =
  /(?:^|\r?\n)Skill Name:\s*([^\r\n]+)\r?\nPath:\s*([^\r\n]+)\r?\nSKILL\.md content:\s*(?:\r?\n|$)/g;
const USER_QUERY_RE = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/i;
const AVAILABLE_SKILLS_RE =
  /<available_skills\b[^>]*>([\s\S]*?)<\/available_skills>/gi;
const AGENT_SKILL_RE =
  /<agent_skill\b([^>]*)>[\s\S]*?<\/agent_skill>/gi;
const AGENT_SKILL_FULL_PATH_RE =
  /\bfullPath\s*=\s*(?:"([^"]+)"|'([^']+)')/i;

/**
 * Detect skill usage from transcript for a specific turn.
 *
 * @param {string} transcriptPath - Path to the transcript JSONL file
 * @param {string} userPrompt - The user prompt text to match the correct turn
 * @returns {{
 *   skillName: string,
 *   skillPath: string,
 *   detectionSource: 'manual_attachment' | 'agent_skill' | 'transcript_read',
 *   detectionSources: ('manual_attachment' | 'agent_skill' | 'transcript_read')[]
 * }[] | null}
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

  // Step 1: Find the latest user message that matches our prompt. Prefer the
  // explicit <user_query> payload so inlined skill content cannot accidentally
  // satisfy the prompt match.
  const normalizedPrompt = normalizeForMatch(userPrompt);

  let matchedTurnStart = -1;
  let matchedUserText = '';
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.role !== 'user') continue;
    const userText = extractUserText(e);
    const userQuery = extractUserQuery(userText);
    const normalizedCandidate = normalizeForMatch(userQuery || userText);
    if (
      normalizedCandidate === normalizedPrompt ||
      (!userQuery && normalizedCandidate.includes(normalizedPrompt))
    ) {
      matchedTurnStart = i;
      matchedUserText = userText;
    }
  }

  if (matchedTurnStart < 0) return null;

  // Step 2: Cursor inlines explicitly attached skills into the matched user row.
  // This is the strongest per-turn signal and does not require a Read tool call.
  const detected = new Map();
  for (const skill of extractManuallyAttachedSkills(matchedUserText)) {
    addDetectedSkill(detected, skill, 'manual_attachment');
  }

  // Cursor also emits an <agent_skills><available_skills> catalog. Parse it for
  // compatibility, but only standalone <agent_skill> elements outside that
  // catalog are per-turn usage evidence.
  const agentSkills = extractAgentSkillsMetadata(matchedUserText);
  for (const skill of agentSkills.usedSkills) {
    addDetectedSkill(detected, skill, 'agent_skill');
  }

  // Step 4: Scan assistant messages after the matched user message until the
  // turn boundary for actual Read SKILL.md tool calls.
  for (let i = matchedTurnStart + 1; i < entries.length; i++) {
    const e = entries[i];
    if (e.type === 'turn_ended' || e.role === 'user') break;

    if (e.role === 'assistant' && e.message?.content) {
      for (const block of e.message.content) {
        if (block.type === 'tool_use' && (block.name === 'Read' || block.name === 'ReadFile')) {
          const filePath = block.input?.path || block.input?.file_path || '';
          const skill = parseSkillDocumentPath(filePath);
          if (skill) {
            addDetectedSkill(detected, skill, 'transcript_read');
          }
        }
      }
    }
  }

  return detected.size > 0 ? [...detected.values()] : null;
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

function extractUserQuery(userText) {
  if (!userText) return '';
  return userText.match(USER_QUERY_RE)?.[1]?.trim() || '';
}

/**
 * Parse only Cursor's generated attachment headers. The inlined SKILL.md body
 * is intentionally ignored and never returned to callers.
 */
export function extractManuallyAttachedSkills(userText) {
  if (!userText) return [];
  const container = userText.match(MANUALLY_ATTACHED_SKILLS_RE)?.[1];
  if (!container) return [];

  const skills = [];
  ATTACHED_SKILL_HEADER_RE.lastIndex = 0;
  for (const match of container.matchAll(ATTACHED_SKILL_HEADER_RE)) {
    const declaredName = match[1].trim();
    const skillPath = match[2].trim();
    const parsedPath = parseSkillDocumentPath(skillPath);
    if (!declaredName || !parsedPath) continue;
    skills.push({
      skillName: declaredName,
      skillPath,
    });
  }
  return skills;
}

/**
 * Parse Cursor's agent skill metadata without treating the available-skills
 * catalog as actual usage.
 *
 * @returns {{
 *   availableSkills: { skillName: string, skillPath: string }[],
 *   usedSkills: { skillName: string, skillPath: string }[]
 * }}
 */
export function extractAgentSkillsMetadata(userText) {
  if (!userText) return { availableSkills: [], usedSkills: [] };

  const availableSkills = [];
  AVAILABLE_SKILLS_RE.lastIndex = 0;
  const textWithoutCatalogs = userText.replace(
    AVAILABLE_SKILLS_RE,
    (_container, catalogBody) => {
      availableSkills.push(...extractAgentSkillElements(catalogBody));
      return '';
    },
  );

  return {
    availableSkills,
    usedSkills: extractAgentSkillElements(textWithoutCatalogs),
  };
}

function extractAgentSkillElements(text) {
  const skills = [];
  AGENT_SKILL_RE.lastIndex = 0;
  for (const match of text.matchAll(AGENT_SKILL_RE)) {
    const attributes = match[1] || '';
    const fullPathMatch = attributes.match(AGENT_SKILL_FULL_PATH_RE);
    const skillPath = (fullPathMatch?.[1] || fullPathMatch?.[2] || '').trim();
    const skill = parseSkillDocumentPath(skillPath);
    if (skill) skills.push(skill);
  }
  return skills;
}

export function parseSkillDocumentPath(filePath) {
  if (typeof filePath !== 'string') return null;
  const skillPath = filePath.trim();
  const match = skillPath.match(SKILL_DOCUMENT_PATH_RE);
  if (!match) return null;
  return {
    skillName: match[1],
    skillPath,
  };
}

function addDetectedSkill(detected, skill, source) {
  const key = `${skill.skillName.toLowerCase()}\0${skill.skillPath.toLowerCase()}`;
  const existing = detected.get(key);
  if (existing) {
    if (!existing.detectionSources.includes(source)) {
      existing.detectionSources.push(source);
    }
    if (source === 'manual_attachment') {
      existing.detectionSource = source;
    }
    return;
  }

  detected.set(key, {
    ...skill,
    detectionSource: source,
    detectionSources: [source],
  });
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
